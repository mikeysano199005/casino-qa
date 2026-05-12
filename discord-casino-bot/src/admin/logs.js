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

// Mirror payload to CH_AUDIT_LOG unless it's already the target channel.
const mirrorToAudit = (client, primaryId, payload) => {
  if (env.CH_AUDIT_LOG && env.CH_AUDIT_LOG !== primaryId)
    safeSend(client, env.CH_AUDIT_LOG, payload);
};

export const logBetResult = (client, b) => {
  const stake  = BigInt(b.stake  || 0);
  const payout = BigInt(b.payout || 0);
  const won    = b.result === 'win';
  const pushed = b.result === 'push';
  const net    = won ? payout - stake : pushed ? 0n : -stake;
  const color  = won ? Colors.Green : pushed ? Colors.Yellow : Colors.Red;
  const icon   = won ? '✅' : pushed ? '↔️' : '❌';
  const game   = b.game.charAt(0).toUpperCase() + b.game.slice(1);
  const payload = {
    embeds: [new EmbedBuilder()
      .setColor(color)
      .setTitle(`${icon} ${game} — ${won ? 'WIN' : pushed ? 'PUSH' : 'LOSS'}`)
      .addFields(
        { name: '👤 Player',   value: `**${b.user}**\n\`${b.discordId}\``,               inline: true },
        { name: '🎮 Game',     value: game,                                               inline: true },
        { name: '🕐 Time',     value: `<t:${Math.floor(Date.now()/1000)}:R>`,             inline: true },
        { name: '💰 Stake',    value: fmt(stake),                                         inline: true },
        { name: '🏆 Payout',   value: fmt(payout),                                        inline: true },
        { name: net >= 0n ? '📈 Profit' : '📉 Loss', value: `${net >= 0n ? '+' : ''}${fmt(net)}`, inline: true },
      )],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`userpanel:direct:${b.discordId}`)
        .setLabel('🔍 Lookup User')
        .setStyle(ButtonStyle.Secondary),
    )],
  };
  safeSend(client, env.CH_BET_LOGS, payload);
};

export const logRound = (client, game, id, info) => {
  const payload = { embeds: [new EmbedBuilder().setColor(Colors.Gold)
    .setTitle(`📦 Round settled: ${game}`).setDescription(`\`${id}\`\n\`\`\`json\n${JSON.stringify(info, null, 2).slice(0, 1800)}\n\`\`\``)] };
  safeSend(client, env.CH_ROUND_LOGS, payload);
};

export const logDeposit = (client, d) => {
  const payload = { embeds: [new EmbedBuilder().setColor(Colors.Green)
    .setTitle('💰 Deposit credited')
    .addFields(
      { name: 'Amount',     value: fmt(BigInt(d.amount)),                              inline: true },
      { name: 'Username',   value: d.username   || '—',                               inline: true },
      { name: 'Discord',    value: d.discord_id ? `<@${d.discord_id}>` : '—',         inline: true },
      { name: 'Discord ID', value: d.discord_id || '—',                               inline: true },
      { name: 'Order',      value: `\`${d.order_id}\``,                               inline: false },
    )] };
  safeSend(client, env.CH_DEPOSIT_LOGS, payload);
};

export const logPaymentError = (client, e) => {
  const payload = { embeds: [new EmbedBuilder().setColor(Colors.Red)
    .setTitle('⚠️ Payment error').setDescription(`Stage: ${e.stage}\nUser: ${e.user || '—'}\n\`\`\`${JSON.stringify(e.error).slice(0, 1500)}\`\`\``)] };
  safeSend(client, env.CH_PAYMENT_ERRORS, payload);
  mirrorToAudit(client, env.CH_PAYMENT_ERRORS, payload);
};

export const logAlert = (client, msg) => {
  const payload = { content: `🚨 ${msg}` };
  safeSend(client, env.CH_ALERTS, payload);
  mirrorToAudit(client, env.CH_ALERTS, payload);
};

export const logSuspicious = (client, msg) => {
  const payload = { content: `🕵️ ${msg}` };
  safeSend(client, env.CH_SUSPICIOUS, payload);
  mirrorToAudit(client, env.CH_SUSPICIOUS, payload);
};

export const logAuditMsg = (client, msg) =>
  safeSend(client, env.CH_AUDIT_LOG, { content: `📝 ${msg}` });

export const broadcastBigWin = (client, username, game, payout) => {
  const payload = { content: `🎉 **${username}** just won **${fmt(payout)}** on ${game}!` };
  safeSend(client, env.CH_CHAT, payload);
  mirrorToAudit(client, env.CH_CHAT, payload);
};

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
  const payload = { embeds: [e], components: [row] };
  await safeSend(client, env.CH_WITHDRAW_REQUESTS, payload);
}

export async function botHeartbeat(client) {
  await safeSend(client, env.CH_BOT_STATUS, { content: `✅ Bot online • ${new Date().toISOString()}` });
}
