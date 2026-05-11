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

const ROUND_MS = 60_000;  // 60-second betting window
const PAYOUT   = 9;       // 9× on correct number (natural 10×, −10% house edge)
const MIN_BET  = 100;     // ₹100 minimum — Matka only
const MAX_BET  = 50_000;  // ₹50,000 maximum — Matka only

let state              = null;
let _client            = null;
let predictionEnabled  = true;  // admin-togglable at runtime

export const togglePrediction  = () => { predictionEnabled = !predictionEnabled; return predictionEnabled; };
export const getPredictionState = () => predictionEnabled;
const lastResults    = [];
const resultMsgIds   = [];
const allPanelMsgIds = new Set();

// ─── Preset-aware winner picker ───────────────────────────────────────
// house      → uniform random 0–9
// low        → 90% pick the number with most stake (players mostly win)
// medium     → 50% player-favorable, 50% house-favorable
// high       → ALWAYS opposite: pick a zero-bet number; if all are bet, pick lowest-staked
// prediction → same RNG as 'house' — winner is pre-announced to CH_MATKA_PREDICTION

function pickWinner(pool, preset, rng, rng2) {
  const nums  = Array.from({ length: 10 }, (_, i) => i);
  const stake = (n) => pool[n] ?? 0n;

  if (preset === 'house' || preset === 'prediction') return Math.floor(rng * 10);

  // Sort descending by stake so [0] = most-bet number
  const sorted     = [...nums].sort((a, b) => Number(stake(b)) - Number(stake(a)));
  const mostStaked = sorted[0];

  if (preset === 'low')    return rng < 0.90 ? mostStaked : Math.floor(rng2 * 10);
  if (preset === 'medium') {
    const zeroBet   = nums.find(n => stake(n) === 0n);
    const houseWin  = zeroBet !== undefined ? zeroBet : sorted[sorted.length - 1];
    return rng < 0.50 ? mostStaked : houseWin;
  }
  if (preset === 'high') {
    // Always pick a number nobody bet on — maximises house profit
    const zeroBets = nums.filter(n => stake(n) === 0n);
    if (zeroBets.length > 0) {
      // Random among unbet numbers so it looks natural
      return zeroBets[Math.floor(rng * zeroBets.length)];
    }
    // All 10 numbers have bets — pick the one with the LOWEST total stake
    // (winner is paid out on a tiny amount → minimum payout for house)
    return [...nums].sort((a, b) => Number(stake(a)) - Number(stake(b)))[0];
  }
  return Math.floor(rng * 10);
}

// ─── Round lifecycle ──────────────────────────────────────────────────

async function openRound() {
  const serverSeed = newServerSeed();
  const clientSeed = Date.now().toString(36);
  const preset     = await getPreset('matka');
  const { rows }   = await q(
    `INSERT INTO game_rounds(game, server_seed_hash, client_seed, nonce, preset_mode)
     VALUES('matka', $1, $2, 0, $3) RETURNING *`,
    [hash(serverSeed), clientSeed, preset]
  );
  const pool = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, 0n]));

  // In prediction mode: winner is determined NOW from the seed and broadcast to the VIP channel.
  // The same RNG value is re-used in tick(), so the prediction is always 100% accurate.
  let predictedWinner = null;
  if (preset === 'prediction') {
    const rng = rngFloat(serverSeed, clientSeed, 0);
    predictedWinner = Math.floor(rng * 10);
    if (predictionEnabled && _client && process.env.CH_MATKA_PREDICTION) {
      const endsAt = Date.now() + ROUND_MS;
      const ch = await _client.channels.fetch(process.env.CH_MATKA_PREDICTION).catch(() => null);
      if (ch) {
        ch.send({
          embeds: [new EmbedBuilder()
            .setColor(Colors.Purple)
            .setTitle('🔮 Matka — VIP Prediction')
            .setDescription(
              `**Winning number: ${predictedWinner}**\n` +
              `Round closes at **<t:${Math.floor(endsAt / 1000)}:T>**\n` +
              `_Bet on **${predictedWinner}** before the round ends to win 9× your stake!_`
            )],
        }).catch(() => {});
      }
    }
  }

  state = {
    round: rows[0],
    serverSeed,
    pool,
    bets: [],
    endsAt: Date.now() + ROUND_MS,
    panelMessageId: null,
    predictedWinner,
  };
}

