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
      vip_tier: u.vip_tier, user_preset: u.user_preset, created_at: u.created_at,
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

  return r;
}
