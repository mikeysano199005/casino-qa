import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset, clearStuckSessions } from '../repo.js';
import { resolveAmountPreset } from '../util/amountPreset.js';
import { newServerSeed, hash, rngFloat } from '../util/fairness.js';
import { toPaise, fmt } from '../util/money.js';
import { allow } from '../util/rateLimit.js';
import { logBetResult, logRound, broadcastBigWin } from '../admin/logs.js';

const TICK_MS    = 2_000;
const BETTING_MS = 25_000;

let state   = null;
let ticking = false;  // prevents concurrent tick() execution

const resultMsgIds = [];
const lastResults  = [];
const lastBet      = new Map(); // discordId -> amount (₹)

// ── Result history (keeps 1 message, auto-removes the previous) ───────
async function pushResult(channel, embed) {
  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  if (resultMsgIds.length > 0) {
    channel.messages.fetch(resultMsgIds.shift()).then(m => m.delete()).catch(() => {});
  }
  resultMsgIds.push(msg.id);
}

// ── Startup ───────────────────────────────────────────────────────────
export async function startCrashLoop(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return console.warn('[crash] no channel');

  const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (fetched) {
    const botMsgs = [...fetched.filter(m => m.author.id === client.user.id).values()];
    if (botMsgs.length > 0)
      await channel.bulkDelete(botMsgs).catch(async () => {
        for (const m of botMsgs) await m.delete().catch(() => {});
      });
  }

  await openRound(channel);
  setInterval(() => tick(channel).catch(e => console.error('[crash tick]', e)), TICK_MS);
}

// ── Round lifecycle ───────────────────────────────────────────────────
function computeCrashAt(preset, r) {
  let m;
  if (preset === 'house')        m = Math.max(1.00, 0.99 / Math.max(0.0001, 1 - r));
  else if (preset === 'low')     m = 1 + r * 9;
  else if (preset === 'medium')  m = Math.max(1.00, 0.5 + r * 5);
  else if (preset === 'extreme') m = r < 0.5 ? 1.00 : 1.02;
  else                           m = 1.00 + r * 0.10;
  return Math.min(50, Math.round(m * 100) / 100);
}

async function openRound(channel) {
  const serverSeed = newServerSeed();
  const clientSeed = Date.now().toString(36);
  const preset     = await getPreset('crash');
  const m          = computeCrashAt(preset, rngFloat(serverSeed, clientSeed, 0));

  const { rows } = await q(
    `INSERT INTO game_rounds(game,server_seed_hash,client_seed,nonce,preset_mode,outcome)
     VALUES('crash',$1,$2,0,$3,$4) RETURNING *`,
    [hash(serverSeed), clientSeed, preset, { crashAt: m }]
  );
  state = {
    round:         rows[0],
    serverSeed,
    crashAt:       m,
    multiplier:    1.00,
    bets:          [],
    cashedOut:     new Set(),
    phase:         'betting',
    bettingEndsAt: Date.now() + BETTING_MS,
    startedAt:     null,
    panelMsgId:    null,
    channel,
  };
  await sendPanel(channel);  // always post fresh on new round
}

function multiplierAt(elapsedMs) {
  return +(Math.pow(1.07, elapsedMs / 1000)).toFixed(2);
}

// ── Panel rendering ───────────────────────────────────────────────────
// Only tick() calls renderPanel — no concurrent senders possible
async function renderPanel(channel) {
  if (!state || !state.panelMsgId) return;
  const msg = await channel.messages.fetch(state.panelMsgId).catch(() => null);
  if (!msg) { state.panelMsgId = null; return; }
  const { embeds, components } = buildPanel();
  await msg.edit({ embeds, components }).catch(() => {});
}

// Post a brand-new panel message (call when starting round or after delete)
async function sendPanel(channel) {
  if (!state) return;
  const { embeds, components } = buildPanel();
  const sent = await channel.send({ embeds, components });
  state.panelMsgId = sent.id;
}

