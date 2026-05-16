import {
  SlashCommandBuilder, ModalBuilder, ActionRowBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { q } from '../db/index.js';
import { toPaise } from '../util/money.js';
import { createPayOrder } from '../util/watchpay.js';

export const command = new SlashCommandBuilder()
  .setName('pay')
  .setDescription('Create a payment link for a buyer in this ticket');

export async function handleCommand(i) {
  const adminIds = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim());
  if (!adminIds.includes(i.user.id))
    return i.reply({ ephemeral: true, content: '🚫 Admin only.' });

  const modal = new ModalBuilder()
    .setCustomId('pay:create')
    .setTitle('Create Payment Link');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('Buyer Name')
        .setStyle(TextInputStyle.Short).setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('phone').setLabel('Buyer Phone (10 digits)')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('9876543210'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('amount').setLabel('Amount (₹)')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 500'),
    ),
  );
  return i.showModal(modal);
}

export async function handleModal(i) {
  await i.deferReply({ ephemeral: true });

  const name   = i.fields.getTextInputValue('name').trim();
  const phone  = i.fields.getTextInputValue('phone').trim();
  const amount = Number(i.fields.getTextInputValue('amount'));

  if (!Number.isFinite(amount) || amount < 1)
    return i.editReply({ content: '❌ Enter a valid amount.' });
  if (!/^\d{10}$/.test(phone))
    return i.editReply({ content: '❌ Phone must be exactly 10 digits.' });

  const orderId = `sale_${Date.now()}`;
  const base    = process.env.PUBLIC_BASE_URL;

  try {
    const payUrl = await createPayOrder({
      orderId,
      amountRupees: amount,
      notifyUrl:    `${base}/watchpay/webhook`,
      pageUrl:      `${base}/payment-done`,
      goodsName:    `Sale - ${name}`.slice(0, 50),
    });

    await q(
      `INSERT INTO cheat_sales(cashfree_order_id, buyer_name, buyer_phone, amount, ticket_channel_id)
       VALUES($1,$2,$3,$4,$5)`,
      [orderId, name, phone, toPaise(amount).toString(), i.channelId],
    );

    await i.channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x00C851)
        .setTitle('💳 Payment Request')
        .setDescription('Click **Pay Now** to complete payment.')
        .addFields(
          { name: '👤 Buyer',  value: `\`${name}\``,    inline: true },
          { name: '💰 Amount', value: `**₹${amount}**`, inline: true },
          { name: '📋 Status', value: '⏳ Pending',      inline: true },
        )
        .setFooter({ text: '✅ Payment confirmed here automatically once complete' })
        .setTimestamp()
      ],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(`Pay ₹${amount} Now`)
          .setStyle(ButtonStyle.Link)
          .setURL(payUrl)
          .setEmoji('💳'),
      )],
    });

    await i.editReply({ content: '✅ Payment link posted in this channel.' });
  } catch (e) {
    console.error('[/pay]', e.message);
    await i.editReply({ content: '⚠️ Could not create payment link — try again later.' });
  }
}
