import { EmbedBuilder, Colors } from 'discord.js';
import { q } from '../db/index.js';

export async function checkAndSendWelcome(client, discordUser) {
  // Atomic: only runs once per user (welcome_sent = FALSE → TRUE)
  const { rows } = await q(
    `UPDATE users SET welcome_sent = TRUE
     WHERE discord_id = $1 AND welcome_sent = FALSE
     RETURNING referral_code`,
    [discordUser.id]
  );
  if (!rows[0]) return;

  const code = rows[0].referral_code || '—';
  const embed = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('👋 Welcome to the Casino!')
    .setDescription([
      '**Quick start:**',
      '• 💳 **#wallet** — Deposit (min ₹100), withdraw, check balance',
      '• 🎮 **#play** — All games below',
      '• 👤 **#account** — Claim daily ₹10 reward, referrals',
      '',
      '**Games:**',
      '🎨 Colour (2× / 8×) • 🚀 Crash • 💣 Mines • 🎲 Dice • 🃏 Blackjack • 🎰 Slots',
      '',
      '**Your referral code:**',
      `\`\`\`${code}\`\`\``,
      'Share it — you earn **₹50** when a friend makes their first deposit.',
      '',
      '> Min bet ₹10 • All bets are provably fair via HMAC-SHA256',
    ].join('\n'));

  try {
    await discordUser.send({ embeds: [embed] });
  } catch {
    // User has DMs disabled — silently skip
  }
}

// Fires on first interaction after being away 7+ days.
// Uses last_seen (which upsertUser does not update) so the old value is still
// readable here even though upsertUser already ran earlier in the request.
export async function checkAndSendWelcomeBack(client, discordUser) {
  const { rows } = await q(
    `UPDATE users SET last_seen = NOW()
     WHERE discord_id = $1
       AND welcome_sent = TRUE
       AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL '7 days')
     RETURNING id`,
    [discordUser.id]
  );
  if (!rows[0]) return;

  const { rows: w } = await q(`SELECT available FROM wallets WHERE user_id = $1`, [rows[0].id]);
  const balance = w[0] ? (Number(BigInt(w[0].available)) / 100).toFixed(2) : '0.00';

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('👋 Welcome back!')
    .setDescription([
      'Your account is safe — nothing was lost.',
      '',
      `💰 **Balance: ₹${balance}**`,
      '',
      'Head to the casino channels to keep playing!',
    ].join('\n'));

  discordUser.send({ embeds: [embed] }).catch(() => {});
}
