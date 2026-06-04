import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Colors } from 'discord.js';
import { signPlayToken } from '../web/play.js';

export function postPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎮 Play')
      .setDescription('Tap a game to start. All gameplay is button + modal driven — no chat spam.\n\n✈ **Aviator** is playable on the web — tap **Play on Web** for a private one-tap link.')],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('launch:colour').setLabel('🎨 Colour').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('launch:crash').setLabel('🚀 Crash').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('launch:mines').setLabel('💣 Mines').setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('launch:dice').setLabel('🎲 Dice').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('launch:blackjack').setLabel('🃏 Blackjack').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('launch:slots').setLabel('🎰 Slots').setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('launch:web').setLabel('🌐 Play Aviator on Web').setStyle(ButtonStyle.Success),
      ),
    ],
  });
}

export async function handleInteraction(i) {
  if (!i.isButton()) return;
  const [, game] = i.customId.split(':');

  if (game === 'web') {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    if (!base) return i.reply({ ephemeral: true, content: '⚠️ Web play is not configured (PUBLIC_BASE_URL missing).' });
    const url = `${base}/play?t=${signPlayToken(i.user.id, i.user.username)}`;
    return i.reply({
      ephemeral: true,
      content: '✈ **Aviator — Play on Web**\nTap below to open the game. This private link logs you in automatically and uses your real wallet.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🌐 Open Aviator').setStyle(ButtonStyle.Link).setURL(url),
      )],
    });
  }

  await i.reply({ ephemeral: true, content: `Open the dedicated channel or use the panel below for **${game}**.` });
}
