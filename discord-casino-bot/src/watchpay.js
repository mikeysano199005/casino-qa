import express from 'express';
import cookieParser from 'cookie-parser';
import { q } from './db/index.js';
import { applyTx, creditReferralBonus } from './repo.js';
import { logDeposit, logPaymentError } from './admin/logs.js';
import { buildSign } from './util/watchpay.js';
import { mountAdminPanel } from './admin/web/index.js';
import { EmbedBuilder } from 'discord.js';

const WATCHPAY_IP = '18.141.88.123';

export function startWebhookServer(client) {
  const app = express();
  app.use(express.urlencoded({ extended: true })); // WatchPay POSTs form-encoded data
  app.use(express.json());
  app.use(cookieParser());

  // Web admin panel (/admin + /api/admin/*), Discord-OAuth gated.
  mountAdminPanel(app, client);

  // Log every incoming request so we can see what WatchPay sends
  app.use((req, _res, next) => {
    if (req.method !== 'GET' || req.path !== '/health') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
      console.log(`[http] ${req.method} ${req.path} from ${ip}`);
    }
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/payment-done', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Done</title>
<style>body{background:#111;color:#fff;font-family:sans-serif;text-align:center;padding-top:80px}</style>
</head><body>
<h2>✅ Payment complete!</h2>
<p>Return to Discord — your wallet will be credited automatically within seconds.</p>
</body></html>`);
  });

  app.post('/watchpay/webhook', async (req, res) => {
    try {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
              || req.socket.remoteAddress;
      console.log('[watchpay] callback received from IP:', ip, '| body:', JSON.stringify(req.body));

      // ── IP whitelist ───────────────────────────────────────────────────
      const skipIpCheck = process.env.WATCHPAY_SKIP_IP_CHECK === 'true';
      if (!skipIpCheck && ip !== WATCHPAY_IP) {
        console.warn('[watchpay] rejected callback from IP:', ip);
        return res.status(200).send('fail');
      }

      const body = req.body;

      // ── Signature verification ────────────────────────────────────────
      const expected = buildSign(body, process.env.WATCHPAY_SECRET_KEY);
      if (body.sign !== expected) {
        console.error('[watchpay] signature MISMATCH — received:', body.sign, '| expected:', expected);
        logPaymentError(client, { stage: 'watchpay_signature', error: { received: body.sign, expected } });
        return res.status(200).send('fail');
      }

      // Handle both camelCase and snake_case field names
      const tradeResult = body.tradeResult ?? body.trade_status ?? body.status;
      const orderId     = body.mchOrderNo  ?? body.mch_order_no;
      const oriAmount   = body.oriAmount   ?? body.trade_amount ?? body.amount;

      console.log('[watchpay] tradeResult:', tradeResult, '| orderId:', orderId, '| amount:', oriAmount);

      if (tradeResult !== '1') return res.status(200).send('success');

      // ── Cheat sales (prefix: sale_) ───────────────────────────────────
      if (String(orderId).startsWith('sale_')) {
        const { rows } = await q(`SELECT * FROM cheat_sales WHERE cashfree_order_id=$1`, [orderId]);
        const sale = rows[0];
        if (!sale) return res.status(200).send('success');

        const { rowCount } = await q(
          `UPDATE cheat_sales SET status='success', credited_at=now()
           WHERE cashfree_order_id=$1 AND credited_at IS NULL`,
          [orderId],
        );
        if (!rowCount) return res.status(200).send('success'); // already credited by poll

        try {
          const rupees = Number(BigInt(sale.amount)) / 100;
          const ch = await client.channels.fetch(sale.ticket_channel_id);
          await ch.send({
            embeds: [new EmbedBuilder()
              .setColor(0x00C851)
              .setTitle('✅ Payment Confirmed!')
              .setDescription(`**${sale.buyer_name}** has successfully paid **₹${rupees}**.\n\n> Please deliver the product now.`)
              .addFields(
                { name: '👤 Buyer',  value: `\`${sale.buyer_name}\``, inline: true },
                { name: '💰 Amount', value: `**₹${rupees}**`,         inline: true },
                { name: '📋 Status', value: '✅ Paid',                 inline: true },
              )
              .setTimestamp()
            ],
          });
        } catch (e) { console.warn('[watchpay] ticket notify failed:', e.message); }

        return res.status(200).send('success');
      }

      // ── Casino deposits (prefix: wp_) ─────────────────────────────────
      const { rows } = await q(`SELECT * FROM deposits WHERE cashfree_order_id=$1`, [orderId]);
      const dep = rows[0];
      if (!dep) return res.status(200).send('success');

      // Verify amount (oriAmount is in rupees; dep.amount is in paise)
      const paidPaise     = BigInt(Math.round(parseFloat(oriAmount) * 100));
      const expectedPaise = BigInt(dep.amount);
      if (paidPaise !== expectedPaise) {
        logPaymentError(client, { stage: 'amount_mismatch', error: { expected: dep.amount, paid: paidPaise.toString() } });
        return res.status(200).send('success');
      }

      const { rowCount } = await q(
        `UPDATE deposits SET signature_verified=TRUE, raw_webhook=$2, status='success', credited_at=now()
         WHERE cashfree_order_id=$1 AND credited_at IS NULL`,
        [orderId, JSON.stringify(body)],
      );
      if (!rowCount) return res.status(200).send('success'); // duplicate

      await applyTx({
        userId: dep.user_id, type: 'deposit', amount: expectedPaise,
        ref: dep.id, meta: { provider: 'watchpay', orderId },
      });

      const { rows: uRows } = await q(`SELECT username, discord_id FROM users WHERE id=$1`, [dep.user_id]);
      logDeposit(client, {
        order_id: orderId, amount: expectedPaise.toString(),
        user_id: dep.user_id, username: uRows[0]?.username, discord_id: uRows[0]?.discord_id,
      });

      // Referral bonus on first deposit
      const { rows: prev } = await q(
        `SELECT id FROM deposits WHERE user_id=$1 AND credited_at IS NOT NULL AND id != $2 LIMIT 1`,
        [dep.user_id, dep.id],
      );
      if (!prev.length) {
        const { rows: ur } = await q(`SELECT referred_by FROM users WHERE id=$1`, [dep.user_id]);
        if (ur[0]?.referred_by)
          creditReferralBonus(ur[0].referred_by, dep.user_id).catch(e => console.warn('[referral]', e.message));
      }

      return res.status(200).send('success');
    } catch (e) {
      console.error('[watchpay webhook]', e);
      logPaymentError(client, { stage: 'webhook_handler', error: e.message });
      return res.status(200).send('success');
    }
  });

  const port = Number(process.env.PORT || process.env.WEBHOOK_PORT || 8787);
  app.listen(port, '0.0.0.0', () => console.log(`▶ webhook server on :${port}`));
}
