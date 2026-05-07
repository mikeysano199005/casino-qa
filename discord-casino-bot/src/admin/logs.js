// Posts to the configured channel IDs. Designed to never throw upstream.
import { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { fmt } from '../util/money.js';

const env = process.env;
const safeSend = async (client, channelId, payload) => {
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send(payload);
  } catch (e) { console.warn('[log send]', e.message); }
};

export const logBet = (client, b) =>
  safeSend(client, env.CH_BET_LOGS, { embeds: [new EmbedBuilder().setColor(Colors.Blurple)
    .setTitle('🎯 Bet').setDescription(`**${b.user}** • ${b.game} • ${fmt(BigInt(b.stake))}${b.selection ? ` • ${b.selection}` : ''}`)]});

export const logRound = (client, game, id, info) =>
  safeSend(client, env.CH_ROUND_LOGS, { embeds: [new EmbedBuilder().setColor(Colors.Gold)
    .setTitle(`📦 Round settled: ${game}`).setDescription(`\`${id}\`\n\`\`\`json\n${JSON.stringify(info, null, 2).slice(0, 1800)}\n\`\`\``)]});

export const logDeposit = (client, d) =>
  safeSend(client, env.CH_DEPOSIT_LOGS, { embeds: [new EmbedBuilder().setColor(Colors.Green)
    .setTitle('💰 Deposit credited').setDescription(`Order \`${d.order_id}\` • ${fmt(BigInt(d.amount))} • user ${d.user_id}`)]});

export const logPaymentError = (client, e) =>
  safeSend(client, env.CH_PAYMENT_ERRORS, { embeds: [new EmbedBuilder().setColor(Colors.Red)
    .setTitle('⚠️ Payment error').setDescription(`Stage: ${e.stage}\nUser: ${e.user || '—'}\n\`\`\`${JSON.stringify(e.error).slice(0, 1500)}\`\`\``)]});

export const logAlert = (client, msg) =>
  safeSend(client, env.CH_ALERTS, { content: `🚨 ${msg}` });

export const logSuspicious = (client, msg) =>
  safeSend(client, env.CH_SUSPICIOUS, { content: `🕵️ ${msg}` });

export const logAuditMsg = (client, msg) =>
  safeSend(client, env.CH_AUDIT_LOG, { content: `📝 ${msg}` });

export const broadcastBigWin = (client, username, game, payout) =>
  safeSend(client, env.CH_CHAT, { content: `🎉 **${username}** just won **${fmt(payout)}** on ${game}!` });

export async function postWithdrawRequest(client, w) {
  const isUpi = !!w.upi_id;
  const b = w.bank_details;

  const fields = [
    { name: 'User',   value: `<@${w.discord_id}> (${w.username})`, inline: true },
    { name: 'Amount', value: fmt(BigInt(w.amount)),                 inline: true },
    { name: 'Method', value: isUpi ? '📱 UPI' : '🏦 Bank Transfer', inline: true },
  ];

  if (isUpi) {
    fields.push({ name: 'UPI ID', value: w.upi_id, inline: false });
  } else if (b) {
    fields.push(
      { name: 'Bank Name',       value: b.name  || '—', inline: true },
      { name: 'Account Number',  value: b.acc   || '—', inline: true },
      { name: 'IFSC Code',       value: b.ifsc  || '—', inline: true },
      { name: 'Phone Number',    value: b.phone || '—', inline: true },
    );
  }

  fields.push({ name: 'Request ID', value: `\`${w.id}\``, inline: false });

  const e = new EmbedBuilder().setColor(Colors.Orange).setTitle('💸 Withdraw Request').addFields(...fields);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wd:approve:${w.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wd:reject:${w.id}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger),
  );
  await safeSend(client, env.CH_WITHDRAW_REQUESTS, { embeds: [e], components: [row] });
}

export async function botHeartbeat(client) {
  await safeSend(client, env.CH_BOT_STATUS, { content: `✅ Bot online • ${new Date().toISOString()}` });
}
