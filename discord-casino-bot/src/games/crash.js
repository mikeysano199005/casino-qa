import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset } from '../repo.js';
import { newServerSeed, hash, rngFloat } from '../util/fairness.js';
import { toPaise, fmt } from '../util/money.js';
import { allow } from '../util/rateLimit.js';
import { logBetResult, logRound, broadcastBigWin } from '../admin/logs.js';

const TICK_MS    = 2_000;  // update multiplier every 2s (easier on mobile)
const BETTING_MS = 15_000; // 15-second betting window before launch

let state = null;
const resultMsgIds = [];
const lastResults  = [];

async function pushResult(channel, embed) {
  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  if (resultMsgIds.length > 0) {
    const old = resultMsgIds.shift();
    channel.messages.fetch(old).then(m => m.delete()).catch(() => {});
  }
  resultMsgIds.push(msg.id);
}

export async function startCrashLoop(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return console.warn('[crash] no channel');
  // Delete old bot messages so stale buttons don't persist after restart
  const old = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (old) for (const m of old.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => {});
  await openRound(channel);
  setInterval(() => tick(channel).catch(e => console.error('[crash]', e)), TICK_MS);
}

async function openRound(channel) {
  const serverSeed = newServerSeed();
  const clientSeed = Date.now().toString(36);
  const preset = await getPreset('crash');
  const r = rngFloat(serverSeed, clientSeed, 0);
  let m;
  if (preset === 'house')         m = Math.max(1.00, 0.99 / Math.max(0.0001, 1 - r));
  else if (preset === 'low')      m = 1 + r * 9;
  else if (preset === 'medium')   m = Math.max(1.00, 0.5 + r * 5);
  else if (preset === 'extreme')  m = r < 0.5 ? 1.00 : 1.02;
  else                            m = 1.00 + r * 0.10;
  m = Math.min(50, Math.round(m * 100) / 100);

  const { rows } = await q(
    `INSERT INTO game_rounds(game,server_seed_hash,client_seed,nonce,preset_mode,outcome)
     VALUES('crash',$1,$2,0,$3,$4) RETURNING *`,
    [hash(serverSeed), clientSeed, preset, { crashAt: m }]
  );
  state = {
    round: rows[0], serverSeed, crashAt: m, multiplier: 1.0,
    bets: [], cashedOut: new Set(),
    phase: 'betting',                    // 'betting' | 'flying' | 'crashed'
    bettingEndsAt: Date.now() + BETTING_MS,
    startedAt: null,
    panelMessageId: null, channel,
  };
  await renderPanel(channel);
}

function multiplierAt(elapsedMs) {
  return +(Math.pow(1.07, elapsedMs / 1000)).toFixed(2);
}

async function renderPanel(channel, forceNew = false) {
  const { phase, multiplier, crashAt, bets, bettingEndsAt } = state;
  const historyField = {
    name: '📊 Last 15',
    value: lastResults.length ? lastResults.map(v => `${v.toFixed(2)}×`).join('  ') : '—',
  };

  let embed, bettingOpen, cashoutOpen;
  if (phase === 'betting') {
    embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle('🚀 Crash — Betting Open!')
      .setDescription(`Place your bets! Round launches at **<t:${Math.floor(bettingEndsAt / 1000)}:T>**`)
      .addFields(
        { name: 'Bets placed', value: String(bets.length), inline: true },
        historyField,
      );
    bettingOpen = true; cashoutOpen = false;
  } else if (phase === 'flying') {
    embed = new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle(`🚀 Crash — ${multiplier.toFixed(2)}×`)
      .setDescription(`🔴 **LIVE** — Cash out before it crashes!\n_Updates every 2s • may lag on mobile_`)
      .addFields(
        { name: 'Active bets', value: String(bets.length), inline: true },
        historyField,
      );
    bettingOpen = false; cashoutOpen = true;
  } else {
    embed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle(`💥 Crashed @ ${crashAt.toFixed(2)}×`)
      .setDescription(`Next round starting in 4s…`)
      .addFields(
        { name: 'Active bets', value: String(bets.length), inline: true },
        historyField,
      );
    bettingOpen = false; cashoutOpen = false;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('crash:bet').setLabel('Place Bet').setStyle(ButtonStyle.Success).setDisabled(!bettingOpen),
    new ButtonBuilder().setCustomId('crash:cashout').setLabel('Cash Out').setStyle(ButtonStyle.Primary).setDisabled(!cashoutOpen),
    new ButtonBuilder().setCustomId('crash:rules').setLabel('📋 Rules').setStyle(ButtonStyle.Secondary),
  );

  // On phase transition (betting→flying), delete old message so mobile gets a new ping
  if (forceNew && state.panelMessageId) {
    channel.messages.fetch(state.panelMessageId).then(m => m.delete()).catch(() => {});
    state.panelMessageId = null;
  }

  if (state.panelMessageId) {
    const msg = await channel.messages.fetch(state.panelMessageId).catch(() => null);
    if (msg) return msg.edit({ embeds: [embed], components: [row] });
  }
  const sent = await channel.send({ embeds: [embed], components: [row] });
  state.panelMessageId = sent.id;
}

