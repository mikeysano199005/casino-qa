// Posts to the configured channel IDs. Designed to never throw upstream.
// Channel IDs are read through cfg() so the web admin panel can re-route them live.
import { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { fmt } from '../util/money.js';
import { cfg } from '../config.js';
import { q } from '../db/index.js';

const safeSend = async (client, channelId, payload) => {
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send(payload);
  } catch (e) { console.warn('[log send]', e.message); }
};

// Persist every event to event_logs so the web panel shows all activity even
// when the bot can't post to Discord channels. Fire-and-forget; never throws.
export function logEvent(kind, { title = null, body = null, discordId = null, amount = null, meta = null } = {}) {
  q(`INSERT INTO event_logs(kind,title,body,discord_id,amount,meta) VALUES($1,$2,$3,$4,$5,$6)`,
    [kind, title, body, discordId, amount != null ? String(amount) : null, meta || null])
    .catch(() => {});
}

// Mirror payload to CH_AUDIT_LOG unless it's already the target channel.
const mirrorToAudit = (client, primaryId, payload) => {
  const auditId = cfg('CH_AUDIT_LOG');
  if (auditId && auditId !== primaryId)
    safeSend(client, auditId, payload);
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
  safeSend(client, cfg('CH_BET_LOGS'), payload);
  logEvent('bet', {
    title: `${game} — ${won ? 'WIN' : pushed ? 'PUSH' : 'LOSS'}`,
    body: `${b.user || ''} • stake ${fmt(stake)} • payout ${fmt(payout)}`,
    discordId: b.discordId, amount: net, meta: { game: b.game, result: b.result },
  });
};

export const logRound = (client, game, id, info) => {
  const payload = { embeds: [new EmbedBuilder().setColor(Colors.Gold)
    .setTitle(`📦 Round settled: ${game}`).setDescription(`\`${id}\`\n\`\`\`json\n${JSON.stringify(info, null, 2).slice(0, 1800)}\n\`\`\``)] };
  safeSend(client, cfg('CH_ROUND_LOGS'), payload);
  logEvent('round', { title: `Round settled: ${game}`, body: JSON.stringify(info).slice(0, 1000), meta: { game, id } });
};

export const logDepositPending = (client, d) => {
  const now = Math.floor(Date.now() / 1000);
  const payload = { embeds: [new EmbedBuilder().setColor(Colors.Yellow)
    .setTitle('🕐 Deposit Initiated')
    .addFields(
      { name: '📋 Status',     value: '⏳ **PENDING**',                                 inline: true },
      { name: '💰 Amount',     value: fmt(BigInt(d.amount)),                            inline: true },
      { name: '🕑 Time',       value: `<t:${now}:F>`,                                  inline: true },
      { name: '👤 Username',   value: d.username   || '—',                             inline: true },
      { name: '🆔 Discord ID', value: d.discord_id || '—',                             inline: true },
      { name: '🏷️ Mention',    value: d.discord_id ? `<@${d.discord_id}>` : '—',      inline: true },
      { name: '🔑 Order ID',   value: `\`${d.order_id}\``,                             inline: false },
    )] };
  safeSend(client, cfg('CH_DEPOSIT_LOGS'), payload);
  logEvent('deposit_pending', { title: 'Deposit initiated', body: `${d.username || '—'} • order ${d.order_id}`, discordId: d.discord_id, amount: d.amount });
};

export const logDeposit = (client, d) => {
  const now = Math.floor(Date.now() / 1000);
  const payload = { embeds: [new EmbedBuilder().setColor(Colors.Green)
    .setTitle('✅ Deposit Successful')
    .addFields(
      { name: '📋 Status',     value: '✅ **CREDITED**',                                inline: true },
      { name: '💰 Amount',     value: fmt(BigInt(d.amount)),                            inline: true },
      { name: '🕑 Time',       value: `<t:${now}:F>`,                                  inline: true },
      { name: '👤 Username',   value: d.username   || '—',                             inline: true },
      { name: '🆔 Discord ID', value: d.discord_id || '—',                             inline: true },
      { name: '🏷️ Mention',    value: d.discord_id ? `<@${d.discord_id}>` : '—',      inline: true },
      { name: '🔑 Order ID',   value: `\`${d.order_id}\``,                             inline: false },
    )] };
  safeSend(client, cfg('CH_DEPOSIT_LOGS'), payload);
  logEvent('deposit', { title: 'Deposit successful', body: `${d.username || '—'} • order ${d.order_id}`, discordId: d.discord_id, amount: d.amount });
};

export const logPaymentError = (client, e) => {
  const payload = { embeds: [new EmbedBuilder().setColor(Colors.Red)
    .setTitle('⚠️ Payment error').setDescription(`Stage: ${e.stage}\nUser: ${e.user || '—'}\n\`\`\`${JSON.stringify(e.error).slice(0, 1500)}\`\`\``)] };
  safeSend(client, cfg('CH_PAYMENT_ERRORS'), payload);
  mirrorToAudit(client, cfg('CH_PAYMENT_ERRORS'), payload);
  logEvent('payment_error', { title: `Payment error: ${e.stage}`, body: JSON.stringify(e.error).slice(0, 1000), discordId: e.user || null });
};

export const logAlert = (client, msg) => {
  const payload = { content: `🚨 ${msg}` };
  safeSend(client, cfg('CH_ALERTS'), payload);
  mirrorToAudit(client, cfg('CH_ALERTS'), payload);
  logEvent('alert', { title: 'Alert', body: String(msg).slice(0, 1000) });
};

export const logSuspicious = (client, msg) => {
  const payload = { content: `🕵️ ${msg}` };
  safeSend(client, cfg('CH_SUSPICIOUS'), payload);
  mirrorToAudit(client, cfg('CH_SUSPICIOUS'), payload);
  logEvent('suspicious', { title: 'Suspicious activity', body: String(msg).slice(0, 1000) });
};

export const logAuditMsg = (client, msg) => {
  safeSend(client, cfg('CH_AUDIT_LOG'), { content: `📝 ${msg}` });
  logEvent('audit', { title: 'Admin action', body: String(msg).slice(0, 1000) });
};

export const broadcastBigWin = (client, username, game, payout) => {
  const payload = { content: `🎉 **${username}** just won **${fmt(payout)}** on ${game}!` };
  safeSend(client, cfg('CH_CHAT'), payload);
  mirrorToAudit(client, cfg('CH_CHAT'), payload);
  logEvent('big_win', { title: `Big win on ${game}`, body: `${username} won ${fmt(payout)}`, amount: payout, meta: { game } });
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
  await safeSend(client, cfg('CH_WITHDRAW_REQUESTS'), payload);
  logEvent('withdraw_request', { title: 'Withdraw request', body: `${w.username || '—'} • ${isUpi ? 'UPI ' + w.upi_id : 'Bank'}`, discordId: w.discord_id, amount: w.amount, meta: { id: w.id } });
}

export async function botHeartbeat(client) {
  await safeSend(client, cfg('CH_BOT_STATUS'), { content: `✅ Bot online • ${new Date().toISOString()}` });
}