function totalPot() {
  return state.bets.reduce((s, b) => s + b.stake, 0n);
}

function historyLine() {
  return lastResults.length
    ? lastResults.slice(0, 10).map(v => `${v.toFixed(2)}×`).join('  ')
    : '—';
}

function buildPanel() {
  const { phase, multiplier, crashAt, bets, bettingEndsAt, cashedOut } = state;
  let embed, bettingOpen, cashoutOpen;

  if (phase === 'betting') {
    const secsLeft = Math.max(0, Math.ceil((bettingEndsAt - Date.now()) / 1000));
    embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🚀 Crash — Betting Open')
      .setDescription(`⏰ Round launches **<t:${Math.floor(bettingEndsAt / 1000)}:R>**`)
      .addFields(
        { name: '💰 Pot',      value: fmt(totalPot()),       inline: true },
        { name: '👥 Bets',     value: String(bets.length),   inline: true },
        { name: '⏱ Time left', value: `${secsLeft}s`,        inline: true },
        { name: '📊 Last 10',  value: historyLine() },
      );
    bettingOpen = true; cashoutOpen = false;

  } else if (phase === 'flying') {
    const color = multiplier < 2 ? Colors.Green : multiplier < 5 ? 0xFEE75C : 0xFF8C00;
    embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`🚀  ${multiplier.toFixed(2)}×  ─ LIVE`)
      .setDescription('🔴 **Cash out before it crashes!**')
      .addFields(
        { name: '💰 Pot',       value: fmt(totalPot()),                        inline: true },
        { name: '✅ Cashed out', value: `${cashedOut.size} / ${bets.length}`, inline: true },
        { name: '📊 Last 10',   value: historyLine() },
      );
    bettingOpen = false; cashoutOpen = true;

  } else {
    embed = new EmbedBuilder()
      .setColor(Colors.Red)
      .setTitle(`💥 Crashed @ ${crashAt.toFixed(2)}×`)
      .setDescription('Next round starting soon…')
      .addFields({ name: '📊 Last 10', value: historyLine() });
    bettingOpen = false; cashoutOpen = false;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('crash:bet').setLabel('🎯 Place Bet').setStyle(ButtonStyle.Success).setDisabled(!bettingOpen),
    new ButtonBuilder().setCustomId('crash:rebet').setLabel('🔁 Bet Again').setStyle(ButtonStyle.Secondary).setDisabled(!bettingOpen),
    new ButtonBuilder().setCustomId('crash:cashout').setLabel('💸 Cash Out').setStyle(ButtonStyle.Primary).setDisabled(!cashoutOpen),
    new ButtonBuilder().setCustomId('crash:rules').setLabel('📋 Rules').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// ── Tick ──────────────────────────────────────────────────────────────
async function tick(channel) {
  if (!state || ticking) return;
  ticking = true;
  try {
    // ─ Betting phase ─
    if (state.phase === 'betting') {
      if (Date.now() >= state.bettingEndsAt) {
        // Re-derive crashAt based on amount preset of median bet
        if (state.bets.length > 0) {
          const sorted = [...state.bets.map(b => b.stake)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          const medianStake = sorted[Math.floor(sorted.length / 2)];
          const amtPreset   = await resolveAmountPreset(medianStake);
          if (amtPreset) {
            const r2 = rngFloat(state.serverSeed, 'amt', 0);
            state.crashAt = computeCrashAt(amtPreset, r2);
            await q(`UPDATE game_rounds SET outcome=$1 WHERE id=$2`,
              [JSON.stringify({ crashAt: state.crashAt }), state.round.id]);
          }
        }
        // Transition betting → flying: delete old panel, post new flying panel
        if (state.panelMsgId) {
          channel.messages.fetch(state.panelMsgId).then(m => m.delete()).catch(() => {});
          state.panelMsgId = null;
        }
        state.phase     = 'flying';
        state.startedAt = Date.now();
        await sendPanel(channel);
      } else {
        // Edit in-place every tick to update countdown and bet count
        await renderPanel(channel);
      }
      return;
    }

    // ─ Flying phase ─
    if (state.phase === 'flying') {
      const elapsed    = Date.now() - state.startedAt;
      state.multiplier = multiplierAt(elapsed);

      if (state.multiplier >= state.crashAt) {
        state.multiplier = state.crashAt;
        state.phase      = 'crashed';
        // Delete live panel — result message from settle() replaces it
        if (state.panelMsgId) {
          channel.messages.fetch(state.panelMsgId).then(m => m.delete()).catch(() => {});
          state.panelMsgId = null;
        }
        await settle(channel);
        setTimeout(() => openRound(channel).catch(e => console.error('[crash openRound]', e)), 4000);
        return;
      }

      await renderPanel(channel);
    }
  } finally {
    ticking = false;
  }
}

// ── Settle ────────────────────────────────────────────────────────────
async function settle(channel) {
  let pool = 0n, paid = 0n;
  for (const b of state.bets) {
    pool += b.stake;
    let payout = 0n;
    if (state.cashedOut.has(b.userId)) {
      payout = BigInt(Math.floor(Number(b.stake) * b.cashOutAt));
      paid  += payout;
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
    logBetResult(channel.client, { user: b.username, discordId: b.discordId, game: 'crash',
      stake: b.stake.toString(), payout: payout.toString(), result: payout > 0n ? 'win' : 'loss' });
  }

  await q(
    `UPDATE game_rounds SET server_seed=$1, total_pool=$2, house_pnl=$3, ended_at=now() WHERE id=$4`,
    [state.serverSeed, pool.toString(), (pool - paid).toString(), state.round.id]
  );
  logRound(channel.client, 'crash', state.round.id, {
    crashAt: state.crashAt, pool: pool.toString(), pnl: (pool - paid).toString(),
  });

  lastResults.unshift(state.crashAt);
  if (lastResults.length > 15) lastResults.pop();

  const survivors = state.bets.filter(b => state.cashedOut.has(b.userId));
  const desc = survivors.length
    ? survivors.map(b =>
        `• **${b.username}** — cashed @ **${b.cashOutAt.toFixed(2)}×** → ${fmt(BigInt(Math.floor(Number(b.stake) * b.cashOutAt)))}`
      ).join('\n')
    : '_Nobody cashed out._';

  await pushResult(channel, new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(`💥 Crashed @ ${state.crashAt.toFixed(2)}×`)
    .setDescription(`**Pool:** ${fmt(pool)}  •  **Paid:** ${fmt(paid)}\n\n${desc}`));
}

// ── Interaction routing ───────────────────────────────────────────────
export async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    const [, action] = interaction.customId.split(':');
    if (action === 'bet')     return openBetModal(interaction);
    if (action === 'rebet')   return reBet(interaction);
    if (action === 'cashout') return cashOut(interaction);
    if (action === 'rules')   return showRules(interaction);
  }
  if (interaction.isModalSubmit()) return placeBet(interaction);
}

function openBetModal(i) {
  if (!state || state.phase !== 'betting')
    return i.reply({ ephemeral: true, content: '⏱ Betting is closed — wait for the next round.' });
  const modal = new ModalBuilder().setCustomId('crash:betmodal').setTitle('Place Crash Bet');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('amount').setLabel('Amount in ₹')
      .setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder(`min ₹${process.env.MIN_BET || 1} – max ₹${process.env.MAX_BET || 10000}`),
  ));
  return i.showModal(modal);
}