async function tick(channel) {
  if (!state) return;

  if (state.phase === 'betting') {
    if (Date.now() >= state.bettingEndsAt) {
      state.phase = 'flying';
      state.startedAt = Date.now();
      await renderPanel(channel, true); // forceNew=true: delete betting msg, post fresh flying msg
    }
    // No panel edit during betting — Discord's <t:R> renders the countdown client-side
    return;
  }

  if (state.phase === 'flying') {
    const elapsed = Date.now() - state.startedAt;
    state.multiplier = multiplierAt(elapsed);

    // Auto cashout
    for (const b of state.bets) {
      if (b.auto && !state.cashedOut.has(b.userId) && state.multiplier >= b.auto) {
        state.cashedOut.add(b.userId);
        b.cashOutAt = b.auto;
      }
    }

    if (state.multiplier >= state.crashAt) {
      state.multiplier = state.crashAt;
      state.phase = 'crashed';
      // Delete the live panel immediately — result message from settle() replaces it
      if (state.panelMessageId) {
        channel.messages.fetch(state.panelMessageId).then(m => m.delete()).catch(() => {});
        state.panelMessageId = null;
      }
      await settle(channel);
      setTimeout(() => openRound(channel), 4000);
      return;
    }
    await renderPanel(channel);
  }
}

async function settle(channel) {
  let pool = 0n, paid = 0n;
  for (const b of state.bets) {
    pool += b.stake;
    let payout = 0n;
    if (state.cashedOut.has(b.userId)) {
      payout = BigInt(Math.floor(Number(b.stake) * b.cashOutAt));
      paid += payout;
      await applyTx({ userId: b.userId, type: 'win', amount: payout, lockDelta: -b.stake,
        ref: state.round.id, meta: { game: 'crash', cashOutAt: b.cashOutAt } });
      if (payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000))
        broadcastBigWin(channel.client, b.username, 'Crash', payout).catch(() => {});
    } else {
      await applyTx({ userId: b.userId, type: 'bet', amount: 0n, lockDelta: -b.stake,
        ref: state.round.id, meta: { game: 'crash', crashed: true } });
    }
    await q(`UPDATE bets SET payout=$1, result=$2, settled_at=now() WHERE id=$3`,
      [payout.toString(), payout > 0n ? 'win' : 'loss', b.betId]);
    logBetResult(channel.client, { user: b.username, discordId: b.discordId, game: 'crash', stake: b.stake.toString(), payout: payout.toString(), result: payout > 0n ? 'win' : 'loss' });
  }
  await q(
    `UPDATE game_rounds SET server_seed=$1, total_pool=$2, house_pnl=$3, ended_at=now() WHERE id=$4`,
    [state.serverSeed, pool.toString(), (pool - paid).toString(), state.round.id]
  );
  logRound(channel.client, 'crash', state.round.id, { crashAt: state.crashAt, pool: pool.toString(), pnl: (pool - paid).toString() });
  lastResults.unshift(state.crashAt);
  if (lastResults.length > 15) lastResults.pop();
  await pushResult(channel, new EmbedBuilder().setColor(Colors.Red)
    .setTitle(`💥 Crashed @ ${state.crashAt.toFixed(2)}×`));
}

export async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    const [, action] = interaction.customId.split(':');
    if (action === 'bet') return openBetModal(interaction);
    if (action === 'cashout') return cashOut(interaction);
    if (action === 'rules') return showRules(interaction);
  }
  if (interaction.isModalSubmit()) return placeBet(interaction);
}

