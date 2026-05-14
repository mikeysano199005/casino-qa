import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import axios from 'axios';
import { q } from '../db/index.js';
import { applyTx, upsertUser, getWallet, logAudit } from '../repo.js';
import { toPaise, fmt } from '../util/money.js';
import { logDeposit, logPaymentError, postWithdrawRequest } from '../admin/logs.js';

export function postPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('💳 Wallet')
      .setDescription('Deposit via UPI/card • Withdraw to UPI/Bank • View history')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wallet:balance').setLabel('Balance').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wallet:deposit').setLabel('Deposit').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('wallet:withdraw').setLabel('Withdraw').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('wallet:history').setLabel('History').setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function handleInteraction(i) {
  if (i.isButton()) {
    const [, action] = i.customId.split(':');
    if (action === 'balance')       return showBalance(i);
    if (action === 'deposit')       return depositModal(i);
    if (action === 'withdraw')      return withdrawChoice(i);
    if (action === 'withdraw_upi')  return upiModal(i);
    if (action === 'withdraw_bank') return bankModal(i);
    if (action === 'history')       return showHistory(i);
  }
  if (i.isModalSubmit()) {
    const [, action] = i.customId.split(':');
    if (action === 'deposit') return createDeposit(i);
    if (action === 'do_upi')  return submitWithdraw(i, 'upi');
    if (action === 'do_bank') return submitWithdraw(i, 'bank');
  }
}

async function showBalance(i) {
  const u = await upsertUser(i.user.id, i.user.username);
  const w = await getWallet(u.id);
  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('💳 Balance').addFields(
      { name: 'Available', value: fmt(w.available), inline: true },
      { name: 'Locked',    value: fmt(w.locked),    inline: true },
      { name: 'Wagered',   value: fmt(w.total_wagered), inline: true },
    )]
  });
}

function depositModal(i) {
  const m = new ModalBuilder().setCustomId('wallet:deposit').setTitle('Deposit');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('amount').setLabel('Amount in ₹')
      .setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder(`min ₹${process.env.MIN_DEPOSIT || 50} – max ₹${process.env.MAX_DEPOSIT || 50000}`)));
  return i.showModal(m);
}

// Step 1: ask UPI or Bank
function withdrawChoice(i) {
  return i.reply({ ephemeral: true,
    content: '**How would you like to receive your withdrawal?**',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wallet:withdraw_upi').setLabel('📱 UPI Transfer').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('wallet:withdraw_bank').setLabel('🏦 Bank Transfer').setStyle(ButtonStyle.Secondary),
    )],
  });
}

// Step 2a: UPI modal
function upiModal(i) {
  const m = new ModalBuilder().setCustomId('wallet:do_upi').setTitle('Withdraw via UPI');
  m.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('amount').setLabel('Amount in ₹').setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder(`min ₹${process.env.MIN_WITHDRAW || 500}`)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('upi').setLabel('UPI ID').setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder('example@upi')),
  );
  return i.showModal(m);
}

// Step 2b: Bank modal
function bankModal(i) {
  const m = new ModalBuilder().setCustomId('wallet:do_bank').setTitle('Withdraw via Bank Transfer');
  m.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('amount').setLabel('Amount in ₹').setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder(`min ₹${process.env.MIN_WITHDRAW || 500}`)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('bank_name').setLabel('Bank Name').setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder('e.g. State Bank of India')),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('acc').setLabel('Account Number').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('ifsc').setLabel('IFSC Code').setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder('e.g. SBIN0001234')),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('phone').setLabel('Phone Number').setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder('10-digit mobile number')),
  );
  return i.showModal(m);
}

async function createDeposit(i) {
  // Defer immediately — Cashfree API can take >3s and Discord kills unacknowledged interactions
  await i.deferReply({ ephemeral: true });
  const amount = Number(i.fields.getTextInputValue('amount'));
  const min = Number(process.env.MIN_DEPOSIT || 100);
  const max = Number(process.env.MAX_DEPOSIT || 50000);
  if (!Number.isFinite(amount) || amount < min || amount > max)
    return i.editReply({ content: `Deposit must be between ₹${min} and ₹${max}.` });

  const u = await upsertUser(i.user.id, i.user.username);
  const orderId = `cf_${u.id.slice(0, 8)}_${Date.now()}`;
  const env = process.env.CASHFREE_ENV === 'prod' ? 'api.cashfree.com' : 'sandbox.cashfree.com';
  const base = process.env.PUBLIC_BASE_URL;
  const headers = {
    'x-api-version': '2023-08-01',
    'x-client-id':   process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'Content-Type': 'application/json',
  };

  try {
    const res = await axios.post(`https://${env}/pg/orders`, {
      order_id: orderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: u.id,
        customer_name: i.user.username || 'player',
        customer_email: `${i.user.id}@discord.local`,
        customer_phone: '9999999999',
      },
      order_meta: {
        return_url: `${base}/payment-done`,
        notify_url: `${base}/cashfree/webhook`,
      },
    }, { headers });

    const link = `${base}/pay?session_id=${res.data.payment_session_id}`;
    await q(
      `INSERT INTO deposits(user_id,cashfree_order_id,amount,status) VALUES($1,$2,$3,'created')`,
      [u.id, orderId, toPaise(amount).toString()]
    );
    await i.editReply({
      embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle('💳 Deposit')
        .setDescription(`[Pay ₹${amount} via Cashfree](${link})\n\nWallet credits automatically after payment.`)]
    });
  } catch (e) {
    logPaymentError(i.client, { stage: 'create_order', user: i.user.username, error: e.response?.data || e.message });
    await i.editReply({ content: '⚠️ Could not create deposit — try again later.' });
  }
}

