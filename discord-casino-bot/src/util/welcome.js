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
