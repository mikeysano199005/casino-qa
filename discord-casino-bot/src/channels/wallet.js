import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import axios from 'axios';
import crypto from 'node:crypto';
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
    if (action === 'balance')   return showBalance(i);
    if (action === 'deposit')   return depositModal(i);
    if (action === 'withdraw')  return withdrawModal(i);
    if (action === 'history')   return showHistory(i);
  }
  if (i.isModalSubmit()) {
    const [, action] = i.customId.split(':');
    if (action === 'deposit')  return createDeposit(i);
    if (action === 'withdraw') return submitWithdraw(i);
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
      .setPlaceholder(`min ${process.env.MIN_DEPOSIT || 100}`)));
  return i.showModal(m);
}

function withdrawModal(i) {
  const m = new ModalBuilder().setCustomId('wallet:withdraw').setTitle('Withdraw');
  m.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('amount').setLabel('Amount in ₹').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('upi').setLabel('UPI ID (or leave blank)').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('bank').setLabel('Bank: name|acc|ifsc (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return i.showModal(m);
}

async function createDeposit(i) {
  const amount = Number(i.fields.getTextInputValue('amount'));
  const min = Number(process.env.MIN_DEPOSIT || 100);
  const max = Number(process.env.MAX_DEPOSIT || 50000);
  if (!Number.isFinite(amount) || amount < min || amount > max)
    return i.reply({ ephemeral: true, content: `Deposit must be between ₹${min} and ₹${max}.` });

  const u = await upsertUser(i.user.id, i.user.username);
  const linkId = `cf_${u.id.slice(0, 8)}_${Date.now()}`;
  const env = process.env.CASHFREE_ENV === 'prod' ? 'api.cashfree.com' : 'sandbox.cashfree.com';
  const headers = {
    'x-api-version': '2023-08-01',
    'x-client-id':   process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'Content-Type': 'application/json',
  };

  try {
    const res = await axios.post(`https://${env}/pg/links`, {
      link_id: linkId,
      link_amount: amount,
      link_currency: 'INR',
      link_purpose: 'Casino Deposit',
      customer_details: {
        customer_phone: '9999999999',
        customer_name: i.user.username || 'player',
        customer_email: `${i.user.id}@discord.local`,
      },
      link_partial_payments: false,
      link_meta: {
        return_url: process.env.CASHFREE_RETURN_URL || `${process.env.PUBLIC_BASE_URL}/`,
        notify_url: `${process.env.PUBLIC_BASE_URL}/cashfree/webhook`,
      },
    }, { headers });

    const link = res.data.link_url;
    await q(
      `INSERT INTO deposits(user_id,cashfree_order_id,amount,status) VALUES($1,$2,$3,'created')`,
      [u.id, linkId, toPaise(amount).toString()]
    );
    await i.reply({ ephemeral: true,
      embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle('💳 Deposit')
        .setDescription(`[Pay ₹${amount} via Cashfree](${link})\n\nWallet credits automatically after payment.`)]
    });
  } catch (e) {
    logPaymentError(i.client, { stage: 'create_link', user: i.user.username, error: e.response?.data || e.message });
    await i.reply({ ephemeral: true, content: '⚠️ Could not create payment link, try again later.' });
  }
}

async function submitWithdraw(i) {
  const amount = Number(i.fields.getTextInputValue('amount'));
  const upi    = i.fields.getTextInputValue('upi')?.trim() || null;
  const bank   = i.fields.getTextInputValue('bank')?.trim() || null;
  const min = Number(process.env.MIN_WITHDRAW || 200);
  if (!Number.isFinite(amount) || amount < min)
    return i.reply({ ephemeral: true, content: `Minimum withdraw ₹${min}.` });
  if (!upi && !bank)
    return i.reply({ ephemeral: true, content: 'Provide UPI or bank details.' });

  const u = await upsertUser(i.user.id, i.user.username);

  // Cooldown check
  const { rows: ur } = await q(
    `SELECT withdraw_cooldown_until FROM users WHERE id=$1`, [u.id]
  );
  if (ur[0]?.withdraw_cooldown_until && new Date(ur[0].withdraw_cooldown_until) > new Date())
    return i.reply({ ephemeral: true, content: `Cooldown until <t:${Math.floor(new Date(ur[0].withdraw_cooldown_until).getTime()/1000)}:R>.` });

  const stake = toPaise(amount);

  // Bonus wagering requirement check
  const w = await getWallet(u.id);
  const withdrawable = BigInt(w.available) - BigInt(w.locked) - BigInt(w.bonus_balance);
  if (withdrawable < stake) {
    const need = fmt(BigInt(w.wager_pending));
    return i.reply({ ephemeral: true,
      content: `🔒 You have **${fmt(BigInt(w.bonus_balance))}** in bonus funds that require **${need}** more wagering before withdrawal.\nWithdrawable now: **${fmt(withdrawable < 0n ? 0n : withdrawable)}**`
    });
  }
  let bankObj = null;
  if (bank) {
    const [name, acc, ifsc] = bank.split('|').map(s => s?.trim());
    bankObj = { name, acc, ifsc };
  }

  // lock funds
  try {
    await applyTx({ userId: u.id, type: 'withdraw', amount: 0n, lockDelta: stake,
      ref: null, meta: { stage: 'lock', upi, bank: bankObj } });
  } catch { return i.reply({ ephemeral: true, content: '💸 Insufficient available balance.' }); }

  const { rows } = await q(
    `INSERT INTO withdrawals(user_id,amount,upi_id,bank_details) VALUES($1,$2,$3,$4) RETURNING *`,
    [u.id, stake.toString(), upi, bankObj]
  );
  // set cooldown
  const cd = Number(process.env.WITHDRAW_COOLDOWN_HOURS || 24);
  await q(`UPDATE users SET withdraw_cooldown_until = now() + ($1 || ' hours')::interval WHERE id=$2`,
    [String(cd), u.id]);

  await postWithdrawRequest(i.client, { ...rows[0], discord_id: i.user.id, username: i.user.username });
  await logAudit(i.user.id, 'withdraw_requested', rows[0].id, null, { amount: stake.toString() });

  await i.reply({ ephemeral: true,
    content: `✅ Withdraw request **${fmt(stake)}** sent for approval. You'll be notified.` });
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
