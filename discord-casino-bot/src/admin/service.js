// Shared admin actions — the single implementation of every money/state mutation,
// called by BOTH the Discord interaction handlers (adminPanel.js / userPanel.js)
// and the web admin API (web/routes.js). Keep all balance-affecting logic here so
// the two front-ends can never diverge.
//
// Each function returns a plain result object ({ ok, error?, ... }); Discord-only
// side effects (replying to an interaction, editing a message embed) stay in the
// handlers. DMs and channel log posts happen here since they're front-end agnostic.
import { q } from '../db/index.js';
import { applyTx, logAudit } from '../repo.js';
import { fmt } from '../util/money.js';
import { logAuditMsg } from './logs.js';
import { cfg } from '../config.js';
import { invalidateAmountPreset } from '../util/amountPreset.js';

const VIP_NAMES = ['None', '🥉 Bronze', '🥈 Silver', '🥇 Gold', '💎 Platinum'];
export const VALID_PRESETS = new Set(['house', 'low', 'medium', 'high', 'extreme', 'prediction']);

async function dmUser(client, discordId, content) {
  try { const u = await client.users.fetch(discordId); await u.send(content); } catch {}
}

async function postHistory(client, content) {
  try {
    const id = cfg('CH_WITHDRAW_HISTORY');
    if (!id) return;
    const ch = await client.channels.fetch(id);
    await ch.send(content);
  } catch {}
}

// ─── Withdrawals ─────────────────────────────────────────────────────────

export async function approveWithdrawal({ wid, adminId }, client) {
  const { rows } = await q(`SELECT * FROM withdrawals WHERE id=$1`, [wid]);
  const w = rows[0];
  if (!w) return { ok: false, error: 'not_found' };
  if (w.status !== 'pending') return { ok: false, error: 'already_settled' };

  // burn the locked funds (paid out manually offline)
  await applyTx({
    userId: w.user_id, type: 'withdraw', amount: -BigInt(w.amount), lockDelta: -BigInt(w.amount),
    ref: w.id, meta: { method: w.upi_id ? 'upi' : 'bank' },
  });
  await q(`UPDATE withdrawals SET status='paid', admin_id=$1, settled_at=now() WHERE id=$2`, [adminId, wid]);
  await logAudit(adminId, 'withdraw_approved', wid, null, { amount: w.amount });

  await postHistory(client, `✅ Approved withdraw **${fmt(BigInt(w.amount))}** by <@${adminId}>`);
  const discordRow = (await q(`SELECT discord_id FROM users WHERE id=$1`, [w.user_id])).rows[0];
  if (discordRow) await dmUser(client, discordRow.discord_id, `✅ Your withdraw of ${fmt(BigInt(w.amount))} has been approved and paid out.`);
  return { ok: true, w };
}

export async function rejectWithdrawal({ wid, adminId, note }, client) {
  const { rows } = await q(`SELECT * FROM withdrawals WHERE id=$1`, [wid]);
  const w = rows[0];
  if (!w) return { ok: false, error: 'not_found' };
  if (w.status !== 'pending') return { ok: false, error: 'already_settled' };

  // refund: release lock back to available
  await applyTx({ userId: w.user_id, type: 'refund', amount: 0n,
    lockDelta: -BigInt(w.amount), ref: w.id, meta: { kind: 'withdraw_reject', note } });
  await q(`UPDATE withdrawals SET status='rejected', admin_id=$1, admin_note=$2, settled_at=now() WHERE id=$3`,
    [adminId, note, wid]);
  await logAudit(adminId, 'withdraw_rejected', wid, null, { amount: w.amount, note });

  await postHistory(client, `❌ Rejected withdraw **${fmt(BigInt(w.amount))}** by <@${adminId}> — ${note}`);
  const discordRow = (await q(`SELECT discord_id FROM users WHERE id=$1`, [w.user_id])).rows[0];
  if (discordRow) await dmUser(client, discordRow.discord_id, `❌ Your withdraw was rejected: ${note}\nFunds returned to wallet.`);
  return { ok: true, w };
}

// ─── User balance ──────────────────────────────────────────────────────

export async function creditUser({ userId, amountPaise, reason, adminId }, client) {
  const paise = BigInt(amountPaise);
  if (paise <= 0n) return { ok: false, error: 'invalid_amount' };
  await applyTx({ userId, type: 'adjust', amount: paise, ref: null, meta: { reason, admin: adminId } });
  await logAudit(adminId, 'admin_credit', userId, null, { amount: paise.toString(), reason });
  logAuditMsg(client, `💸 Admin **credit** **${fmt(paise)}** to user \`${userId}\` by <@${adminId}> — ${reason}`);
  return { ok: true, amount: paise.toString() };
}

