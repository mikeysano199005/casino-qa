import {
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, logAudit } from '../repo.js';
import { fmt } from '../util/money.js';
import { logAuditMsg } from './logs.js';

const VIP_NAMES = ['None', '🥉 Bronze', '🥈 Silver', '🥇 Gold', '💎 Platinum'];

const adminIds = () => (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdmin  = (id) => adminIds().includes(id);

export async function handleUserPanelInteraction(i) {
  if (!isAdmin(i.user.id)) return i.reply({ ephemeral: true, content: 'Not authorised.' });

  if (i.isButton()) {
    const [, action, ...rest] = i.customId.split(':');
    if (action === 'lookup')            return openLookupModal(i);
    if (action === 'direct')            return showUserPanel(i, rest[0], false); // one-tap from bet logs
    if (action === 'refresh')           return showUserPanel(i, rest[0], true);
    if (action === 'credit')            return openCreditModal(i, rest[0]);
    if (action === 'debit')             return openDebitModal(i, rest[0]);
    if (action === 'ban')               return toggleBan(i, rest[0]);
    if (action === 'setvip')            return openVipModal(i, rest[0]);
    if (action === 'bethistory')        return showBetHistory(i, rest[0], Number(rest[1] ?? 0));
    if (action === 'bethistorylookup')  return openBetHistoryLookupModal(i);
    if (action === 'userpreset')        return showUserPresetMenu(i, rest[0]);
    if (action === 'applyuserpreset')   return applyUserPreset(i, rest[0], rest[1]);
    if (action === 'setcooldown')       return openSetCooldownModal(i, rest[0]);
    if (action === 'resetcooldown')     return resetCooldown(i, rest[0]);
  }
  if (i.isModalSubmit()) {
    const [, action, ...rest] = i.customId.split(':');
    if (action === 'lookupmodal')       return handleLookup(i);
    if (action === 'creditmodal')       return processCredit(i, rest[0]);
    if (action === 'debitmodal')        return processDebit(i, rest[0]);
    if (action === 'vipmodal')          return processVip(i, rest[0]);
    if (action === 'bethistorymodal')   return handleBetHistoryLookup(i);
    if (action === 'setcooldownmodal')  return processSetCooldown(i, rest[0]);
  }
}

// ─── Lookup ──────────────────────────────────────────────────────────

function openLookupModal(i) {
  const m = new ModalBuilder().setCustomId('userpanel:lookupmodal').setTitle('User Lookup');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('discordId').setLabel('Discord User ID (18-19 digit snowflake)')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
  ));
  return i.showModal(m);
}

async function handleLookup(i) {
  const discordId = i.fields.getTextInputValue('discordId').trim();
  return showUserPanel(i, discordId, false);
}

async function showUserPanel(i, discordId, isRefresh) {
  const { rows } = await q(
    `SELECT u.*, w.available, w.locked, w.total_wagered, w.total_deposited,
            w.total_withdrawn, w.bonus_balance, w.wager_pending
     FROM users u JOIN wallets w ON w.user_id = u.id
     WHERE u.discord_id = $1`,
    [discordId]
  );

  if (!rows[0]) {
    const msg = { ephemeral: true, content: `No user found with ID \`${discordId}\`.` };
    return isRefresh ? i.update(msg) : i.reply(msg);
  }
  const u = rows[0];

  const { rows: [stats] } = await q(
    `SELECT COUNT(*) c,
            COALESCE(SUM(payout::bigint - stake::bigint), 0) net
     FROM bets WHERE user_id = $1 AND result != 'pending'`,
    [u.id]
  );

  const net = Number(stats.net);
  const withdrawable = BigInt(u.available) - BigInt(u.locked) - BigInt(u.bonus_balance);

  const embed = new EmbedBuilder()
    .setColor(
      u.status === 'banned'  ? Colors.Red    :
      u.status === 'flagged' ? Colors.Orange : Colors.Green
    )
    .setTitle(`👤 ${u.username}`)
    .addFields(
      { name: 'Discord',       value: `<@${u.discord_id}>`,            inline: true  },
      { name: 'Status',        value: u.status,                        inline: true  },
      { name: 'VIP',           value: VIP_NAMES[u.vip_tier] || 'None', inline: true  },
      { name: 'Available',     value: fmt(BigInt(u.available)),         inline: true  },
      { name: 'Locked',        value: fmt(BigInt(u.locked)),            inline: true  },
      { name: 'Withdrawable',  value: fmt(withdrawable < 0n ? 0n : withdrawable), inline: true },
      { name: 'Bonus locked',  value: fmt(BigInt(u.bonus_balance)),     inline: true  },
      { name: 'Wager needed',  value: fmt(BigInt(u.wager_pending)),     inline: true  },
      { name: 'Deposited',     value: fmt(BigInt(u.total_deposited)),   inline: true  },
      { name: 'Withdrawn',     value: fmt(BigInt(u.total_withdrawn)),   inline: true  },
      { name: 'Wagered',       value: fmt(BigInt(u.total_wagered)),     inline: true  },
      { name: 'Bets / net',    value: `${stats.c} bets • ${net >= 0 ? '+' : ''}${fmt(BigInt(stats.net))}`, inline: true },
      { name: 'Joined',        value: `<t:${Math.floor(new Date(u.created_at).getTime() / 1000)}:R>`, inline: true },
      { name: 'Withdraw CD',   value: u.withdraw_cooldown_until && new Date(u.withdraw_cooldown_until) > new Date()
          ? `<t:${Math.floor(new Date(u.withdraw_cooldown_until).getTime() / 1000)}:R>` : 'None', inline: true },
      { name: 'CD Override',   value: u.withdraw_cooldown_hours != null ? `${u.withdraw_cooldown_hours}h` : 'Global default', inline: true },
      { name: 'Internal ID',   value: `\`${u.id}\``,                   inline: false },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`userpanel:credit:${u.id}`).setLabel('💸 Credit').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`userpanel:debit:${u.id}`).setLabel('📤 Debit').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`userpanel:ban:${u.id}`).setLabel(u.status === 'banned' ? '✅ Unban' : '🚫 Ban')
      .setStyle(u.status === 'banned' ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`userpanel:setvip:${u.id}`).setLabel('⭐ VIP').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`userpanel:refresh:${discordId}`).setLabel('🔄').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`userpanel:bethistory:${u.id}:0`).setLabel('📜 Bet History').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`userpanel:userpreset:${u.id}`).setLabel('🎯 User Preset').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`userpanel:setcooldown:${u.id}`).setLabel('⏱️ Set Cooldown').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`userpanel:resetcooldown:${u.id}`).setLabel('🔓 Reset CD').setStyle(ButtonStyle.Danger),
  );

  const payload = { ephemeral: true, embeds: [embed], components: [row1, row2] };
  return isRefresh ? i.update(payload) : i.reply(payload);
}