export async function startMatkaLoop(client, channelId) {
  _client = client;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return console.warn('[matka] no channel');
  // Clear stale bot messages on restart
  const old = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (old) for (const m of old.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => {});
  await openRound();
  await renderPanel(channel);
  setInterval(() => tick(channel).catch(e => console.error('[matka]', e)), ROUND_MS);
  // Edit-only refresh every 8 s — never posts a new message
  setInterval(async () => {
    if (!state?.panelMessageId) return;
    try {
      const msg = await channel.messages.fetch(state.panelMessageId);
      await msg.edit({ embeds: [buildEmbed()], components: buildRows() });
    } catch {}
  }, 8_000);
}

// ─── Panel rendering ──────────────────────────────────────────────────

function buildEmbed() {
  const totalPool = Object.values(state.pool).reduce((a, b) => a + b, 0n);
  const matchId   = state.round.id.slice(-6).toUpperCase();
  const closeTs   = Math.floor(state.endsAt / 1000);
  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('🎲 Matka King')
    .setDescription(`Pick a number **0–9**. Correct pick pays **${PAYOUT}×** your stake!`)
    .addFields(
      { name: '🆔 Match ID',    value: `\`MK-${matchId}\``,         inline: true },
      { name: '⏰ Closes At',   value: `<t:${closeTs}:T>`,           inline: true },
      { name: '💰 Total Pool',  value: fmt(totalPool),               inline: true },
      { name: '🎫 Bets',        value: String(state.bets.length),    inline: true },
      { name: '📊 Last 15',     value: lastResults.length ? lastResults.map(String).join('  ') : '—', inline: false },
      { name: '🔐 Seed (commit)', value: '`' + state.round.server_seed_hash.slice(0, 24) + '…`', inline: false },
    );
}

function buildRows() {
  const row1 = new ActionRowBuilder();
  for (let n = 0; n < 5; n++)
    row1.addComponents(new ButtonBuilder().setCustomId(`matka:bet:${n}`).setLabel(String(n)).setStyle(ButtonStyle.Primary));

  const row2 = new ActionRowBuilder();
  for (let n = 5; n < 10; n++)
    row2.addComponents(new ButtonBuilder().setCustomId(`matka:bet:${n}`).setLabel(String(n)).setStyle(ButtonStyle.Primary));

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('matka:history').setLabel('📊 History').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('matka:rules').setLabel('📋 Rules').setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2, row3];
}

async function renderPanel(channel) {
  if (state.panelMessageId) {
    const msg = await channel.messages.fetch(state.panelMessageId).catch(() => null);
    if (msg) return msg.edit({ embeds: [buildEmbed()], components: buildRows() });
  }
  const m = await channel.send({ embeds: [buildEmbed()], components: buildRows() });
  state.panelMessageId = m.id;
  allPanelMsgIds.add(m.id);
}

async function pushResult(channel, embed) {
  const msg = await channel.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return;
  if (resultMsgIds.length > 0) {
    const old = resultMsgIds.shift();
    channel.messages.fetch(old).then(m => m.delete()).catch(() => {});
  }
  resultMsgIds.push(msg.id);
}

// ─── Tick / settle ────────────────────────────────────────────────────

async function tick(channel) {
  if (!state) return;
  const settled = state;
  state = null;

  for (const id of allPanelMsgIds)
    channel.messages.fetch(id).then(m => m.delete()).catch(() => {});
  allPanelMsgIds.clear();

  const preset = settled.round.preset_mode || await getPreset('matka');
  const rng    = rngFloat(settled.serverSeed, settled.round.client_seed, 0);
  const rng2   = rngFloat(settled.serverSeed, settled.round.client_seed, 1);
  // prediction mode: winner was locked in at round open — use it directly
  const winner = (settled.predictedWinner !== null)
    ? settled.predictedWinner
    : pickWinner(settled.pool, preset, rng, rng2);

  let totalPool = 0n, paid = 0n;
  for (const b of settled.bets) {
    totalPool += b.stake;
    const win    = b.number === winner;
    const payout = win ? b.stake * BigInt(PAYOUT) : 0n;
    paid += payout;
    await applyTx({
      userId: b.userId, type: win ? 'win' : 'bet', amount: win ? payout : 0n,
      lockDelta: 0n, ref: settled.round.id,
      meta: { game: 'matka', selection: b.number, result: winner, payout: payout.toString() },
    });
    await q(`UPDATE bets SET payout=$1, result=$2, settled_at=now() WHERE id=$3`,
      [payout.toString(), win ? 'win' : 'loss', b.betId]);
    logBetResult(channel.client, {
      user: b.username, discordId: b.discordId, game: 'matka',
      stake: b.stake.toString(), payout: payout.toString(), result: win ? 'win' : 'loss',
    });
    if (win && payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000))
      broadcastBigWin(channel.client, b.username, 'Matka', payout).catch(() => {});
  }

  await q(
    `UPDATE game_rounds SET server_seed=$1, outcome=$2, total_pool=$3, house_pnl=$4, ended_at=now() WHERE id=$5`,
    [settled.serverSeed, { winner }, totalPool.toString(), (totalPool - paid).toString(), settled.round.id]
  );
  lastResults.unshift(winner);
  if (lastResults.length > 15) lastResults.pop();
  logRound(channel.client, 'matka', settled.round.id,
    { winner, pool: totalPool.toString(), pnl: (totalPool - paid).toString(), preset });

  await pushResult(channel, new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🎲 Matka — Winning Number: **${winner}**`)
    .setDescription(
      `Pool: **${fmt(totalPool)}** • Paid: **${fmt(paid)}**\n` +
      `Seed reveal: \`${settled.serverSeed.slice(0, 24)}…\``
    )
  );

  await openRound();
  await renderPanel(channel);
}

