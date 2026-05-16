import crypto from 'node:crypto';
import axios from 'axios';

// Sort all non-empty params (excluding sign / sign_type / signType) alphabetically,
// join as k=v&k=v, append &key=SECRET, MD5 → lowercase
export function buildSign(params, secretKey) {
  const str = Object.entries(params)
    .filter(([k, v]) =>
      k !== 'sign' && k !== 'sign_type' && k !== 'signType' &&
      v !== '' && v !== null && v !== undefined
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&') + `&key=${secretKey}`;
  return crypto.createHash('md5').update(str).digest('hex');
}

// Create a payment order; returns the direct payment URL (payInfo)
export async function createPayOrder({ orderId, amountRupees, notifyUrl, pageUrl, goodsName }) {
  const orderDate = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const params = {
    version:      '1.0',
    mch_id:       process.env.WATCHPAY_MCH_ID,
    notify_url:   notifyUrl,
    page_url:     pageUrl,
    mch_order_no: orderId,
    pay_type:     process.env.WATCHPAY_PAY_TYPE || '101',
    trade_amount: String(amountRupees),
    order_date:   orderDate,
    goods_name:   goodsName.slice(0, 50),
  };

  const sign = buildSign(params, process.env.WATCHPAY_SECRET_KEY);
  const body = new URLSearchParams({ ...params, sign, sign_type: 'MD5' });

  const base = process.env.WATCHPAY_BASE_URL || 'https://api.watchglb.com';
  const res = await axios.post(`${base}/pay/web`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15_000,
  });

  if (res.data.respCode !== 'SUCCESS' || res.data.tradeResult !== '1')
    throw new Error(res.data.tradeMsg || 'WatchPay order creation failed');

  return res.data.payInfo; // direct payment URL — give straight to the user
}
