import { SlashCommandBuilder } from 'discord.js';
import { q } from '../db/index.js';
import { upsertUser, applyTx, logAudit } from '../repo.js';
import { fmt, toPaise } from '../util/money.js';

export const command = new SlashCommandBuilder()
  .setName('addbal')
  .setDescription('Admin: add balance to a user')
  .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
  .addIntegerOption(o => o.setName('amount').setDescription('Amount in ₹').setRequired(true).setMinValue(1));

export async function handleCommand(i) {
  const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim());
  if (!adminIds.includes(i.user.id))
    return i.reply({ ephemeral: true, content: '🚫 Admin only.' });

  await i.deferReply({ ephemeral: true });

  const target = i.options.getUser('user');
  const rupees = i.options.getInteger('amount');
  const paise  = toPaise(rupees);

  const u = await upsertUser(target.id, target.username);

  await applyTx({
    userId: u.id, type: 'deposit', amount: paise,
    ref: null, meta: { provider: 'admin_grant', by: i.user.id },
  });

  await logAudit(i.user.id, 'admin_addbal', u.id, null, { amount: paise.toString() });

  const { rows } = await q(`SELECT available FROM wallets WHERE user_id=$1`, [u.id]);
  await i.editReply({
    content: `✅ Added **${fmt(paise)}** to **${target.username}**.\nNew balance: **${fmt(BigInt(rows[0].available))}**`,
  });
}