// ─── Credit ──────────────────────────────────────────────────────────

function openCreditModal(i, userId) {
  const m = new ModalBuilder().setCustomId(`userpanel:creditmodal:${userId}`).setTitle('Credit Balance');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('amount').setLabel('Amount in ₹')
        .setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reason').setLabel('Reason (shown in audit log)')
        .setStyle(TextInputStyle.Short).setRequired(true)
    ),
  );
  return i.showModal(m);
}

async function processCredit(i, userId) {
  const amount = Number(i.fields.getTextInputValue('amount'));
  const reason = i.fields.getTextInputValue('reason').trim();
  if (!Number.isFinite(amount) || amount <= 0)
    return i.reply({ ephemeral: true, content: 'Invalid amount.' });
  const paise = BigInt(Math.round(amount * 100));
  await applyTx({ userId, type: 'adjust', amount: paise, ref: null, meta: { reason, admin: i.user.id } });
  await logAudit(i.user.id, 'admin_credit', userId, null, { amount: paise.toString(), reason });
  logAuditMsg(i.client, `💸 Admin **credit** **${fmt(paise)}** to user \`${userId}\` by <@${i.user.id}> — ${reason}`);
  return i.reply({ ephemeral: true, content: `✅ Credited **${fmt(paise)}** to user.\nReason: ${reason}` });
}

// ─── Debit ───────────────────────────────────────────────────────────

function openDebitModal(i, userId) {
  const m = new ModalBuilder().setCustomId(`userpanel:debitmodal:${userId}`).setTitle('Debit Balance');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('amount').setLabel('Amount in ₹')
        .setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reason').setLabel('Reason (shown in audit log)')
        .setStyle(TextInputStyle.Short).setRequired(true)
    ),
  );
  return i.showModal(m);
}

async function processDebit(i, userId) {
  const amount = Number(i.fields.getTextInputValue('amount'));
  const reason = i.fields.getTextInputValue('reason').trim();
  if (!Number.isFinite(amount) || amount <= 0)
    return i.reply({ ephemeral: true, content: 'Invalid amount.' });
  const paise = BigInt(Math.round(amount * 100));
  try {
    await applyTx({ userId, type: 'adjust', amount: -paise, ref: null, meta: { reason, admin: i.user.id } });
  } catch {
    return i.reply({ ephemeral: true, content: '💸 User has insufficient balance for this debit.' });
  }
  await logAudit(i.user.id, 'admin_debit', userId, null, { amount: paise.toString(), reason });
  logAuditMsg(i.client, `📤 Admin **debit** **${fmt(paise)}** from user \`${userId}\` by <@${i.user.id}> — ${reason}`);
  return i.reply({ ephemeral: true, content: `✅ Debited **${fmt(paise)}** from user.\nReason: ${reason}` });
}