async function placeBet(i) {
  await executePlaceBet(i, Number(i.fields.getTextInputValue('amount')));
}

async function reBet(i) {
  const amount = lastBet.get(i.user.id);
  if (!amount) return i.reply({ ephemeral: true, content: '⚠️ No previous bet. Use 🎯 Place Bet first.' });
  await executePlaceBet(i, amount);
}

async function executePlaceBet(i, amount) {
  if (!state || state.phase !== 'betting')
    return i.reply({ ephemeral: true, content: '⏱ Betting is closed — wait for the next round.' });
  if (!allow(i.user.id, Number(process.env.MAX_BETS_PER_SECOND || 4)))
    return i.reply({ ephemeral: true, content: 'Slow down.' });
  if (state.bets.find(b => b.discordId === i.user.id))
    return i.reply({ ephemeral: true, content: 'You already have a bet this round.' });

  const min = Number(process.env.MIN_BET || 10), max = Number(process.env.MAX_BET || 10000);
  if (!Number.isFinite(amount) || amount < min || amount > max)
    return i.reply({ ephemeral: true, content: `Bet ₹${min}–₹${max}.` });

  let u;
  try { u = await requireActive(i.user.id, i.user.username); }
  catch { return i.reply({ ephemeral: true, content: '🚫 Your account is suspended.' }); }

  // Auto-release any stuck mines/blackjack sessions so their locked funds are freed
  await clearStuckSessions(i.user.id).catch(() => {});

  const stake = toPaise(amount);
  try {
    await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
      ref: state.round.id, meta: { game: 'crash' } });
  } catch {
    return i.reply({ ephemeral: true, content: '💸 Insufficient balance.' });
  }
  const { rows: br } = await q(
    `INSERT INTO bets(user_id,round_id,game,stake,selection,result) VALUES($1,$2,'crash',$3,$4,'pending') RETURNING id`,
    [u.id, state.round.id, stake.toString(), {}]
  );
  state.bets.push({ userId: u.id, discordId: i.user.id, username: i.user.username, stake, betId: br[0].id });
  lastBet.set(i.user.id, amount);
  // Panel updates on next tick — no concurrent panel sends from here
  await i.reply({ ephemeral: true, content: `✅ **${fmt(stake)}** placed! Cash out before it crashes 🚀` });
}

