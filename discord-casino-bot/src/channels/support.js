import { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';

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

  const guild = i.guild;
  const ticketName = `ticket-${i.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  // Check for an existing open ticket channel for this user
  const existing = guild.channels.cache.find(c => c.name === ticketName);
  if (existing) {
    return i.editReply({ content: `You already have an open ticket: ${existing}` });
  }

  // Build permission overwrites: hidden from everyone, visible to user + bot + support role
  const overwrites = [
    { id: guild.roles.everyone.id,  deny:  [PermissionFlagsBits.ViewChannel] },
    {
      id: i.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: i.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];

  if (process.env.SUPPORT_ROLE_ID) {
    overwrites.push({
      id: process.env.SUPPORT_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  let ticketChannel;
  try {
    ticketChannel = await guild.channels.create({
      name: ticketName,
      type: ChannelType.GuildText,
      parent: process.env.TICKET_CATEGORY_ID || null,
      permissionOverwrites: overwrites,
      reason: `Support ticket for ${i.user.tag}`,
    });
  } catch (e) {
    console.error('[support:ticket]', e);
    return i.editReply({ content: '⚠️ Could not create ticket channel. Make sure the bot has **Manage Channels** permission.' });
  }

  const roleText = process.env.SUPPORT_ROLE_ID ? `<@&${process.env.SUPPORT_ROLE_ID}>` : '';
  await ticketChannel.send({
    content: `<@${i.user.id}>${roleText ? ` ${roleText}` : ''}`,
    embeds: [new EmbedBuilder().setColor(Colors.Blue)
      .setTitle('🎫 Support Ticket')
      .setDescription(`Hello <@${i.user.id}>! Describe your issue and a moderator will assist you shortly.\n\nClick **Close Ticket** when your issue is resolved.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('support:close').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger),
    )],
  });

  return i.editReply({ content: `✅ Ticket opened: ${ticketChannel}` });
}

async function closeTicket(i) {
  await i.deferReply();

  const channel = i.channel ?? await i.client.channels.fetch(i.channelId).catch(() => null);
  if (!channel?.name?.startsWith('ticket-')) {
    return i.editReply({ content: 'Use this inside a ticket channel.' });
  }

  await i.editReply({ content: `🔒 Ticket closed by <@${i.user.id}>. This channel will be deleted in 5 seconds.` });
  setTimeout(() => channel.delete().catch(() => {}), 5_000);
}
