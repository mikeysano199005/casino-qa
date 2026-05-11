import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset } from '../repo.js';
import { newServerSeed, rngFloat } from '../util/fairness.js';
import { toPaise, fmt } from '../util/money.js';
import { logBetResult, broadcastBigWin } from '../admin/logs.js';

// Symbol weights and 3-of-a-kind paytable.
const SYMBOLS = [
  { s: '🍒', w: 30, pay: 5  },
  { s: '🍋', w: 25, pay: 8  },
  { s: '🔔', w: 18, pay: 12 },
  { s: '⭐', w: 12, pay: 25 },
  { s: '💎', w: 8,  pay: 50 },
  { s: '7️⃣', w: 4,  pay: 100 },
  { s: '🎰', w: 3,  pay: 250 },
];
const TOTAL_W = SYMBOLS.reduce((a, b) => a + b.w, 0);

function pickSymbol(rng, biasIndex = -1) {
  if (biasIndex >= 0) return SYMBOLS[biasIndex];
  let r = rng * TOTAL_W;
  for (const s of SYMBOLS) { r -= s.w; if (r <= 0) return s; }
  return SYMBOLS[0];
}

export function postPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎰 Slots')
      .setDescription('3 reels, match all 3 to win.\n🍒5× 🍋8× 🔔12× ⭐25× 💎50× 7️⃣100× 🎰250× your stake')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('slots:spin').setLabel('🎰 Spin').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('slots:rules').setLabel('📋 Rules').setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function handleInteraction(i) {
  if (i.isButton()) {
    if (i.customId === 'slots:rules') return showRules(i);
    return openModal(i);
  }
  if (i.isModalSubmit()) return spin(i);
}

function showRules(i) {
  return i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎰 Slots — How to Play')
      .addFields(
        { name: 'Objective', value: 'Spin 3 reels. Match all 3 symbols to win!' },
        { name: 'Paytable (multiplier on your stake)',
          value: '🍒 Cherry — **5×**\n🍋 Lemon — **8×**\n🔔 Bell — **12×**\n⭐ Star — **25×**\n💎 Diamond — **50×**\n7️⃣ Seven — **100×**\n🎰 Jackpot — **250×**' },
        { name: 'Bet Limits', value: `Min ₹${process.env.MIN_BET || 10} — Max ₹${process.env.MAX_BET || 10000}` },
        { name: 'Note', value: 'Rarer symbols appear less often but pay much more. Only 3-of-a-kind wins.' },
      )],
  });
}

function openModal(i) {
  const m = new ModalBuilder().setCustomId('slots:bet').setTitle('Slots');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('amount').setLabel('Stake ₹')
      .setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder(`min ₹${process.env.MIN_BET || 1} – max ₹${process.env.MAX_BET || 10000}`)));
  return i.showModal(m);
}

async function spin(i) {
  const amount = Number(i.fields.getTextInputValue('amount'));
  const min = Number(process.env.MIN_BET || 10), max = Number(process.env.MAX_BET || 10000);
  if (!Number.isFinite(amount) || amount < min || amount > max)
    return i.reply({ ephemeral: true, content: `Stake ₹${min}–₹${max}.` });

  let u;
  try { u = await requireActive(i.user.id, i.user.username); }
  catch { return i.reply({ ephemeral: true, content: '🚫 Your account is suspended.' }); }
  const stake = toPaise(amount);
  try {
    await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
      ref: null, meta: { game: 'slots' } });
  } catch { return i.reply({ ephemeral: true, content: '💸 Insufficient.' }); }

  const seed = newServerSeed();
  const preset = await getPreset('slots');

  let reels;
  if (preset === 'low' && Math.random() < 0.4) {
    const sym = pickSymbol(rngFloat(seed, i.user.id, 0));
    reels = [sym, sym, sym];                    // forced 3-of-a-kind
  } else if (preset === 'high' && Math.random() < 0.99) {
    reels = [
      pickSymbol(rngFloat(seed, 'a', 0)),
      pickSymbol(rngFloat(seed, 'b', 1)),
      pickSymbol(rngFloat(seed, 'c', 2)),
    ];
    if (reels[0].s === reels[1].s && reels[1].s === reels[2].s) {
      reels[2] = SYMBOLS[(SYMBOLS.indexOf(reels[2]) + 1) % SYMBOLS.length];
    }
  } else if (preset === 'medium') {
    // medium: 50% chance to force a match, otherwise natural roll
    if (rngFloat(seed, 'med', 0) < 0.5) {
      const sym = pickSymbol(rngFloat(seed, i.user.id, 0));
      reels = [sym, sym, sym];
    } else {
      reels = [
        pickSymbol(rngFloat(seed, 'a', 0)),
        pickSymbol(rngFloat(seed, 'b', 1)),
        pickSymbol(rngFloat(seed, 'c', 2)),
      ];
    }
  } else {
    reels = [
      pickSymbol(rngFloat(seed, 'a', 0)),
      pickSymbol(rngFloat(seed, 'b', 1)),
      pickSymbol(rngFloat(seed, 'c', 2)),
    ];
  }

  const win = reels[0].s === reels[1].s && reels[1].s === reels[2].s;
  const payout = win ? BigInt(Math.floor(Number(stake) * reels[0].pay)) : 0n;

  await applyTx({ userId: u.id, type: win ? 'win' : 'bet',
    amount: win ? payout : 0n, lockDelta: -stake, ref: null,
    meta: { game: 'slots', reels: reels.map(r => r.s), preset } });
  await q(
    `INSERT INTO bets(user_id,game,stake,selection,payout,result,settled_at)
     VALUES($1,'slots',$2,$3,$4,$5,now())`,
    [u.id, stake.toString(), { reels: reels.map(r => r.s) }, payout.toString(), win ? 'win' : 'loss']
  );
  logBetResult(i.client, { user: i.user.username, discordId: i.user.id, game: 'slots', stake: stake.toString(), payout: payout.toString(), result: win ? 'win' : 'loss' });
  if (win && payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000))
    broadcastBigWin(i.client, i.user.username, 'Slots', payout).catch(()=>{});

  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(win ? Colors.Green : Colors.Red)
      .setTitle(`🎰 ${reels.map(r=>r.s).join(' | ')}`)
      .setDescription(win ? `**WIN ${fmt(payout)}**` : 'No match — try again')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('slots:spin').setLabel('Spin again').setStyle(ButtonStyle.Primary))],
  });
}
