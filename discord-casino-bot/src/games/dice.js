import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset } from '../repo.js';
import { newServerSeed, rngFloat } from '../util/fairness.js';
import { toPaise, fmt } from '../util/money.js';
import { logBetResult, broadcastBigWin } from '../admin/logs.js';

export function postPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎲 Dice')
      .setDescription('Predict roll under/over. Higher chance = lower payout.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dice:play').setLabel('🎲 Roll').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('dice:rules').setLabel('📋 Rules').setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function handleInteraction(i) {
  if (i.isButton()) {
    if (i.customId === 'dice:rules') return showRules(i);
    return openModal(i);
  }
  if (i.isModalSubmit()) return play(i);
}

function showRules(i) {
  return i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎲 Dice — How to Play')
      .addFields(
        { name: 'Objective', value: 'A number between **1–99** is rolled. Predict whether it will be UNDER or OVER your chosen target.' },
        { name: 'How to Bet', value: '1. Choose **UNDER** or **OVER**\n2. Set a target number (**2–98**)\n3. Enter your stake' },
        { name: 'Payout Formula', value: 'Payout = **0.97 ÷ win chance**\nHigher risk = bigger reward.' },
        { name: 'Examples',
          value: '• UNDER 50 → 49% chance → **1.98×**\n• UNDER 10 → 9% chance → **10.78×**\n• OVER 90 → 9% chance → **10.78×**\n• OVER 50 → 49% chance → **1.98×**' },
        { name: 'Bet Limits', value: `Min ₹${process.env.MIN_BET || 10} — Max ₹${process.env.MAX_BET || 10000}` },
      )],
  });
}

function openModal(i) {
  const m = new ModalBuilder().setCustomId('dice:bet').setTitle('Dice');
  m.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('amount').setLabel('Stake ₹').setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder(`min ₹${process.env.MIN_BET || 1} – max ₹${process.env.MAX_BET || 10000}`)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('side').setLabel('UNDER or OVER').setStyle(TextInputStyle.Short).setRequired(true).setValue('UNDER')),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('target').setLabel('Target 2-98').setStyle(TextInputStyle.Short).setRequired(true).setValue('50')),
  );
  return i.showModal(m);
}

async function play(i) {
  const amount = Number(i.fields.getTextInputValue('amount'));
  const side   = i.fields.getTextInputValue('side').trim().toUpperCase();
  const target = Math.floor(Number(i.fields.getTextInputValue('target')));
  const min = Number(process.env.MIN_BET || 10), max = Number(process.env.MAX_BET || 10000);
  if (!Number.isFinite(amount) || amount < min || amount > max)
    return i.reply({ ephemeral: true, content: `Stake ₹${min}–₹${max}.` });
  if (!['UNDER', 'OVER'].includes(side) || target < 2 || target > 98)
    return i.reply({ ephemeral: true, content: 'side UNDER/OVER, target 2-98.' });

  let u;
  try { u = await requireActive(i.user.id, i.user.username); }
  catch { return i.reply({ ephemeral: true, content: '🚫 Your account is suspended.' }); }
  const stake = toPaise(amount);

  const winChance = side === 'UNDER' ? (target - 1) / 100 : (99 - target) / 100;
  const payoutMult = (0.97 / winChance);

  try {
    await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
      ref: null, meta: { game: 'dice', side, target } });
  } catch { return i.reply({ ephemeral: true, content: '💸 Insufficient.' }); }

  const seed = newServerSeed();
  const preset = await getPreset('dice');
  const r = rngFloat(seed, i.user.id, 0);
  let roll = Math.floor(r * 99) + 1; // 1-99

  // Preset bias — use seeded RNG so results are reproducible
  const bias = rngFloat(seed, 'bias', 0);
  const jitter = Math.floor(rngFloat(seed, 'jitter', 0) * 5);
  if (preset === 'low'  && bias < 0.9)  roll = side === 'UNDER' ? Math.max(1, target - 1 - jitter) : target + 1 + jitter;
  if (preset === 'high' && bias < 0.99) roll = side === 'UNDER' ? target + 1 + jitter : Math.max(1, target - 1 - jitter);
  roll = Math.min(99, Math.max(1, roll));

  const win = side === 'UNDER' ? roll < target : roll > target;
  const payout = win ? BigInt(Math.floor(Number(stake) * payoutMult)) : 0n;

  await applyTx({ userId: u.id, type: win ? 'win' : 'bet', amount: win ? payout : 0n,
    lockDelta: -stake, ref: null,
    meta: { game: 'dice', roll, side, target, multiplier: payoutMult.toFixed(2) }});
  const { rows } = await q(
    `INSERT INTO bets(user_id,game,stake,selection,payout,result,settled_at)
     VALUES($1,'dice',$2,$3,$4,$5,now()) RETURNING id`,
    [u.id, stake.toString(), { side, target, roll }, payout.toString(), win ? 'win' : 'loss']
  );
  logBetResult(i.client, { user: i.user.username, discordId: i.user.id, game: 'dice', stake: stake.toString(), payout: payout.toString(), result: win ? 'win' : 'loss' });
  if (win && payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000))
    broadcastBigWin(i.client, i.user.username, 'Dice', payout).catch(()=>{});

  const e = new EmbedBuilder()
    .setColor(win ? Colors.Green : Colors.Red)
    .setTitle(`🎲 Roll: ${roll}`)
    .setDescription(`${side} ${target} • Multiplier ${payoutMult.toFixed(2)}×\n${win ? `**WIN ${fmt(payout)}**` : `**Loss**`}`);
  await i.reply({ ephemeral: true, embeds: [e],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dice:play').setLabel('Rebet').setStyle(ButtonStyle.Primary))]
  });
}
