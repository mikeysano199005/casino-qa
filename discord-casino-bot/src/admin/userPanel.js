import {
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, logAudit } from '../repo.js';
import { fmt } from '../util/money.js';

const VIP_NAMES = ['None', '🥉 Bronze', '🥈 Silver', '🥇 Gold', '💎 Platinum'];

const adminIds = () => (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdmin  = (id) => adminIds().includes(id);

export async function handleUserPanelInteraction(i) {
  if (!isAdmin(i.user.id)) return i.reply({ ephemeral: true, content: 'Not authorised.' });

  if (i.isButton()) {
    const [, action, ...rest] = i.customId.split(':');
    if (action === 'lookup')  return openLookupModal(i);
    if (action === 'direct')  return showUserPanel(i, rest[0], false); // one-tap from bet logs
    if (action === 'refresh') return showUserPanel(i, rest[0], true);
    if (action === 'credit')  return openCreditModal(i, rest[0]);
    if (action === 'debit')   return openDebitModal(i, rest[0]);
    if (action === 'ban')     return toggleBan(i, rest[0]);
    if (action === 'setvip')  return openVipModal(i, rest[0]);
  }
  if (i.isModalSubmit()) {
    const [, action, ...rest] = i.customId.split(':');
    if (action === 'lookupmodal') return handleLookup(i);
    if (action === 'creditmodal') return processCredit(i, rest[0]);
    if (action === 'debitmodal')  return processDebit(i, rest[0]);
    if (action === 'vipmodal')    return processVip(i, rest[0]);
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
      { name: 'Internal ID',   value: `\`${u.id}\``,                   inline: false },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`userpanel:credit:${u.id}`).setLabel('💸 Credit').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`userpanel:debit:${u.id}`).setLabel('📤 Debit').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`userpanel:ban:${u.id}`).setLabel(u.status === 'banned' ? '✅ Unban' : '🚫 Ban')
      .setStyle(u.status === 'banned' ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`userpanel:setvip:${u.id}`).setLabel('⭐ VIP').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`userpanel:refresh:${discordId}`).setLabel('🔄').setStyle(ButtonStyle.Secondary),
  );

  const payload = { ephemeral: true, embeds: [embed], components: [row] };
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
  await i.reply({ ephemeral: true, content: `User is now **${newStatus}**.` });
  try {
    const dUser = await i.client.users.fetch(rows[0].discord_id);
    await dUser.send(newStatus === 'banned'
      ? '🚫 Your account has been suspended. Contact support if you believe this is a mistake.'
      : '✅ Your account has been reinstated. You may now play again.'
    );
  } catch {}
}

// ─── VIP tier ────────────────────────────────────────────────────────

function openVipModal(i, userId) {
  const m = new ModalBuilder().setCustomId(`userpanel:vipmodal:${userId}`).setTitle('Set VIP Tier');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('tier')
      .setLabel('Tier: 0=None  1=Bronze  2=Silver  3=Gold  4=Platinum')
      .setStyle(TextInputStyle.Short).setRequired(true).setValue('1').setMaxLength(1)
  ));
  return i.showModal(m);
}

async function processVip(i, userId) {
  const tier = Math.min(4, Math.max(0, Math.floor(Number(i.fields.getTextInputValue('tier')))));
  await q(`UPDATE users SET vip_tier = $1 WHERE id = $2`, [tier, userId]);
  await logAudit(i.user.id, 'admin_set_vip', userId, null, { vip_tier: tier });
  return i.reply({ ephemeral: true, content: `✅ VIP tier set to **${VIP_NAMES[tier]}**.` });
}
