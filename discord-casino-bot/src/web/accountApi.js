// Web wallet + account API for the player site. Mounted by play.js under the
// same /api/play/* cookie auth. Reuses the exact Discord money logic.
import { q } from '../db/index.js';
import { upsertUser, getWallet, applyTx, creditBonus, applyReferralCode, redeemPromoCode, logAudit } from '../repo.js';
import { createPayOrder } from '../util/watchpay.js';
import { logDepositPending, postWithdrawRequest, logPaymentError } from '../admin/logs.js';
import { cfg } from '../config.js';
import { toPaise } from '../util/money.js';

const big = (v) => (v ?? 0).toString();
const baseUrl = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

export function mountAccountApi(app, client, requirePlay) {
  const me = (req) => upsertUser(req.player.discordId, req.player.name);

  // ─── Wallet ────────────────────────────────────────────────────────────
  app.get('/api/play/wallet', requirePlay, async (req, res) => {
    try {
      const u = await me(req);
      const w = await getWallet(u.id);
      const withdrawable = BigInt(w.available) - BigInt(w.locked) - BigInt(w.bonus_balance);
      res.json({
        available: big(w.available), locked: big(w.locked), bonus_balance: big(w.bonus_balance),
        wager_pending: big(w.wager_pending), withdrawable: big(withdrawable < 0n ? 0n : withdrawable),
        total_deposited: big(w.total_deposited), total_withdrawn: big(w.total_withdrawn), total_wagered: big(w.total_wagered),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/play/deposit', requirePlay, async (req, res) => {
    const amount = Number(req.body?.amount);
    const min = Number(cfg('MIN_DEPOSIT') || 100), max = Number(cfg('MAX_DEPOSIT') || 50000);
    if (!Number.isFinite(amount) || amount < min || amount > max)
      return res.status(400).json({ error: 'amount_range', min, max });
    try {
      const u = await me(req);
      const orderId = `wp_${u.id.slice(0, 8)}_${Date.now()}`;
      const base = baseUrl();
      const payUrl = await createPayOrder({
        orderId, amountRupees: amount,
        notifyUrl: `${base}/watchpay/webhook`, pageUrl: `${base}/payment-done`, goodsName: 'Casino Deposit',
      });
      await q(`INSERT INTO deposits(user_id,cashfree_order_id,amount,status) VALUES($1,$2,$3,'created')`,
        [u.id, orderId, toPaise(amount).toString()]);
      logDepositPending(client, { amount: toPaise(amount).toString(), order_id: orderId, username: u.username, discord_id: req.player.discordId });
      res.json({ ok: true, payUrl });
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      logPaymentError(client, { stage: 'web_create_order', user: req.player.name, error: detail });
      res.status(500).json({ error: 'deposit_failed', detail });
    }
  });

  app.post('/api/play/withdraw', requirePlay, async (req, res) => {
    const amount = Number(req.body?.amount);
    const method = req.body?.method;
    const min = Number(cfg('MIN_WITHDRAW') || 500);
    if (!Number.isFinite(amount) || amount < min) return res.status(400).json({ error: 'min', min });

    try {
      const u = await me(req);
      const { rows: ur } = await q(`SELECT withdraw_cooldown_until, withdraw_cooldown_hours FROM users WHERE id=$1`, [u.id]);
      if (ur[0]?.withdraw_cooldown_until && new Date(ur[0].withdraw_cooldown_until) > new Date())
        return res.status(400).json({ error: 'cooldown', until: ur[0].withdraw_cooldown_until });

      const stake = toPaise(amount);
      const w = await getWallet(u.id);
      const withdrawable = BigInt(w.available) - BigInt(w.locked) - BigInt(w.bonus_balance);
      if (withdrawable < stake)
        return res.status(400).json({ error: 'wagering', withdrawable: big(withdrawable < 0n ? 0n : withdrawable), wager_pending: big(w.wager_pending) });

      let upiId = null, bankObj = null;
      if (method === 'upi') {
        upiId = (req.body?.upi || '').toString().trim();
        if (!upiId) return res.status(400).json({ error: 'upi_required' });
      } else if (method === 'bank') {
        const b = req.body?.bank || {};
        const name = (b.name || '').toString().trim(), acc = (b.acc || '').toString().trim();
        const ifsc = (b.ifsc || '').toString().trim().toUpperCase(), phone = (b.phone || '').toString().trim();
        if (!name || !acc || !ifsc || !phone) return res.status(400).json({ error: 'bank_required' });
        bankObj = { name, acc, ifsc, phone };
      } else return res.status(400).json({ error: 'invalid_method' });

      try {
        await applyTx({ userId: u.id, type: 'withdraw', amount: 0n, lockDelta: stake, ref: null, meta: { stage: 'lock', upi: upiId, bank: bankObj } });
      } catch { return res.status(400).json({ error: 'insufficient' }); }

      const { rows } = await q(
        `INSERT INTO withdrawals(user_id,amount,upi_id,bank_details) VALUES($1,$2,$3,$4) RETURNING *`,
        [u.id, stake.toString(), upiId, bankObj]);

      const cd = ur[0]?.withdraw_cooldown_hours ?? Number(cfg('WITHDRAW_COOLDOWN_HOURS') || 48);
      if (cd > 0) await q(`UPDATE users SET withdraw_cooldown_until = now() + ($1 * interval '1 hour') WHERE id=$2`, [cd, u.id]);

      await postWithdrawRequest(client, { ...rows[0], discord_id: req.player.discordId, username: u.username });
      logAudit(req.player.discordId, 'withdraw_requested', rows[0].id, null, { amount: stake.toString() }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Account ───────────────────────────────────────────────────────────
  app.get('/api/play/account', requirePlay, async (req, res) => {
    try {
      const u = await me(req);
      const w = await getWallet(u.id);
      const { rows: [ref] } = await q(`SELECT COUNT(*) total, COALESCE(SUM(amount),0) earned FROM referral_bonuses WHERE referrer_id=$1`, [u.id]);
      const { rows: daily } = await q(`SELECT 1 FROM transactions WHERE user_id=$1 AND type='bonus' AND meta->>'kind'='daily' AND created_at > now() - interval '24 hours' LIMIT 1`, [u.id]);
      const { rows: stats } = await q(`SELECT game, COUNT(*) c, COALESCE(SUM(stake),0) s, COALESCE(SUM(payout),0) p FROM bets WHERE user_id=$1 AND result!='pending' GROUP BY game ORDER BY c DESC`, [u.id]);
      const withdrawable = BigInt(w.available) - BigInt(w.locked) - BigInt(w.bonus_balance);
      res.json({
        username: u.username, vip_tier: u.vip_tier, status: u.status, referral_code: u.referral_code,
        referrals: Number(ref.total), referral_earned: big(ref.earned), referred: !!u.referred_by, joined: u.created_at,
        dailyAvailable: daily.length === 0,
        wallet: {
          available: big(w.available), locked: big(w.locked), bonus_balance: big(w.bonus_balance), wager_pending: big(w.wager_pending),
          withdrawable: big(withdrawable < 0n ? 0n : withdrawable), total_deposited: big(w.total_deposited), total_withdrawn: big(w.total_withdrawn), total_wagered: big(w.total_wagered),
        },
        stats: stats.map(s => ({ game: s.game, count: Number(s.c), staked: big(s.s), payout: big(s.p) })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/play/history', requirePlay, async (req, res) => {
    try {
      const u = await me(req);
      const page = Number(req.query.page) || 0, PAGE = 20;
      const { rows } = await q(
        `SELECT game, stake, payout, result, settled_at FROM bets WHERE user_id=$1 AND result!='pending'
         ORDER BY settled_at DESC LIMIT $2 OFFSET $3`, [u.id, PAGE + 1, page * PAGE]);
      res.json({ hasNext: rows.length > PAGE, page, bets: rows.slice(0, PAGE).map(b => ({ ...b, stake: big(b.stake), payout: big(b.payout) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/play/daily', requirePlay, async (req, res) => {
    try {
      const u = await me(req);
      const { rows } = await q(`SELECT 1 FROM transactions WHERE user_id=$1 AND type='bonus' AND meta->>'kind'='daily' AND created_at > now() - interval '24 hours' LIMIT 1`, [u.id]);
      if (rows.length) return res.status(400).json({ error: 'already_claimed' });
      await applyTx({ userId: u.id, type: 'bonus', amount: 100n, ref: null, meta: { kind: 'daily' } });
      const w = await getWallet(u.id);
      res.json({ ok: true, amount: '100', balance: big(w.available) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/play/redeem', requirePlay, async (req, res) => {
    const code = (req.body?.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: 'empty' });
    try {
      const u = await me(req);
      const r = await redeemPromoCode(u.id, code);
      if (r.error) return res.status(400).json({ error: r.error });
      await creditBonus(u.id, BigInt(r.promo.bonus_amount), r.promo.wager_mult || 5);
      const w = await getWallet(u.id);
      res.json({ ok: true, bonus: big(r.promo.bonus_amount), balance: big(w.available) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/play/refcode', requirePlay, async (req, res) => {
    const code = (req.body?.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: 'empty' });
    try {
      const u = await me(req);
      const ok = await applyReferralCode(u.id, code);
      if (!ok) return res.status(400).json({ error: 'invalid' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