// ─── Ban / Unban ─────────────────────────────────────────────────────

async function toggleBan(i, userId) {
  const { rows } = await q(`SELECT status, discord_id FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return i.reply({ ephemeral: true, content: 'User not found.' });
  const newStatus = rows[0].status === 'banned' ? 'active' : 'banned';
  await q(`UPDATE users SET status = $1 WHERE id = $2`, [newStatus, userId]);
  await logAudit(i.user.id, newStatus === 'banned' ? 'admin_ban' : 'admin_unban', userId,
    { status: rows[0].status }, { status: newStatus });
  logAuditMsg(i.client, `${newStatus === 'banned' ? '🚫 **Banned**' : '✅ **Unbanned**'} user \`${userId}\` (<@${rows[0].discord_id}>) by <@${i.user.id}>`);
  await i.reply({ ephemeral: true, content: `User is now **${newStatus}**.` });
  try {
    const dUser = await i.client.users.fetch(rows[0].discord_id);
    await dUser.send(newStatus === 'banned'
      ? '🚫 Your account has been suspended. Contact support if you believe this is a mistake.'
      : '✅ Your account has been reinstated. You may now play again.'
    );
  } catch {}
}

// ─── User Preset ─────────────────────────────────────────────────────

async function showUserPresetMenu(i, userId) {
  const { rows } = await q(`SELECT username, user_preset FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return i.reply({ ephemeral: true, content: 'User not found.' });
  const current = rows[0].user_preset || 'none (uses game default)';

  const PRESETS = ['house', 'low', 'medium', 'high', 'extreme'];
  const STYLES = {
    house: ButtonStyle.Secondary,
    low:   ButtonStyle.Success,
    medium:ButtonStyle.Primary,
    high:  ButtonStyle.Danger,
    extreme: ButtonStyle.Danger,
  };

  const row1 = new ActionRowBuilder().addComponents(
    ...PRESETS.map(p => new ButtonBuilder()
      .setCustomId(`userpanel:applyuserpreset:${userId}:${p}`)
      .setLabel(p.charAt(0).toUpperCase() + p.slice(1))
      .setStyle(STYLES[p])
    )
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`userpanel:applyuserpreset:${userId}:clear`)
      .setLabel('🗑️ Clear (use game default)')
      .setStyle(ButtonStyle.Secondary),
  );

  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold)
      .setTitle(`🎯 User Preset — ${rows[0].username}`)
      .setDescription(`Current: **${current}**\n\nSelect a preset to lock this user to it across all per-bet games (Dice, Slots, Blackjack, Mines). Clear to revert to game defaults.`)],
    components: [row1, row2],
  });
}

async function applyUserPreset(i, userId, preset) {
  const isClear = preset === 'clear';
  await q(`UPDATE users SET user_preset = $1 WHERE id = $2`, [isClear ? null : preset, userId]);
  const { rows } = await q(`SELECT username FROM users WHERE id = $1`, [userId]);
  await logAudit(i.user.id, 'admin_set_user_preset', userId, null, { preset: isClear ? null : preset });
  logAuditMsg(i.client, `🎯 User preset for **${rows[0]?.username}** set to **${isClear ? 'cleared' : preset}** by <@${i.user.id}>`);
  await i.reply({ ephemeral: true,
    content: isClear
      ? `✅ User preset cleared for **${rows[0]?.username}** — they will use game defaults.`
      : `✅ **${rows[0]?.username}** is now locked to **${preset}** preset.`,
  });
}

// ─── Bet History ─────────────────────────────────────────────────────

function openBetHistoryLookupModal(i) {
  const m = new ModalBuilder().setCustomId('userpanel:bethistorymodal').setTitle('Bet History Lookup');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('discordId').setLabel('Discord User ID (18-19 digit snowflake)')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
  ));
  return i.showModal(m);
}

async function handleBetHistoryLookup(i) {
  const discordId = i.fields.getTextInputValue('discordId').trim();
  const { rows } = await q(`SELECT id FROM users WHERE discord_id = $1`, [discordId]);
  if (!rows[0]) return i.reply({ ephemeral: true, content: `No user found with ID \`${discordId}\`.` });
  await showBetHistory(i, rows[0].id, 0, false);
}