async function submitWithdraw(i, method) {
  await i.deferReply({ ephemeral: true });

  const amount = Number(i.fields.getTextInputValue('amount'));
  const min = Number(process.env.MIN_WITHDRAW || 500);
  if (!Number.isFinite(amount) || amount < min)
    return i.editReply({ content: `Minimum withdraw ₹${min}.` });

  const u = await upsertUser(i.user.id, i.user.username);

  // Cooldown check
  const { rows: ur } = await q(`SELECT withdraw_cooldown_until, withdraw_cooldown_hours FROM users WHERE id=$1`, [u.id]);
  if (ur[0]?.withdraw_cooldown_until && new Date(ur[0].withdraw_cooldown_until) > new Date())
    return i.editReply({ content: `Cooldown until <t:${Math.floor(new Date(ur[0].withdraw_cooldown_until).getTime()/1000)}:R>.` });

  const stake = toPaise(amount);

  // Bonus wagering requirement check
  const w = await getWallet(u.id);
  const withdrawable = BigInt(w.available) - BigInt(w.locked) - BigInt(w.bonus_balance);
  if (withdrawable < stake) {
    const need = fmt(BigInt(w.wager_pending));
    return i.editReply({
      content: `🔒 You have **${fmt(BigInt(w.bonus_balance))}** in bonus funds that require **${need}** more wagering before withdrawal.\nWithdrawable now: **${fmt(withdrawable < 0n ? 0n : withdrawable)}**`
    });
  }

  // Build payment details
  let upiId = null;
  let bankObj = null;

  if (method === 'upi') {
    upiId = i.fields.getTextInputValue('upi').trim();
    if (!upiId) return i.editReply({ content: 'UPI ID is required.' });
  } else {
    const name  = i.fields.getTextInputValue('bank_name').trim();
    const acc   = i.fields.getTextInputValue('acc').trim();
    const ifsc  = i.fields.getTextInputValue('ifsc').trim().toUpperCase();
    const phone = i.fields.getTextInputValue('phone').trim();
    if (!name || !acc || !ifsc || !phone) return i.editReply({ content: 'All bank fields are required.' });
    bankObj = { name, acc, ifsc, phone };
  }

  // Lock funds
  try {
    await applyTx({ userId: u.id, type: 'withdraw', amount: 0n, lockDelta: stake,
      ref: null, meta: { stage: 'lock', upi: upiId, bank: bankObj } });
  } catch { return i.editReply({ content: '💸 Insufficient available balance.' }); }

  const { rows } = await q(
    `INSERT INTO withdrawals(user_id,amount,upi_id,bank_details) VALUES($1,$2,$3,$4) RETURNING *`,
    [u.id, stake.toString(), upiId, bankObj]
  );

  // Set cooldown — use per-user override if set, else global default
  const cd = ur[0]?.withdraw_cooldown_hours ?? Number(process.env.WITHDRAW_COOLDOWN_HOURS || 48);
  if (cd > 0) {
    await q(`UPDATE users SET withdraw_cooldown_until = now() + ($1 || ' hours')::interval WHERE id=$2`,
      [String(cd), u.id]);
  }

  await postWithdrawRequest(i.client, { ...rows[0], discord_id: i.user.id, username: i.user.username });
  await logAudit(i.user.id, 'withdraw_requested', rows[0].id, null, { amount: stake.toString() });

  await i.editReply({ content: `✅ Withdraw request **${fmt(stake)}** sent for approval. You'll be notified once it's processed.` });
}

async function showHistory(i) {
  const u = await upsertUser(i.user.id, i.user.username);
  const { rows } = await q(
    `SELECT type,amount,balance_after,created_at FROM transactions
     WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`, [u.id]);
  const lines = rows.map(r =>
    `<t:${Math.floor(new Date(r.created_at).getTime()/1000)}:R> • ${r.type} • ${fmt(BigInt(r.amount))} → bal ${fmt(BigInt(r.balance_after))}`
  );
  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('Recent transactions')
      .setDescription(lines.join('\n') || '—')]
  });
}
