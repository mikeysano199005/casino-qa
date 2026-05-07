import { EmbedBuilder, Colors } from 'discord.js';

export function postPanel(channel) {
  return channel.send({
    embeds: [
      new EmbedBuilder().setColor(Colors.Gold).setTitle('🛟 Support & Rules')
        .setDescription([
          '**How it works**',
          '• 18+ only. Play responsibly.',
          '• All wallet ops use atomic Postgres transactions.',
          '• Each round publishes a server-seed hash *before* the round starts.',
          '• After each round the server seed is revealed for verification.',
          '',
          '**Limits**',
          `• Min bet ₹${process.env.MIN_BET || 10} • Max bet ₹${process.env.MAX_BET || 10000}`,
          `• Min deposit ₹${process.env.MIN_DEPOSIT || 100} • Min withdraw ₹${process.env.MIN_WITHDRAW || 200}`,
          `• Withdraw cooldown ${process.env.WITHDRAW_COOLDOWN_HOURS || 24}h.`,
          '',
          '**Need help?** Contact a moderator in this channel.',
        ].join('\n'))
    ]
  });
}

export async function handleInteraction() { /* no-op */ }