export async function debitUser({ userId, amountPaise, reason, adminId }, client) {
  const paise = BigInt(amountPaise);
  if (paise <= 0n) return { ok: false, error: 'invalid_amount' };
  try {
    await applyTx({ userId, type: 'adjust', amount: -paise, ref: null, meta: { reason, admin: adminId } });
  } catch {
    return { ok: false, error: 'insufficient_balance' };
  }
  await logAudit(adminId, 'admin_debit', userId, null, { amount: paise.toString(), reason });
  logAuditMsg(client, `📤 Admin **debit** **${fmt(paise)}** from user \`${userId}\` by <@${adminId}> — ${reason}`);
  return { ok: true, amount: paise.toString() };
}

// ─── Ban / VIP / preset / cooldown ─────────────────────────────────────

export async function toggleBan({ userId, adminId }, client) {
  const { rows } = await q(`SELECT status, discord_id FROM users WHERE id=$1`, [userId]);
  if (!rows[0]) return { ok: false, error: 'not_found' };
  const newStatus = rows[0].status === 'banned' ? 'active' : 'banned';
  await q(`UPDATE users SET status=$1 WHERE id=$2`, [newStatus, userId]);
  await logAudit(adminId, newStatus === 'banned' ? 'admin_ban' : 'admin_unban', userId,
    { status: rows[0].status }, { status: newStatus });
  logAuditMsg(client, `${newStatus === 'banned' ? '🚫 **Banned**' : '✅ **Unbanned**'} user \`${userId}\` (<@${rows[0].discord_id}>) by <@${adminId}>`);
  await dmUser(client, rows[0].discord_id, newStatus === 'banned'
    ? '🚫 Your account has been suspended. Contact support if you believe this is a mistake.'
    : '✅ Your account has been reinstated. You may now play again.');
  return { ok: true, status: newStatus };
}

export async function setVip({ userId, tier, adminId }, client) {
  const t = Math.min(4, Math.max(0, Math.floor(Number(tier))));
  await q(`UPDATE users SET vip_tier=$1 WHERE id=$2`, [t, userId]);
  await logAudit(adminId, 'admin_set_vip', userId, null, { vip_tier: t });
  logAuditMsg(client, `⭐ VIP tier for user \`${userId}\` set to **${VIP_NAMES[t]}** by <@${adminId}>`);
  return { ok: true, tier: t, label: VIP_NAMES[t] };
}

// preset === 'clear' removes the override (use game default)
export async function setUserPreset({ userId, preset, adminId }, client) {
  const isClear = preset === 'clear' || !preset;
  if (!isClear && !VALID_PRESETS.has(preset)) return { ok: false, error: 'invalid_preset' };
  await q(`UPDATE users SET user_preset=$1 WHERE id=$2`, [isClear ? null : preset, userId]);
  const { rows } = await q(`SELECT username FROM users WHERE id=$1`, [userId]);
  await logAudit(adminId, 'admin_set_user_preset', userId, null, { preset: isClear ? null : preset });
  logAuditMsg(client, `🎯 User preset for **${rows[0]?.username}** set to **${isClear ? 'cleared' : preset}** by <@${adminId}>`);
  return { ok: true, preset: isClear ? null : preset, username: rows[0]?.username };
}

// hours: number (0 = no cooldown) or null (revert to global default)
export async function setCooldown({ userId, hours, adminId }, client) {
  const { rows } = await q(`SELECT username FROM users WHERE id=$1`, [userId]);
  if (!rows[0]) return { ok: false, error: 'not_found' };
  if (hours === null || hours === undefined || hours === '') {
    await q(`UPDATE users SET withdraw_cooldown_hours=NULL WHERE id=$1`, [userId]);
    await logAudit(adminId, 'admin_cooldown_override', userId, null, { hours: null });
    logAuditMsg(client, `⏱️ Withdraw cooldown for **${rows[0].username}** reset to global default by <@${adminId}>`);
    return { ok: true, hours: null, username: rows[0].username };
  }
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) return { ok: false, error: 'invalid_hours' };
  await q(`UPDATE users SET withdraw_cooldown_hours=$1 WHERE id=$2`, [h, userId]);
  await logAudit(adminId, 'admin_cooldown_override', userId, null, { hours: h });
  logAuditMsg(client, `⏱️ Withdraw cooldown for **${rows[0].username}** set to **${h}h** by <@${adminId}>`);
  return { ok: true, hours: h, username: rows[0].username };
}

