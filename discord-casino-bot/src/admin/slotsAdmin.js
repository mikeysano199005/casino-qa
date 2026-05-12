import {
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { slotsForced, SYMBOLS } from '../games/slots.js';

const adminIds = () => (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdmin  = (id) => adminIds().includes(id);

export function postSlotsAdminPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.DarkGold)
      .setTitle('🎰 Slots — Outcome Control')
      .setDescription('Manually override the next spin result for a specific user.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('slotsadmin:forcesymbol').setLabel('🎯 Force Symbol').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('slotsadmin:forcewinloss').setLabel('🎲 Force Win/Lose').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('slotsadmin:clearoutcome').setLabel('🧹 Clear Override').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('slotsadmin:viewactive').setLabel('👁️ View Active').setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function handleSlotsAdminInteraction(i) {
  if (!isAdmin(i.user.id)) return i.reply({ ephemeral: true, content: 'Not authorised.' });

  if (i.isButton()) {
    const parts = i.customId.split(':');
    const action = parts[1];
    if (action === 'forcesymbol')  return openForceSymbolModal(i);
    if (action === 'forcewinloss') return openForceWinLossModal(i);
    if (action === 'clearoutcome') return openClearModal(i);
    if (action === 'viewactive')   return viewActive(i);
    if (action === 'setsymbol')    return setSymbolOutcome(i, parts[2], +parts[3]);
  }
  if (i.isModalSubmit()) {
    const action = i.customId.split(':')[1];
    if (action === 'forcesymbolmodal')  return showSymbolPicker(i);
    if (action === 'forcewinlossmodal') return applyWinLoss(i);
    if (action === 'clearmodal')        return clearUserOutcome(i);
  }
}

function openForceSymbolModal(i) {
  const m = new ModalBuilder().setCustomId('slotsadmin:forcesymbolmodal').setTitle('Force Symbol');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('discordId').setLabel('Discord User ID')
      .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 123456789012345678'),
  ));
  return i.showModal(m);
}

function openForceWinLossModal(i) {
  const m = new ModalBuilder().setCustomId('slotsadmin:forcewinlossmodal').setTitle('Force Win / Lose');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('discordId').setLabel('Discord User ID')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 123456789012345678'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('type').setLabel('win  or  lose')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue('win'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('count').setLabel('Number of spins (1–20)')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue('1'),
    ),
  );
  return i.showModal(m);
}

function openClearModal(i) {
  const m = new ModalBuilder().setCustomId('slotsadmin:clearmodal').setTitle('Clear Override');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('discordId').setLabel('Discord User ID')
      .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 123456789012345678'),
  ));
  return i.showModal(m);
}

async function showSymbolPicker(i) {
  const discordId = i.fields.getTextInputValue('discordId').trim();
  const row1 = new ActionRowBuilder().addComponents(
    SYMBOLS.slice(0, 5).map((s, idx) =>
      new ButtonBuilder()
        .setCustomId(`slotsadmin:setsymbol:${discordId}:${idx}`)
        .setLabel(`${s.s} ${s.pay}×`)
        .setStyle(ButtonStyle.Primary)
    )
  );
  const row2 = new ActionRowBuilder().addComponents(
    SYMBOLS.slice(5).map((s, idx) =>
      new ButtonBuilder()
        .setCustomId(`slotsadmin:setsymbol:${discordId}:${idx + 5}`)
        .setLabel(`${s.s} ${s.pay}×`)
        .setStyle(ButtonStyle.Success)
    )
  );
  await i.reply({
    ephemeral: true,
    content: `Pick the symbol to force for <@${discordId}>'s next spin:`,
    components: [row1, row2],
  });
}

async function setSymbolOutcome(i, discordId, symbolIdx) {
  const sym = SYMBOLS[symbolIdx];
  if (!sym) return i.reply({ ephemeral: true, content: '❌ Invalid symbol.' });
  slotsForced.set(discordId, { type: 'symbol', symbol: sym });
  await i.update({
    content: `✅ Next spin for <@${discordId}> will land **${sym.s} ${sym.s} ${sym.s}** (${sym.pay}× payout).`,
    components: [],
  });
}

async function applyWinLoss(i) {
  const discordId = i.fields.getTextInputValue('discordId').trim();
  const type      = i.fields.getTextInputValue('type').trim().toLowerCase();
  const count     = Math.min(20, Math.max(1, Math.floor(Number(i.fields.getTextInputValue('count')))));
  if (type !== 'win' && type !== 'lose')
    return i.reply({ ephemeral: true, content: '❌ Type must be `win` or `lose`.' });
  slotsForced.set(discordId, { type, remaining: count });
  await i.reply({
    ephemeral: true,
    content: `✅ Next **${count}** spin(s) for <@${discordId}> will **${type === 'win' ? '🏆 WIN' : '💀 LOSE'}**.`,
  });
}

async function clearUserOutcome(i) {
  const discordId = i.fields.getTextInputValue('discordId').trim();
  if (slotsForced.has(discordId)) {
    slotsForced.delete(discordId);
    await i.reply({ ephemeral: true, content: `✅ Override cleared for <@${discordId}>.` });
  } else {
    await i.reply({ ephemeral: true, content: `ℹ️ No active override for <@${discordId}>.` });
  }
}

async function viewActive(i) {
  if (slotsForced.size === 0) return i.reply({ ephemeral: true, content: 'No active overrides.' });
  const lines = [...slotsForced.entries()].map(([id, v]) => {
    if (v.type === 'symbol') return `<@${id}> → symbol **${v.symbol.s}** (${v.symbol.pay}×) — next spin`;
    if (v.type === 'win')    return `<@${id}> → 🏆 **WIN** × ${v.remaining} spin(s) remaining`;
    if (v.type === 'lose')   return `<@${id}> → 💀 **LOSE** × ${v.remaining} spin(s) remaining`;
  });
  await i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold)
      .setTitle('👁️ Active Slot Overrides')
      .setDescription(lines.join('\n'))],
  });
}
