import express from 'express';
import crypto from 'node:crypto';
import { q } from './db/index.js';
import { applyTx, creditReferralBonus } from './repo.js';
import { logDeposit, logPaymentError } from './admin/logs.js';

export function startWebhookServer(client) {
  const app = express();
  app.use('/cashfree/webhook', express.raw({ type: '*/*' }));   // raw body for signature verification
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Hosted checkout page — loads Cashfree JS SDK with the order's payment_session_id
  const CF_MODE = process.env.CASHFREE_ENV === 'prod' ? 'production' : 'sandbox';
  app.get('/pay', (req, res) => {
    const sid = String(req.query.session_id || '').replace(/[^A-Za-z0-9_\-]/g, '');
    if (!sid) return res.status(400).send('Bad request');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Casino Deposit</title>
<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
<style>body{background:#111;color:#fff;font-family:sans-serif;text-align:center;padding-top:80px}</style>
</head><body>
<h2>Redirecting to payment…</h2>
<script>
Cashfree({ mode: "${CF_MODE}" }).checkout({
  paymentSessionId: "${sid}",
  redirectTarget: "_self"
});
</script></body></html>`);
  });

  app.get('/payment-done', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Done</title>
<style>body{background:#111;color:#fff;font-family:sans-serif;text-align:center;padding-top:80px}</style>
</head><body>
<h2>✅ Payment complete!</h2>
<p>Return to Discord — your wallet will be credited automatically within seconds.</p>
</body></html>`);
  });

  app.post('/cashfree/webhook', async (req, res) => {
    try {
      const raw = req.body.toString('utf8');
      const ts  = req.headers['x-webhook-timestamp'];
      const sig = req.headers['x-webhook-signature'];

      // Cashfree v3 signature: base64( HMAC_SHA256( secret, timestamp + raw_body ) )
      const expected = crypto
        .createHmac('sha256', process.env.CASHFREE_WEBHOOK_SECRET)
        .update(ts + raw).digest('base64');

      if (!sig || sig !== expected) {
        logPaymentError(client, { stage: 'webhook_signature', error: { sig, expected } });
        return res.status(401).send('bad signature');
      }

      const payload = JSON.parse(raw);
      // Support both order webhooks (PAYMENT_SUCCESS) and payment link webhooks (PAYMENT_LINK_PAYMENT_SUCCESS)
      const isLinkEvent = (payload?.type || '').startsWith('PAYMENT_LINK_');
      const orderId = isLinkEvent
        ? payload?.data?.link?.link_id
        : (payload?.data?.order?.order_id || payload?.data?.order_id);
      const status  = (payload?.data?.payment?.payment_status || payload?.type || '').toUpperCase();
      const paid    = Number(payload?.data?.payment?.payment_amount || payload?.data?.order?.order_amount || 0);

      // Fast lookup (no lock) to handle non-success and unknown orders cheaply
      const { rows } = await q(`SELECT * FROM deposits WHERE cashfree_order_id=$1`, [orderId]);
      const dep = rows[0];
      if (!dep) return res.status(200).send('unknown order');

      if (!status.includes('SUCCESS')) {
        await q(`UPDATE deposits SET signature_verified=TRUE, raw_webhook=$2, status='failed'
          WHERE cashfree_order_id=$1 AND credited_at IS NULL`, [orderId, payload]);
        return res.status(200).send('not success');
      }

      // verify amount matches before claiming
      const expectedPaise = BigInt(dep.amount);
      const paidPaise     = BigInt(Math.round(paid * 100));
      if (paidPaise !== expectedPaise) {
        logPaymentError(client, { stage: 'amount_mismatch', error: { expected: dep.amount, paid: paidPaise.toString() }});
        return res.status(200).send('amount mismatch');
      }

      // Atomic claim: sets credited_at only if not already set — safe against concurrent webhooks
      const { rowCount } = await q(
        `UPDATE deposits SET signature_verified=TRUE, raw_webhook=$2, status='success', credited_at=now()
         WHERE cashfree_order_id=$1 AND credited_at IS NULL`,
        [orderId, payload]
      );
      if (!rowCount) return res.status(200).send('already credited');

      await applyTx({
        userId: dep.user_id, type: 'deposit', amount: expectedPaise,
        ref: dep.id, meta: { provider: 'cashfree', orderId },
      });
      logDeposit(client, { order_id: orderId, amount: expectedPaise.toString(), user_id: dep.user_id });

      // Credit referral bonus on the referee's first ever deposit
      const { rows: prevDeps } = await q(
        `SELECT id FROM deposits WHERE user_id=$1 AND credited_at IS NOT NULL AND id != $2 LIMIT 1`,
        [dep.user_id, dep.id]
      );
      if (!prevDeps.length) {
        const { rows: userRow } = await q(`SELECT referred_by FROM users WHERE id=$1`, [dep.user_id]);
        if (userRow[0]?.referred_by) {
          creditReferralBonus(userRow[0].referred_by, dep.user_id).catch(e =>
            console.warn('[referral bonus]', e.message)
          );
        }
      }

      return res.status(200).send('ok');
    } catch (e) {
      console.error('[webhook]', e);
      logPaymentError(client, { stage: 'webhook_handler', error: e.message });
      return res.status(500).send('error');
    }
  });

  // Railway/Render inject PORT automatically; fall back to WEBHOOK_PORT for local dev
  const port = Number(process.env.PORT || process.env.WEBHOOK_PORT || 8787);
  app.listen(port, '0.0.0.0', () => console.log(`▶ webhook server on :${port}`));
}