export async function resetCooldown({ userId, adminId }, client) {
  const { rows } = await q(`SELECT username FROM users WHERE id=$1`, [userId]);
  if (!rows[0]) return { ok: false, error: 'not_found' };
  await q(`UPDATE users SET withdraw_cooldown_until=NULL WHERE id=$1`, [userId]);
  await logAudit(adminId, 'admin_reset_cooldown', userId, null, {});
  logAuditMsg(client, `🔓 Active withdraw cooldown cleared for **${rows[0].username}** by <@${adminId}>`);
  return { ok: true, username: rows[0].username };
}

// ─── Presets ────────────────────────────────────────────────────────────

export async function setPreset({ scope, mode, adminId }, client) {
  if (!VALID_PRESETS.has(mode)) return { ok: false, error: 'invalid_mode' };
  const { rows: prev } = await q(`SELECT mode FROM presets WHERE scope=$1`, [scope]);
  await q(
    `INSERT INTO presets(scope,mode,updated_by) VALUES($1,$2,$3)
     ON CONFLICT(scope) DO UPDATE SET mode=EXCLUDED.mode, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [scope, mode, adminId]
  );
  await q(`INSERT INTO preset_history(scope,old_mode,new_mode,changed_by) VALUES($1,$2,$3,$4)`,
    [scope, prev[0]?.mode || null, mode, adminId]);
  await logAudit(adminId, 'preset_change', scope, prev[0] || null, { mode });
  logAuditMsg(client, `Preset **${scope}** → **${mode}** by <@${adminId}>`);
  return { ok: true, scope, mode };
}

export async function setAmountLimit({ tier, preset, amountRupees, adminId }, client) {
  if (!VALID_PRESETS.has(preset)) return { ok: false, error: 'invalid_preset' };
  if (tier === 'medium') {
    await q(`UPDATE amount_preset_config SET medium_preset=$1, updated_by=$2, updated_at=now() WHERE id=1`, [preset, adminId]);
    logAuditMsg(client, `💵 Amount preset Medium → **${preset}** by <@${adminId}>`);
  } else if (tier === 'hard') {
    const rs = Number(amountRupees);
    if (!Number.isFinite(rs) || rs <= 0) return { ok: false, error: 'invalid_amount' };
    const paise = Math.round(rs * 100);
    await q(`UPDATE amount_preset_config SET hard_min=$1, hard_preset=$2, updated_by=$3, updated_at=now() WHERE id=1`, [paise, preset, adminId]);
    logAuditMsg(client, `💵 Amount preset Hard (> ₹${rs}) → **${preset}** by <@${adminId}>`);
  } else {
    return { ok: false, error: 'invalid_tier' };
  }
  invalidateAmountPreset();
  return { ok: true };
}

export async function toggleAmountPresets({ adminId }, client) {
  const { rows } = await q(`UPDATE amount_preset_config SET enabled = NOT enabled, updated_by=$1, updated_at=now() WHERE id=1 RETURNING enabled`, [adminId]);
  const enabled = rows[0]?.enabled ?? false;
  invalidateAmountPreset();
  logAuditMsg(client, `💵 Amount-based presets toggled **${enabled ? 'ON ✅' : 'OFF ❌'}** by <@${adminId}>`);
  return { ok: true, enabled };
}

// ─── Promo codes ─────────────────────────────────────────────────────────

export async function createPromo({ code, amountRupees, wager, maxuses, expiryDays, adminId }) {
  const c = String(code || '').trim().toUpperCase();
  const amount = Number(amountRupees);
  const w = Math.max(1, Math.floor(Number(wager) || 5));
  const mx = Math.max(1, Math.floor(Number(maxuses) || 100));
  const expiresAt = expiryDays ? new Date(Date.now() + Number(expiryDays) * 86400_000) : null;
  if (!c || !Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'invalid' };

  const bonus = BigInt(Math.round(amount * 100));
  try {
    await q(
      `INSERT INTO promo_codes(code, bonus_amount, wager_mult, max_uses, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [c, String(bonus), w, mx, expiresAt, String(adminId)]
    );
  } catch (e) {
    if (e.message.includes('unique')) return { ok: false, error: 'duplicate' };
    throw e;
  }
  await logAudit(adminId, 'promo_created', c, null, { bonus: String(bonus), wager: w, maxuses: mx }).catch(() => {});
  return { ok: true, code: c, bonus: String(bonus), wager: w, maxuses: mx, expiresAt };
}

export async function deactivatePromo({ promoId, adminId }) {
  await q(`UPDATE promo_codes SET active=FALSE WHERE id=$1`, [promoId]);
  await logAudit(adminId, 'promo_deactivated', promoId, null, {});
  return { ok: true };
}
