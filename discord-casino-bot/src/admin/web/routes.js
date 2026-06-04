// JSON API for the web admin panel. Every route is mounted behind requireAdmin.
// All money-affecting actions delegate to ../service.js (shared with Discord).
// Amounts are returned as strings (paise are BigInt); the UI formats to ₹.
import express from 'express';
import { q } from '../../db/index.js';
import * as svc from '../service.js';
import {
  cfg, dbValue, setSetting,
  CHANNEL_KEYS, CONFIG_KEYS,
} from '../../config.js';
import { postStaticPanels } from '../../panels.js';
import { togglePrediction, getPredictionState } from '../../games/matka.js';
import { slotsForced, SYMBOLS } from '../../games/slots.js';
import { logAuditMsg } from '../logs.js';

const toPaise = (rupees) => BigInt(Math.round(Number(rupees) * 100));

export function adminApiRouter(client) {
  const r = express.Router();
  const actor = (req) => req.admin?.id || 'web-admin';

  // ─── Settings (channel IDs + economy config) ──────────────────────────
  r.get('/settings', (req, res) => {
    const shape = (defs) => defs.map(d => ({
      ...d,
      value: cfg(d.key) || '',
      source: dbValue(d.key) != null && dbValue(d.key) !== '' ? 'db' : 'env',
    }));
    res.json({ channels: shape(CHANNEL_KEYS), config: shape(CONFIG_KEYS) });
  });

  r.put('/settings', async (req, res) => {
    const values = req.body?.values || {};
    const allowed = new Set([...CHANNEL_KEYS, ...CONFIG_KEYS].map(d => d.key));
    const saved = [];
    for (const [key, value] of Object.entries(values)) {
      if (!allowed.has(key)) continue;
      await setSetting(key, value, actor(req));
      saved.push(key);
    }
    res.json({ ok: true, saved });
  });

  r.post('/settings/resync-panels', async (_req, res) => {
    try { await postStaticPanels(client); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  r.post('/settings/restart', (_req, res) => {
    res.json({ ok: true, restarting: true });
    setTimeout(() => process.exit(0), 500); // Railway/Docker restarts the container
  });

  // ─── Dashboard ────────────────────────────────────────────────────────
  r.get('/kpis', async (_req, res) => {
    const { rows: [k] } = await q(`SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE created_at > now() - interval '24 hours') AS new_users,
      (SELECT COALESCE(SUM(amount),0)  FROM transactions WHERE type='deposit'  AND created_at > now() - interval '24 hours') AS dep24,
      (SELECT COALESCE(SUM(-amount),0) FROM transactions WHERE type='withdraw' AND created_at > now() - interval '24 hours') AS wd24,
      (SELECT COALESCE(SUM(stake::bigint - payout::bigint),0) FROM bets WHERE settled_at > now() - interval '24 hours') AS ggr24,
      (SELECT COUNT(*) FROM withdrawals WHERE status='pending') AS pending_wd,
      (SELECT COUNT(*) FROM game_sessions) AS live_sessions
    `);
    res.json({
      users: Number(k.users), new_users: Number(k.new_users),
      dep24: String(k.dep24), wd24: String(k.wd24), ggr24: String(k.ggr24),
      pending_wd: Number(k.pending_wd), live_sessions: Number(k.live_sessions),
    });
  });

  r.get('/audit', async (_req, res) => {
    const { rows } = await q(`SELECT actor, action, target, after, created_at FROM audit_log ORDER BY created_at DESC LIMIT 50`);
    res.json(rows);
  });

  // ─── Users ────────────────────────────────────────────────────────────
  r.get('/users', async (req, res) => {
    const search = (req.query.search || '').toString().trim();
    const limit  = Math.min(100, Number(req.query.limit) || 50);
    const offset = Number(req.query.offset) || 0;
    const where = search ? `WHERE u.discord_id ILIKE $1 OR u.username ILIKE $1` : '';
    const params = search ? [`%${search}%`, limit, offset] : [limit, offset];
    const { rows } = await q(
      `SELECT u.id, u.discord_id, u.username, u.status, u.vip_tier, u.created_at,
              w.available, w.locked
       FROM users u JOIN wallets w ON w.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
      params);
    res.json(rows.map(u => ({ ...u, available: String(u.available), locked: String(u.locked) })));
  });

  r.get('/users/:discordId', async (req, res) => {
    const { rows } = await q(
      `SELECT u.*, w.available, w.locked, w.total_wagered, w.total_deposited,
              w.total_withdrawn, w.bonus_balance, w.wager_pending
       FROM users u JOIN wallets w ON w.user_id = u.id
       WHERE u.discord_id = $1`, [req.params.discordId]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const u = rows[0];
    const { rows: [stats] } = await q(
      `SELECT COUNT(*) c, COALESCE(SUM(payout::bigint - stake::bigint),0) net
       FROM bets WHERE user_id=$1 AND result!='pending'`, [u.id]);
    const big = (v) => String(v ?? 0);
    res.json({
      id: u.id, discord_id: u.discord_id, username: u.username, status: u.status,
      vip_tier: u.vip_tier, user_preset: u.user_preset, admin_notes: u.admin_notes || '', created_at: u.created_at,
      withdraw_cooldown_until: u.withdraw_cooldown_until, withdraw_cooldown_hours: u.withdraw_cooldown_hours,
      available: big(u.available), locked: big(u.locked), bonus_balance: big(u.bonus_balance),
      wager_pending: big(u.wager_pending), total_deposited: big(u.total_deposited),
      total_withdrawn: big(u.total_withdrawn), total_wagered: big(u.total_wagered),
      bets: Number(stats.c), net: big(stats.net),
    });
  });

  r.get('/users/:userId/bets', async (req, res) => {
    const page = Number(req.query.page) || 0;
    const PAGE = 20;
    const { rows } = await q(
      `SELECT game, stake, payout, result, settled_at FROM bets
       WHERE user_id=$1 AND result!='pending'
       ORDER BY settled_at DESC LIMIT $2 OFFSET $3`,
      [req.params.userId, PAGE + 1, page * PAGE]);
    const hasNext = rows.length > PAGE;
    res.json({ hasNext, page, bets: rows.slice(0, PAGE).map(b => ({
      ...b, stake: String(b.stake), payout: String(b.payout ?? 0) })) });
  });

  r.post('/users/:userId/credit', async (req, res) => {
    const { amountRupees, reason } = req.body || {};
    if (!Number.isFinite(Number(amountRupees)) || Number(amountRupees) <= 0) return res.status(400).json({ error: 'invalid_amount' });
    const out = await svc.creditUser({ userId: req.params.userId, amountPaise: toPaise(amountRupees), reason: reason || 'web admin', adminId: actor(req) }, client);
    res.json(out);
  });

  r.post('/users/:userId/debit', async (req, res) => {
    const { amountRupees, reason } = req.body || {};
    if (!Number.isFinite(Number(amountRupees)) || Number(amountRupees) <= 0) return res.status(400).json({ error: 'invalid_amount' });
    const out = await svc.debitUser({ userId: req.params.userId, amountPaise: toPaise(amountRupees), reason: reason || 'web admin', adminId: actor(req) }, client);
    res.status(out.ok ? 200 : 400).json(out);
  });

  r.post('/users/:userId/ban', async (req, res) => {
    res.json(await svc.toggleBan({ userId: req.params.userId, adminId: actor(req) }, client));
  });
  r.post('/users/:userId/vip', async (req, res) => {
    res.json(await svc.setVip({ userId: req.params.userId, tier: req.body?.tier, adminId: actor(req) }, client));
  });
  r.post('/users/:userId/preset', async (req, res) => {
    const out = await svc.setUserPreset({ userId: req.params.userId, preset: req.body?.preset, adminId: actor(req) }, client);
    res.status(out.ok ? 200 : 400).json(out);
  });
  r.post('/users/:userId/cooldown', async (req, res) => {
    const out = await svc.setCooldown({ userId: req.params.userId, hours: req.body?.hours ?? null, adminId: actor(req) }, client);
    res.status(out.ok ? 200 : 400).json(out);
  });
  r.post('/users/:userId/reset-cooldown', async (req, res) => {
    res.json(await svc.resetCooldown({ userId: req.params.userId, adminId: actor(req) }, client));
  });

  // ─── Withdrawals ──────────────────────────────────────────────────────
  r.get('/withdrawals', async (req, res) => {
    const status = (req.query.status || 'pending').toString();
    const { rows } = await q(
      `SELECT w.id, w.amount, w.upi_id, w.bank_details, w.status, w.created_at, w.admin_note,
              u.discord_id, u.username
       FROM withdrawals w JOIN users u ON u.id = w.user_id
       WHERE w.status = $1 ORDER BY w.created_at DESC LIMIT 100`, [status]);
    res.json(rows.map(w => ({ ...w, amount: String(w.amount) })));
  });
  r.post('/withdrawals/:id/approve', async (req, res) => {
    const out = await svc.approveWithdrawal({ wid: req.params.id, adminId: actor(req) }, client);
    res.status(out.ok ? 200 : 400).json({ ok: out.ok, error: out.error });
  });
  r.post('/withdrawals/:id/reject', async (req, res) => {
    const note = (req.body?.note || '').toString().trim() || 'Rejected by admin';
    const out = await svc.rejectWithdrawal({ wid: req.params.id, adminId: actor(req), note }, client);
    res.status(out.ok ? 200 : 400).json({ ok: out.ok, error: out.error });
  });

  // ─── Deposits / transactions ──────────────────────────────────────────
  r.get('/deposits', async (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const { rows } = await q(
      `SELECT d.id, d.cashfree_order_id, d.amount, d.status, d.created_at, d.credited_at,
              u.discord_id, u.username
       FROM deposits d LEFT JOIN users u ON u.id = d.user_id
       ORDER BY d.created_at DESC LIMIT $1`, [limit]);
    res.json(rows.map(d => ({ ...d, amount: String(d.amount) })));
  });

  r.get('/transactions', async (req, res) => {
    const userId = req.query.userId?.toString();
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const params = userId ? [userId, limit] : [limit];
    const { rows } = await q(
      `SELECT id, user_id, type, amount, balance_after, status, ref, created_at
       FROM transactions ${userId ? 'WHERE user_id=$1' : ''}
       ORDER BY created_at DESC LIMIT $${userId ? 2 : 1}`, params);
    res.json(rows.map(t => ({ ...t, amount: String(t.amount), balance_after: String(t.balance_after ?? 0) })));
  });

  // ─── Presets ──────────────────────────────────────────────────────────
  r.get('/presets', async (_req, res) => {
    const { rows: presets } = await q(`SELECT scope, mode, updated_at FROM presets ORDER BY scope`);
    const { rows: amt } = await q(`SELECT * FROM amount_preset_config WHERE id=1`);
    res.json({ presets, amountLimits: amt[0] || null, predictionEnabled: getPredictionState?.() ?? null });
  });
  r.put('/presets', async (req, res) => {
    const out = await svc.setPreset({ scope: req.body?.scope, mode: req.body?.mode, adminId: actor(req) }, client);
    res.status(out.ok ? 200 : 400).json(out);
  });
  r.put('/amount-limits', async (req, res) => {
    const out = await svc.setAmountLimit({ tier: req.body?.tier, preset: req.body?.preset, amountRupees: req.body?.amountRupees, adminId: actor(req) }, client);
    res.status(out.ok ? 200 : 400).json(out);
  });
  r.post('/amount-limits/toggle', async (req, res) => {
    res.json(await svc.toggleAmountPresets({ adminId: actor(req) }, client));
  });
  r.post('/prediction/toggle', async (_req, res) => {
    const enabled = togglePrediction();
    res.json({ ok: true, enabled });
  });

  // ─── Promos ───────────────────────────────────────────────────────────
  r.get('/promos', async (_req, res) => {
    const { rows } = await q(`SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 50`);
    res.json(rows.map(p => ({ ...p, bonus_amount: String(p.bonus_amount) })));
  });
  r.post('/promos', async (req, res) => {
    const out = await svc.createPromo({
      code: req.body?.code, amountRupees: req.body?.amountRupees, wager: req.body?.wager,
      maxuses: req.body?.maxuses, expiryDays: req.body?.expiryDays, adminId: actor(req),
    });
    res.status(out.ok ? 200 : 400).json(out);
  });
  r.delete('/promos/:id', async (req, res) => {
    res.json(await svc.deactivatePromo({ promoId: req.params.id, adminId: actor(req) }));
  });

  // ─── Discord channel list (for the channel-picker dropdowns) ──────────
  r.get('/discord/channels', (_req, res) => {
    const TEXT_TYPES = new Set([0, 5]); // GuildText, GuildAnnouncement
    const out = [];
    const collect = (guildId, tag) => {
      const g = guildId && client.guilds.cache.get(guildId);
      if (!g) return;
      for (const ch of g.channels.cache.values())
        if (TEXT_TYPES.has(ch.type)) out.push({ id: ch.id, name: ch.name, guild: tag });
    };
    collect(process.env.MAIN_GUILD_ID, 'main');
    collect(process.env.ADMIN_GUILD_ID, 'admin');
    out.sort((a, b) => a.guild.localeCompare(b.guild) || a.name.localeCompare(b.name));
    res.json(out);
  });

  // ─── Announcements ────────────────────────────────────────────────────
  r.post('/announce', async (req, res) => {
    const target = (req.body?.target || '').toString();
    const message = (req.body?.message || '').toString().trim();
    if (!message) return res.status(400).json({ error: 'empty_message' });

    if (target === 'all-dm') {
      const { rows } = await q(`SELECT discord_id FROM users WHERE discord_id IS NOT NULL`);
      res.json({ ok: true, queued: rows.length }); // respond immediately
      let sent = 0;
      for (const u of rows) {
        try { const du = await client.users.fetch(u.discord_id); await du.send(message); sent++; }
        catch {}
        await new Promise(r2 => setTimeout(r2, 50)); // ~20/sec throttle
      }
      logAuditMsg(client, `📣 Broadcast DM by <@${actor(req)}> reached ${sent}/${rows.length} users`);
      return;
    }

    try {
      const ch = await client.channels.fetch(target);
      await ch.send(message);
      logAuditMsg(client, `📣 Announcement posted to <#${target}> by <@${actor(req)}>`);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ─── Analytics (charts) ───────────────────────────────────────────────
  r.get('/analytics', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const span = `${days} days`;
    const [money, ggr, users, top, wins] = await Promise.all([
      q(`SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') d,
            COALESCE(SUM(CASE WHEN type='deposit' THEN amount END),0) dep,
            COALESCE(SUM(CASE WHEN type='withdraw' THEN -amount END),0) wd
         FROM transactions WHERE created_at > now() - $1::interval GROUP BY 1 ORDER BY 1`, [span]),
      q(`SELECT to_char(date_trunc('day', settled_at),'YYYY-MM-DD') d,
            COALESCE(SUM(stake::bigint - payout::bigint),0) ggr
         FROM bets WHERE settled_at > now() - $1::interval GROUP BY 1 ORDER BY 1`, [span]),
      q(`SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') d, COUNT(*) n
         FROM users WHERE created_at > now() - $1::interval GROUP BY 1 ORDER BY 1`, [span]),
      q(`SELECT u.username, u.discord_id, w.total_wagered
         FROM wallets w JOIN users u ON u.id=w.user_id ORDER BY w.total_wagered DESC LIMIT 10`),
      q(`SELECT u.username, b.game, (b.payout::bigint - b.stake::bigint) net, b.settled_at
         FROM bets b JOIN users u ON u.id=b.user_id WHERE b.result='win' ORDER BY net DESC LIMIT 10`),
    ]);
    res.json({
      money: money.rows.map(r2 => ({ d: r2.d, dep: String(r2.dep), wd: String(r2.wd) })),
      ggr: ggr.rows.map(r2 => ({ d: r2.d, ggr: String(r2.ggr) })),
      newUsers: users.rows.map(r2 => ({ d: r2.d, n: Number(r2.n) })),
      topPlayers: top.rows.map(r2 => ({ ...r2, total_wagered: String(r2.total_wagered) })),
      biggestWins: wins.rows.map(r2 => ({ ...r2, net: String(r2.net) })),
    });
  });

  // ─── Maintenance mode ─────────────────────────────────────────────────
  r.post('/maintenance/toggle', async (req, res) => {
    const next = cfg('MAINTENANCE_MODE') === 'true' ? 'false' : 'true';
    await setSetting('MAINTENANCE_MODE', next, actor(req));
    logAuditMsg(client, `🚧 Maintenance mode **${next === 'true' ? 'ON' : 'OFF'}** by <@${actor(req)}>`);
    res.json({ ok: true, enabled: next === 'true' });
  });
  r.get('/maintenance', (_req, res) => res.json({ enabled: cfg('MAINTENANCE_MODE') === 'true' }));

  // ─── Game outcome control (slots forced map, in-memory) ───────────────
  r.get('/slots-overrides', (_req, res) => {
    res.json([...slotsForced.entries()].map(([discordId, v]) =>
      v.type === 'symbol'
        ? { discordId, mode: 'symbol', symbol: v.symbol.s, pay: v.symbol.pay }
        : { discordId, mode: v.type, remaining: v.remaining }));
  });
  r.post('/slots-overrides', (req, res) => {
    const { discordId, mode, count, symbolIndex } = req.body || {};
    if (!discordId) return res.status(400).json({ error: 'missing_user' });
    if (mode === 'symbol') {
      const sym = SYMBOLS[Number(symbolIndex)];
      if (!sym) return res.status(400).json({ error: 'invalid_symbol' });
      slotsForced.set(String(discordId), { type: 'symbol', symbol: sym });
    } else if (mode === 'win' || mode === 'lose') {
      const c = Math.min(20, Math.max(1, Math.floor(Number(count) || 1)));
      slotsForced.set(String(discordId), { type: mode, remaining: c });
    } else {
      return res.status(400).json({ error: 'invalid_mode' });
    }
    logAuditMsg(client, `🎯 Slots override for <@${discordId}> set to **${mode}** by <@${actor(req)}>`);
    res.json({ ok: true });
  });
  r.delete('/slots-overrides/:discordId', (req, res) => {
    slotsForced.delete(req.params.discordId);
    logAuditMsg(client, `🧹 Slots override cleared for <@${req.params.discordId}> by <@${actor(req)}>`);
    res.json({ ok: true });
  });
  r.get('/symbols', (_req, res) => res.json(SYMBOLS.map((s, i) => ({ index: i, symbol: s.s, pay: s.pay }))));

  // ─── User notes + money timeline (richer profiles) ────────────────────
  r.post('/users/:userId/notes', async (req, res) => {
    res.json(await svc.setUserNotes({ userId: req.params.userId, notes: req.body?.notes, adminId: actor(req) }));
  });
  r.get('/users/:userId/timeline', async (req, res) => {
    const { rows } = await q(
      `SELECT id, type, amount, balance_after, status, created_at
       FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.userId]);
    res.json(rows.map(t => ({ ...t, amount: String(t.amount), balance_after: String(t.balance_after ?? 0) })));
  });

  return r;
}