function openBetModal(i) {
  if (!state || state.phase !== 'betting')
    return i.reply({ ephemeral: true, content: '⏱ Betting is closed — wait for the next round.' });
  const modal = new ModalBuilder().setCustomId('crash:betmodal').setTitle('Crash bet');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('amount').setLabel('Amount in ₹')
        .setStyle(TextInputStyle.Short).setRequired(true)
        .setPlaceholder(`min ₹${process.env.MIN_BET || 1} – max ₹${process.env.MAX_BET || 10000}`)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('auto').setLabel('Auto cash-out at (e.g. 2.0, optional)')
        .setStyle(TextInputStyle.Short).setRequired(false)
    ),
  );
  return i.showModal(modal);
}

async function placeBet(i) {
  if (!state || state.phase !== 'betting')
    return i.reply({ ephemeral: true, content: '⏱ Betting is closed — wait for the next round.' });
  if (!allow(i.user.id, Number(process.env.MAX_BETS_PER_SECOND || 4)))
    return i.reply({ ephemeral: true, content: 'Too fast.' });
  if (state.bets.find(b => b.discordId === i.user.id))
    return i.reply({ ephemeral: true, content: 'You already have a bet this round.' });

  const amount = Number(i.fields.getTextInputValue('amount'));
  const auto   = Number(i.fields.getTextInputValue('auto')) || null;
  const min = Number(process.env.MIN_BET || 10), max = Number(process.env.MAX_BET || 10000);
  if (!Number.isFinite(amount) || amount < min || amount > max)
    return i.reply({ ephemeral: true, content: `Bet ₹${min}–₹${max}.` });

  let u;
  try { u = await requireActive(i.user.id, i.user.username); }
  catch { return i.reply({ ephemeral: true, content: '🚫 Your account is suspended.' }); }
  const stake = toPaise(amount);
  try {
    await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
      ref: state.round.id, meta: { game: 'crash', auto } });
  } catch {
    return i.reply({ ephemeral: true, content: '💸 Insufficient balance.' });
  }
  const { rows: br } = await q(
    `INSERT INTO bets(user_id,round_id,game,stake,selection,result) VALUES($1,$2,'crash',$3,$4,'pending') RETURNING id`,
    [u.id, state.round.id, stake.toString(), { auto }]
  );
  state.bets.push({ userId: u.id, discordId: i.user.id, username: i.user.username, stake, betId: br[0].id, auto });
  renderPanel(state.channel).catch(() => {}); // update bets count on panel
  await i.reply({ ephemeral: true, content: `✅ ${fmt(stake)} placed.${auto ? ` Auto cash-out @ ${auto}×.` : ''}` });
}

async function cashOut(i) {
  if (!state || state.phase !== 'flying')
    return i.reply({ ephemeral: true, content: state?.phase === 'betting' ? '⏱ Round hasn\'t launched yet.' : 'Too late.' });
  const b = state.bets.find(x => x.discordId === i.user.id);
  if (!b) return i.reply({ ephemeral: true, content: 'No active bet this round.' });
  if (state.cashedOut.has(b.userId)) return i.reply({ ephemeral: true, content: 'Already cashed out.' });
  state.cashedOut.add(b.userId);
  b.cashOutAt = state.multiplier;
  await i.reply({ ephemeral: true, content: `💰 Cashed out @ **${b.cashOutAt.toFixed(2)}×** — payout ${fmt(BigInt(Math.floor(Number(b.stake) * b.cashOutAt)))}` });
}

function showRules(i) {
  return i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🚀 Crash — How to Play')
      .addFields(
        { name: 'Objective', value: 'A multiplier starts at **1×** and keeps rising. Cash out before it crashes to win. Wait too long and you lose everything!' },
        { name: 'How to Play', value: '1. Place your bet during the **15-second betting window**\n2. Watch the multiplier climb live\n3. Click **Cash Out** before it crashes\n4. Your payout = stake × multiplier at cashout' },
        { name: 'Auto Cash-Out', value: 'Set an automatic cash-out target when placing your bet (e.g. **2.0**). The bot will cash you out automatically when it hits that multiplier.' },
        { name: 'Example', value: '• Bet ₹500, cash out at **3.5×** → win **₹1,750**\n• Bet ₹500, crash happens at **2.0×** before you cash out → lose **₹500**' },
        { name: 'Bet Limits', value: `Min ₹${process.env.MIN_BET || 10} — Max ₹${process.env.MAX_BET || 10000}` },
        { name: 'Fairness', value: 'Crash point is determined by a server seed committed before the round starts. Seed is revealed after crash.' },
      )],
  });
}