async function showBetHistory(i, userId, page) {
  const PAGE = 10;
  const offset = page * PAGE;

  const { rows: bets } = await q(
    `SELECT game, stake, payout, result, settled_at
     FROM bets
     WHERE user_id = $1 AND result != 'pending'
     ORDER BY settled_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, PAGE + 1, offset]
  );

  const hasNext = bets.length > PAGE;
  const pageBets = bets.slice(0, PAGE);

  const { rows: uRow } = await q(`SELECT username FROM users WHERE id = $1`, [userId]);
  const username = uRow[0]?.username ?? userId;

  const lines = pageBets.map(b => {
    const stake  = fmt(BigInt(b.stake));
    const payout = fmt(BigInt(b.payout || 0));
    const icon   = b.result === 'win' ? '✅' : b.result === 'push' ? '↔️' : '❌';
    const time   = b.settled_at ? `<t:${Math.floor(new Date(b.settled_at).getTime() / 1000)}:d>` : '—';
    const game   = b.game.charAt(0).toUpperCase() + b.game.slice(1);
    return `${icon} **${game}** • Stake ${stake} • Payout ${payout} • ${time}`;
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`📜 Bet History — ${username}`)
    .setDescription(lines.join('\n') || 'No bets found.')
    .setFooter({ text: `Page ${page + 1} • Showing ${offset + 1}–${offset + pageBets.length}` });

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`userpanel:bethistory:${userId}:${page - 1}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`userpanel:bethistory:${userId}:${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasNext),
  );

  await i.reply({ ephemeral: true, embeds: [embed], components: [nav] });
}

// ─── Withdraw Cooldown Override ──────────────────────────────────────

function openSetCooldownModal(i, userId) {
  const m = new ModalBuilder().setCustomId(`userpanel:setcooldownmodal:${userId}`).setTitle('Set Withdraw Cooldown');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('hours')
      .setLabel('Cooldown hours (0 = no cooldown, blank = global default)')
      .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5)
      .setPlaceholder(`Global default: ${process.env.WITHDRAW_COOLDOWN_HOURS || 48}h`)
  ));
  return i.showModal(m);
}

async function processSetCooldown(i, userId) {
  const raw = i.fields.getTextInputValue('hours').trim();
  const { rows } = await q(`SELECT username, discord_id FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return i.reply({ ephemeral: true, content: 'User not found.' });

  if (raw === '') {
    await q(`UPDATE users SET withdraw_cooldown_hours = NULL WHERE id = $1`, [userId]);
    await logAudit(i.user.id, 'admin_cooldown_override', userId, null, { hours: null });
    logAuditMsg(i.client, `⏱️ Withdraw cooldown for **${rows[0].username}** reset to global default by <@${i.user.id}>`);
    return i.reply({ ephemeral: true, content: `✅ Cooldown for **${rows[0].username}** reset to global default.` });
  }

  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0)
    return i.reply({ ephemeral: true, content: 'Enter a valid number of hours (0 or more), or leave blank to use global default.' });

  await q(`UPDATE users SET withdraw_cooldown_hours = $1 WHERE id = $2`, [hours, userId]);
  await logAudit(i.user.id, 'admin_cooldown_override', userId, null, { hours });
  logAuditMsg(i.client, `⏱️ Withdraw cooldown for **${rows[0].username}** set to **${hours}h** by <@${i.user.id}>`);
  return i.reply({ ephemeral: true,
    content: hours === 0
      ? `✅ **${rows[0].username}** can now withdraw with **no cooldown**.`
      : `✅ **${rows[0].username}** will have a **${hours}h** cooldown after each withdrawal.`,
  });
}

async function resetCooldown(i, userId) {
  const { rows } = await q(`SELECT username, discord_id FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return i.reply({ ephemeral: true, content: 'User not found.' });
  await q(`UPDATE users SET withdraw_cooldown_until = NULL WHERE id = $1`, [userId]);
  await logAudit(i.user.id, 'admin_reset_cooldown', userId, null, {});
  logAuditMsg(i.client, `🔓 Active withdraw cooldown cleared for **${rows[0].username}** by <@${i.user.id}>`);
  return i.reply({ ephemeral: true, content: `✅ Cooldown cleared — **${rows[0].username}** can withdraw immediately.` });
}

// ─── VIP tier ────────────────────────────────────────────────────────

function openVipModal(i, userId) {
  const m = new ModalBuilder().setCustomId(`userpanel:vipmodal:${userId}`).setTitle('Set VIP Tier');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('tier')
      .setLabel('0=None 1=Bronze 2=Silver 3=Gold 4=Platinum')
      .setStyle(TextInputStyle.Short).setRequired(true).setValue('1').setMaxLength(1)
  ));
  return i.showModal(m);
}

async function processVip(i, userId) {
  const tier = Math.min(4, Math.max(0, Math.floor(Number(i.fields.getTextInputValue('tier')))));
  await q(`UPDATE users SET vip_tier = $1 WHERE id = $2`, [tier, userId]);
  await logAudit(i.user.id, 'admin_set_vip', userId, null, { vip_tier: tier });
  logAuditMsg(i.client, `⭐ VIP tier for user \`${userId}\` set to **${VIP_NAMES[tier]}** by <@${i.user.id}>`);
  return i.reply({ ephemeral: true, content: `✅ VIP tier set to **${VIP_NAMES[tier]}**.` });
}
