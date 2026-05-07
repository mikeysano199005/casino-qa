import { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';

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
          '**Need help?** Click the button below to open a private support ticket.',
        ].join('\n'))
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('support:ticket').setLabel('🎫 Create Ticket').setStyle(ButtonStyle.Primary),
      ),
    ],
  });
}

export async function handleInteraction(i) {
  if (i.isButton()) {
    const [, action] = i.customId.split(':');
    if (action === 'ticket') return createTicket(i);
    if (action === 'close')  return closeTicket(i);
  }
}

async function createTicket(i) {
  await i.deferReply({ ephemeral: true });

  // Check for an existing open ticket from this user in this channel
  const active = await i.channel.threads.fetchActive().catch(() => null);
  if (active) {
    const existing = active.threads.find(t =>
      t.name === `ticket-${i.user.username}` && !t.archived
    );
    if (existing) {
      return i.editReply({ content: `You already have an open ticket: ${existing}` });
    }
  }

  let thread;
  try {
    thread = await i.channel.threads.create({
      name: `ticket-${i.user.username}`,
      type: ChannelType.PrivateThread,
      reason: `Support ticket for ${i.user.tag}`,
    });
  } catch {
    // Fallback to public thread if private threads aren't available
    try {
      thread = await i.channel.threads.create({
        name: `ticket-${i.user.username}`,
        type: ChannelType.PublicThread,
        reason: `Support ticket for ${i.user.tag}`,
      });
    } catch (e) {
      console.error('[support:ticket]', e);
      return i.editReply({ content: '⚠️ Could not create ticket thread. Make sure the bot has Manage Threads permission.' });
    }
  }

  await thread.members.add(i.user.id).catch(() => {});

  const roleText = process.env.SUPPORT_ROLE_ID ? `<@&${process.env.SUPPORT_ROLE_ID}>` : '';
  await thread.send({
    content: `<@${i.user.id}>${roleText ? ` ${roleText}` : ''}`,
    embeds: [new EmbedBuilder().setColor(Colors.Blue)
      .setTitle('🎫 Support Ticket')
      .setDescription(`Hello <@${i.user.id}>! Describe your issue and a moderator will assist you shortly.\n\nClick **Close Ticket** when resolved.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('support:close').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger),
    )],
  });

  return i.editReply({ content: `✅ Ticket created: ${thread}` });
}

async function closeTicket(i) {
  if (!i.channel.isThread()) return i.reply({ ephemeral: true, content: 'Use this inside a ticket thread.' });
  await i.reply({ content: `🔒 Ticket closed by <@${i.user.id}>.` });
  await i.channel.setArchived(true).catch(() => {});
}
