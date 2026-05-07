import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Colors } from 'discord.js';

export function postPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎮 Play')
      .setDescription('Tap a game to start. All gameplay is button + modal driven — no chat spam.')],
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
    ],
  });
}

export async function handleInteraction(i) {
  if (!i.isButton()) return;
  const [, game] = i.customId.split(':');
  await i.reply({ ephemeral: true, content: `Open the dedicated channel or use the panel below for **${game}**.` });
}