// ─── How-to-play guide ────────────────────────────────────────────────

function buildGuideEmbed() {
  return new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle('🎲 How to Play Matka')
    .setDescription(
      '**Matka is a simple number-guessing game.**\n\n' +
      '**How it works:**\n' +
      '• Each round lasts **60 seconds**. Pick any number from **0 to 9**.\n' +
      '• When the round ends, one winning number is drawn.\n' +
      '• If your number matches, you win **9× your stake!**\n\n' +
      '**Example:**\n' +
      '• You bet ₹100 on **5**\n' +
      '• Winning number = **5** → You receive **₹900!**\n' +
      '• Winning number = **3** → You lose ₹100.\n\n' +
      '**Rules:**\n' +
      '• One bet per round per player.\n' +
      '• Each number has an equal natural chance of winning.\n' +
      '• The game is **provably fair** — the server seed is revealed after every round.\n\n' +
      '_This guide only appears once. Good luck!_ 🍀'
    );
}

// ─── Interaction handlers ─────────────────────────────────────────────

export async function handleInteraction(i) {
  if (i.isButton()) {
    const [, action, ...rest] = i.customId.split(':');
    if (action === 'bet')     return openBetModal(i, Number(rest[0]));
    if (action === 'history') return showHistory(i);
    if (action === 'rules')   return showRules(i);
  }
  if (i.isModalSubmit()) {
    const parts = i.customId.split(':');
    return placeBet(i, Number(parts[2]), parts[3]);
  }
}

async function openBetModal(i, number) {
  if (!state) return i.reply({ ephemeral: true, content: 'No round in progress.' });
  if (state.endsAt - Date.now() < 1500) return i.reply({ ephemeral: true, content: '⏱ Round closing — bets locked.' });

  const existing = state.bets.find(b => b.discordId === i.user.id);
  if (existing) return i.reply({ ephemeral: true, content: `❌ You already bet **₹${fmt(existing.stake)}** on **${existing.number}** this round. One bet per round.` });

  // First-time guide: show once, then show modal on next click
  // Guard: column may not exist yet if migration 004 hasn't run
  const { rows } = await q(`SELECT matka_seen FROM users WHERE discord_id=$1`, [i.user.id]).catch(() => ({ rows: [] }));
  if (rows[0] && !rows[0].matka_seen) {
    await q(`UPDATE users SET matka_seen=true WHERE discord_id=$1`, [i.user.id]).catch(() => {});
    return i.reply({
      ephemeral: true,
      embeds: [buildGuideEmbed()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`matka:bet:${number}`)
          .setLabel(`Got it! Bet on ${number}`)
          .setStyle(ButtonStyle.Success)
      )],
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`matka:betmodal:${number}:${state.round.id}`)
    .setTitle(`Matka — Pick ${number}`);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Amount in ₹')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(`min ₹${MIN_BET} – max ₹${MAX_BET}`)
    )
  );
  return i.showModal(modal);
}