async function cashOut(i) {
  if (!state || state.phase !== 'flying')
    return i.reply({ ephemeral: true,
      content: state?.phase === 'betting' ? '⏱ Round hasn\'t launched yet.' : '💥 Already crashed.' });
  const b = state.bets.find(x => x.discordId === i.user.id);
  if (!b) return i.reply({ ephemeral: true, content: 'No active bet this round.' });
  if (state.cashedOut.has(b.userId)) return i.reply({ ephemeral: true, content: '✅ Already cashed out.' });
  state.cashedOut.add(b.userId);
  b.cashOutAt = state.multiplier;
  const payout = BigInt(Math.floor(Number(b.stake) * b.cashOutAt));
  await i.reply({ ephemeral: true,
    content: `💰 Cashed out @ **${b.cashOutAt.toFixed(2)}×** — you win **${fmt(payout)}**! 🎉` });
}

function showRules(i) {
  return i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🚀 Crash — How to Play')
      .addFields(
        { name: 'Objective', value: 'Bet before the round starts. Watch the multiplier climb from **1×** and cash out before it crashes to lock in profit.' },
        { name: 'Phases', value: '🔵 **Betting (25s)** — place your bet\n🟡 **LIVE** — multiplier climbs, cash out anytime\n💥 **Crashed** — round ends, next round in 4s' },
        { name: 'Payouts', value: 'Payout = **Stake × Multiplier at cashout**\nExample: ₹500 bet, cash out @ **3.5×** = **₹1,750**' },
        { name: 'Bet Limits', value: `Min ₹${process.env.MIN_BET || 10} — Max ₹${process.env.MAX_BET || 10000}` },
        { name: 'Fairness', value: 'Crash point locked before the round. Server seed hash shown upfront, revealed after crash — fully verifiable.' },
      )],
  });
}
