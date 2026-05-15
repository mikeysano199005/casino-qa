import {
  SlashCommandBuilder, ModalBuilder, ActionRowBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import axios from 'axios';
import { q } from '../db/index.js';
import { toPaise } from '../util/money.js';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS  = 30 * 60 * 1000; // 30 minutes

export const command = new SlashCommandBuilder()
  .setName('pay')
  .setDescription('Create a Cashfree payment link for a buyer in this ticket');

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
  const env     = process.env.CASHFREE_ENV === 'prod' ? 'api.cashfree.com' : 'sandbox.cashfree.com';
  const base    = process.env.PUBLIC_BASE_URL;
  const headers = {
    'x-api-version':   '2023-08-01',
    'x-client-id':     process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'Content-Type':    'application/json',
  };

  try {
    const res = await axios.post(`https://${env}/pg/orders`, {
      order_id:       orderId,
      order_amount:   amount,
      order_currency: 'INR',
      customer_details: {
        customer_id:    `buyer_${Date.now()}`,
        customer_name:  name,
        customer_email: `buyer@ticket.local`,
        customer_phone: phone,
      },
      order_meta: {
        return_url: `${base}/payment-done`,
        notify_url: `${base}/cashfree/webhook`,
      },
    }, { headers });

    const link = `${base}/pay?session_id=${res.data.payment_session_id}`;

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
          .setURL(link)
          .setEmoji('💳'),
      )],
    });

    await i.editReply({ content: '✅ Payment link posted in this channel.' });

    // Start polling — fires every 5s, gives up after 30 min
    startPolling(i.client, orderId, i.channelId, name, amount, env);

  } catch (e) {
    console.error('[/pay]', e.response?.data || e.message);
    await i.editReply({ content: '⚠️ Could not create payment link — check Cashfree credentials.' });
  }
}

function startPolling(client, orderId, channelId, buyerName, amount, env) {
  const startedAt = Date.now();
  const pollHeaders = {
    'x-api-version':   '2023-08-01',
    'x-client-id':     process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
  };

  const timer = setInterval(async () => {
    try {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        clearInterval(timer);
        console.log(`[/pay poll] timeout for ${orderId}`);
        return;
      }

      const { data } = await axios.get(`https://${env}/pg/orders/${orderId}`, { headers: pollHeaders });
      const status = data.order_status;

      if (status === 'PAID') {
        clearInterval(timer);

        // Atomic claim — skips if webhook already credited it
        const { rowCount } = await q(
          `UPDATE cheat_sales SET status='success', credited_at=now()
           WHERE cashfree_order_id=$1 AND credited_at IS NULL`,
          [orderId],
        );
        if (!rowCount) return; // webhook beat us to it

        const ch = await client.channels.fetch(channelId);
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0x00C851)
            .setTitle('✅ Payment Confirmed!')
            .setDescription(`**${buyerName}** has successfully paid **₹${amount}**.\n\n> Please deliver the product now.`)
            .addFields(
              { name: '👤 Buyer',  value: `\`${buyerName}\``, inline: true },
              { name: '💰 Amount', value: `**₹${amount}**`,   inline: true },
              { name: '📋 Status', value: '✅ Paid',           inline: true },
            )
            .setTimestamp()
          ],
        });
      } else if (status === 'EXPIRED') {
        clearInterval(timer);
        await q(`UPDATE cheat_sales SET status='failed' WHERE cashfree_order_id=$1 AND credited_at IS NULL`, [orderId]);
      }
    } catch (e) {
      console.warn(`[/pay poll] ${orderId}:`, e.message);
    }
  }, POLL_INTERVAL_MS);
}