async function placeBet(i, number, betRoundId) {
  if (!allow(i.user.id, Number(process.env.MAX_BETS_PER_SECOND || 4)))
    return i.reply({ ephemeral: true, content: 'Slow down — too many bets.' });

  // Round ended or changed while modal was open — no money touched yet
  if (!state || state.round.id !== betRoundId)
    return i.reply({ ephemeral: true, content: '⏱ That round already ended. No money was deducted — please bet in the new round.' });

  if (state.endsAt - Date.now() < 1500)
    return i.reply({ ephemeral: true, content: '⏱ Round just closed — no money was deducted. Please bet in the next round.' });

  if (state.bets.find(b => b.discordId === i.user.id))
    return i.reply({ ephemeral: true, content: 'You already placed a bet this round.' });

  const amount = Number(i.fields.getTextInputValue('amount'));
  if (!Number.isFinite(amount) || amount < MIN_BET || amount > MAX_BET)
    return i.reply({ ephemeral: true, content: `Bet must be between ₹${MIN_BET} and ₹${MAX_BET}.` });

  let u;
  try { u = await requireActive(i.user.id, i.user.username); }
  catch { return i.reply({ ephemeral: true, content: '🚫 Your account is suspended.' }); }

  const stake = toPaise(amount);
  try {
    await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: 0n,
      ref: state.round.id, meta: { game: 'matka', selection: number } });
  } catch {
    return i.reply({ ephemeral: true, content: '💸 Insufficient balance.' });
  }

  // Final safety check: if round changed between deduction and now, refund + DM
  if (!state || state.round.id !== betRoundId) {
    await applyTx({ userId: u.id, type: 'refund', amount: stake, lockDelta: 0n,
      ref: null, meta: { game: 'matka', reason: 'round_ended_during_submit' } }).catch(() => {});
    try {
      const dUser = await i.client.users.fetch(i.user.id);
      await dUser.send(
        `💰 **Matka Refund — ₹${amount.toFixed(2)}**\n` +
        `Your bet of **${fmt(stake)}** on number **${number}** was refunded because the round ended while your bet was being processed.\n` +
        `Your balance has been restored. Please place your bet in the next round!`
      );
    } catch {}
    return i.reply({ ephemeral: true, content: `⏱ The round ended while processing your bet. **${fmt(stake)} has been refunded** to your wallet — check your DMs.` });
  }

  const { rows: br } = await q(
    `INSERT INTO bets(user_id, round_id, game, stake, selection, result)
     VALUES ($1, $2, 'matka', $3, $4, 'pending') RETURNING id`,
    [u.id, state.round.id, stake.toString(), { number }]
  );
  state.pool[number] = (state.pool[number] || 0n) + stake;
  state.bets.push({ userId: u.id, discordId: i.user.id, username: i.user.username, number, stake, betId: br[0].id });

  await i.reply({ ephemeral: true, content: `✅ Bet placed: ${fmt(stake)} on **${number}**. Good luck!` });
}

function showRules(i) {
  return i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎲 Matka — How to Play')
      .addFields(
        { name: 'Objective', value: 'Pick any number from **0 to 9**. If the winning number matches yours, you win **9×** your stake!' },
        { name: 'How to Play', value: '1. Click any number button (**0–9**)\n2. Enter your stake amount\n3. Wait for the round to end at the shown time\n4. If your number is drawn — you win instantly!' },
        { name: 'Payout', value: '**9×** your stake on a correct guess.\n\nExample: Bet ₹500 on **7** → Winning number is **7** → You receive **₹4,500**' },
        { name: 'Rules', value: '• One bet per round per player\n• Round lasts **60 seconds**\n• All 10 numbers have equal natural odds (10% each)\n• Bets lock 1.5 seconds before round closes' },
        { name: 'Bet Limits', value: `Min ₹${MIN_BET} — Max ₹${MAX_BET}` },
        { name: 'Fairness', value: 'Server seed is committed before the round. Revealed after — you can verify the result was not tampered with.' },
      )],
  });
}

async function showHistory(i) {
  const { rows } = await q(
    `SELECT outcome, ended_at FROM game_rounds
     WHERE game='matka' AND ended_at IS NOT NULL
     ORDER BY ended_at DESC LIMIT 10`
  );
  const lines = rows.map(r =>
    `• <t:${Math.floor(new Date(r.ended_at).getTime() / 1000)}:R> — **${r.outcome?.winner ?? '—'}**`
  );
  await i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(Colors.Gold)
      .setTitle('🎲 Matka — Last 10 Results')
      .setDescription(lines.join('\n') || '—')
    ],
  });
}
