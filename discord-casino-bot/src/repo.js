import { q, withTx } from './db/index.js';

export async function upsertUser(discordId, username, meta = {}) {
  const { rows } = await q(
    `INSERT INTO users(discord_id, username, ip_hash, device_fp)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING *`,
    [discordId, username, meta.ip_hash || null, meta.device_fp || null]
  );
  const u = rows[0];
  await q(`INSERT INTO wallets(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [u.id]);
  return u;
}

export async function getUserByDiscord(discordId) {
  const { rows } = await q(`SELECT * FROM users WHERE discord_id=$1`, [discordId]);
  return rows[0] || null;
}

export async function getWallet(userId) {
  const { rows } = await q(`SELECT * FROM wallets WHERE user_id=$1`, [userId]);
  return rows[0];
}

export async function applyTx({ userId, type, amount, lockDelta = 0n, ref = null, meta = {} }) {
  await q(
    `SELECT apply_transaction($1,$2,$3,$4,$5,$6)`,
    [userId, type, amount.toString(), lockDelta.toString(), ref, meta]
  );
  return getWallet(userId);
}

export async function getPreset(scope) {
  const { rows } = await q(
    `SELECT mode FROM presets WHERE scope=$1`, [scope]
  );
  if (rows[0]) return rows[0].mode;
  const { rows: g } = await q(`SELECT mode FROM presets WHERE scope='global'`);
  return g[0]?.mode || 'house';
}

// Per-user preset overrides the game/amount preset when set.
// Games should call this instead of getPreset directly.
export async function getUserPreset(userId, game) {
  const { rows } = await q(`SELECT user_preset FROM users WHERE id = $1`, [userId]);
  if (rows[0]?.user_preset) return rows[0].user_preset;
  return null; // caller falls back to amount preset or getPreset
}

export async function logAudit(actor, action, target, before, after) {
  await q(
    `INSERT INTO audit_log(actor,action,target,before,after) VALUES ($1,$2,$3,$4,$5)`,
    [actor, action, target, before, after]
  );
}

export async function logFraud(userId, type, severity, details) {
  await q(
    `INSERT INTO fraud_signals(user_id,signal_type,severity,details) VALUES ($1,$2,$3,$4)`,
    [userId, type, severity, details]
  );
}

// Throws if the user is banned or flagged.
export async function requireActive(discordId, username) {
  const u = await upsertUser(discordId, username);
  if (u.status === 'banned')  throw Object.assign(new Error('BANNED'),  { code: 'BANNED' });
  if (u.status === 'flagged') throw Object.assign(new Error('FLAGGED'), { code: 'FLAGGED' });
  return u;
}

// ─── Persistent game sessions (mines / blackjack) ────────────────────

export async function loadSession(discordId, game) {
  const { rows } = await q(
    `SELECT gs.data, gs.bet_id FROM game_sessions gs
     JOIN users u ON u.id = gs.user_id
     WHERE u.discord_id=$1 AND gs.game=$2`,
    [discordId, game]
  );
  return rows[0] || null;
}

export async function saveSession(userId, game, data, betId) {
  await q(
    `INSERT INTO game_sessions(user_id,game,data,bet_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(user_id,game) DO UPDATE SET data=EXCLUDED.data, bet_id=EXCLUDED.bet_id`,
    [userId, game, JSON.parse(JSON.stringify(data, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v)), betId]
  );
}

export async function deleteSession(userId, game) {
  await q(`DELETE FROM game_sessions WHERE user_id=$1 AND game=$2`, [userId, game]);
}

// ─── Referrals ───────────────────────────────────────────────────────

const REFERRAL_BONUS = 5000n; // ₹50 per referral

export async function applyReferralCode(userId, code) {
  const { rows } = await q(
    `SELECT id FROM users WHERE upper(referral_code)=upper($1) AND id != $2`,
    [code, userId]
  );
  if (!rows[0]) return false;
  const { rowCount } = await q(
    `UPDATE users SET referred_by=$1 WHERE id=$2 AND referred_by IS NULL`,
    [rows[0].id, userId]
  );
  return rowCount > 0;
}

export async function creditReferralBonus(referrerId, refereeId) {
  const { rowCount } = await q(
    `INSERT INTO referral_bonuses(referrer_id,referee_id,amount) VALUES($1,$2,$3)
     ON CONFLICT(referee_id) DO NOTHING`,
    [referrerId, refereeId, REFERRAL_BONUS.toString()]
  );
  if (!rowCount) return;
  // Referral bonus carries a 1× wagering requirement
  await creditBonus(referrerId, REFERRAL_BONUS, 1);
}

// ─── Bonus with wagering requirement ─────────────────────────────────
// wagerMult=0 means no restriction (e.g. daily reward)
export async function creditBonus(userId, amount, wagerMult = 5) {
  await applyTx({ userId, type: 'bonus', amount, ref: null, meta: { kind: 'bonus', wagerMult } });
  if (wagerMult > 0) {
    await q(
      `UPDATE wallets SET
         bonus_balance = bonus_balance + $2,
         wager_pending = wager_pending + $3
       WHERE user_id = $1`,
      [userId, amount.toString(), (amount * BigInt(wagerMult)).toString()]
    );
  }
}

// ─── Promo codes ─────────────────────────────────────────────────────

export async function redeemPromoCode(userId, code) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM promo_codes WHERE upper(code) = upper($1) FOR UPDATE`,
      [code]
    );
    if (!rows[0])                              return { error: 'invalid' };
    const p = rows[0];
    if (!p.active || p.uses_count >= p.max_uses) return { error: 'expired' };
    if (p.expires_at && new Date(p.expires_at) < new Date()) return { error: 'expired' };

    const { rows: used } = await client.query(
      `SELECT 1 FROM promo_uses WHERE promo_id = $1 AND user_id = $2`,
      [p.id, userId]
    );
    if (used.length) return { error: 'already_used' };

    await client.query(
      `UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id = $1`, [p.id]
    );
    await client.query(
      `INSERT INTO promo_uses(promo_id, user_id) VALUES ($1, $2)`, [p.id, userId]
    );
    return { promo: p };
  });
}
