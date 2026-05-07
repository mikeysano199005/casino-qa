import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Colors } from 'discord.js';
import { q } from '../db/index.js';
import { upsertUser, getWallet, applyTx, applyReferralCode, creditBonus, redeemPromoCode } from '../repo.js';
import { fmt } from '../util/money.js';

export function postPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('👤 Account')
      .setDescription('Profile, stats, daily reward, leaderboard, and referrals.')],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('account:profile').setLabel('Profile').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('account:stats').setLabel('My Stats').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('account:reward').setLabel('Daily Reward').setStyle(ButtonStyle.Success),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('account:leaderboard').setLabel('🏆 Leaderboard').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('account:referral').setLabel('🔗 My Referral').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('account:refcode').setLabel('Referral Code').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('account:promo').setLabel('🎟️ Promo Code').setStyle(ButtonStyle.Success),
      ),
    ],
  });
}

export async function handleInteraction(i) {
  if (i.isButton()) {
    const [, action] = i.customId.split(':');
    const u = await upsertUser(i.user.id, i.user.username);
    if (action === 'profile')     return showProfile(i, u);
    if (action === 'stats')       return showStats(i, u);
    if (action === 'reward')      return claimReward(i, u);
    if (action === 'leaderboard') return showLeaderboard(i);
    if (action === 'referral')    return showReferral(i, u);
    if (action === 'refcode')     return openRefModal(i);
    if (action === 'promo')       return openPromoModal(i);
  }
  if (i.isModalSubmit() && i.customId === 'account:refmodal') {
    const u = await upsertUser(i.user.id, i.user.username);
    return submitRefCode(i, u);
  }
  if (i.isModalSubmit() && i.customId === 'account:promomodal') {
    const u = await upsertUser(i.user.id, i.user.username);
    return submitPromoCode(i, u);
  }
}

async function showProfile(i, u) {
  const w = await getWallet(u.id);
  return i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('👤 Profile').addFields(
      { name: 'Discord',   value: `<@${i.user.id}>`, inline: true },
      { name: 'Joined',    value: `<t:${Math.floor(new Date(u.created_at).getTime()/1000)}:R>`, inline: true },
      { name: 'Status',    value: u.status, inline: true },
      { name: 'Available', value: fmt(w.available), inline: true },
      { name: 'Wagered',   value: fmt(w.total_wagered), inline: true },
      { name: 'Deposited', value: fmt(w.total_deposited), inline: true },
    )]});
}

async function showStats(i, u) {
  const { rows } = await q(
    `SELECT game, COUNT(*) c, COALESCE(SUM(stake),0) s, COALESCE(SUM(payout),0) p
     FROM bets WHERE user_id=$1 GROUP BY game ORDER BY c DESC`, [u.id]);
  const lines = rows.map(r => `**${r.game}** — ${r.c} bets • staked ${fmt(BigInt(r.s))} • paid ${fmt(BigInt(r.p))}`);
  return i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('📊 My Stats').setDescription(lines.join('\n') || 'No bets yet')] });
}

async function claimReward(i, u) {
  const { rows } = await q(
    `SELECT 1 FROM transactions WHERE user_id=$1 AND type='bonus'
      AND meta->>'kind'='daily' AND created_at > now() - interval '24 hours' LIMIT 1`, [u.id]);
  if (rows.length) return i.reply({ ephemeral: true, content: '⏳ Already claimed in the last 24h.' });
  const reward = 1000n; // ₹10
  await applyTx({ userId: u.id, type: 'bonus', amount: reward, ref: null, meta: { kind: 'daily' } });
  return i.reply({ ephemeral: true, content: `🎁 +${fmt(reward)} added!` });
}

async function showLeaderboard(i) {
  const { rows } = await q(
    `SELECT u.username, COALESCE(SUM(b.payout::bigint - b.stake::bigint), 0) AS net
     FROM bets b
     JOIN users u ON u.id = b.user_id
     WHERE b.result IN ('win','loss','push') AND b.settled_at IS NOT NULL
     GROUP BY u.username
     ORDER BY net DESC
     LIMIT 10`
  );
  if (!rows.length) return i.reply({ ephemeral: true, content: 'No data yet.' });
  const medals = ['🥇','🥈','🥉'];
  const lines = rows.map((r, idx) =>
    `${medals[idx] || `${idx + 1}.`} **${r.username}** — ${Number(r.net) >= 0 ? '+' : ''}${fmt(BigInt(r.net))}`
  );
  return i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold)
      .setTitle('🏆 Leaderboard — Top 10 by profit')
      .setDescription(lines.join('\n'))]
  });
}

async function showReferral(i, u) {
  const { rows: refRows } = await q(
    `SELECT COUNT(*) AS total, COALESCE(SUM(rb.amount),0) AS earned
     FROM referral_bonuses rb WHERE rb.referrer_id=$1`, [u.id]);
  const code = u.referral_code || '—';
  return i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🔗 Referral').addFields(
      { name: 'Your code',    value: `\`${code}\``,                       inline: true },
      { name: 'Referrals',    value: String(refRows[0]?.total ?? 0),       inline: true },
      { name: 'Total earned', value: fmt(BigInt(refRows[0]?.earned ?? 0)), inline: true },
    ).setDescription('Share your code. You earn **₹50** per friend who makes their first deposit.')]
  });
}

function openRefModal(i) {
  const m = new ModalBuilder().setCustomId('account:refmodal').setTitle('Enter referral code');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('code').setLabel('Referral code')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(8)
  ));
  return i.showModal(m);
}

async function submitRefCode(i, u) {
  const code = i.fields.getTextInputValue('code').trim();
  if (u.referred_by)
    return i.reply({ ephemeral: true, content: 'You already used a referral code.' });
  const ok = await applyReferralCode(u.id, code);
  if (!ok)
    return i.reply({ ephemeral: true, content: '❌ Invalid code or code is your own.' });
  return i.reply({ ephemeral: true, content: '✅ Referral code applied! Your friend earns ₹50 when you make your first deposit.' });
}

// ─── Promo codes ─────────────────────────────────────────────────────

function openPromoModal(i) {
  const m = new ModalBuilder().setCustomId('account:promomodal').setTitle('Redeem Promo Code');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('code').setLabel('Promo code')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
  ));
  return i.showModal(m);
}

async function submitPromoCode(i, u) {
  const code = i.fields.getTextInputValue('code').trim();
  const result = await redeemPromoCode(u.id, code);
  if (result.error === 'invalid')      return i.reply({ ephemeral: true, content: '❌ Code not found.' });
  if (result.error === 'expired')      return i.reply({ ephemeral: true, content: '❌ Code is expired or fully redeemed.' });
  if (result.error === 'already_used') return i.reply({ ephemeral: true, content: '❌ You already redeemed this code.' });

  const { promo } = result;
  const bonus = BigInt(promo.bonus_amount);
  await creditBonus(u.id, bonus, promo.wager_mult);

  return i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle('🎟️ Promo Redeemed!')
      .addFields(
        { name: 'Bonus credited', value: fmt(bonus),               inline: true },
        { name: 'Wager to unlock', value: fmt(bonus * BigInt(promo.wager_mult)), inline: true },
      )
      .setDescription(`Wager **${promo.wager_mult}×** the bonus amount to unlock it for withdrawal.\nYou can still bet with it right now!`)]
  });
}
