import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset, logAudit } from '../repo.js';
import { newServerSeed, hash, rngFloat } from '../util/fairness.js';
import { pickOutcome } from './outcome.js';
import { toPaise, fmt } from '../util/money.js';
import { allow } from '../util/rateLimit.js';
import { logBetResult, logRound, broadcastBigWin } from '../admin/logs.js';

const ROUND_MS = 25_000;
const OPTIONS = [
  { key: 'green',  payoutMultiplier: 2,  naturalProbability: 0.45, color: '🟢' },
  { key: 'red',    payoutMultiplier: 2,  naturalProbability: 0.45, color: '🔴' },
  { key: 'violet', payoutMultiplier: 8,  naturalProbability: 0.10, color: '🟣' },
];

let state = null;
const lastResults = [];
const resultMsgIds = [];
const allPanelMsgIds = new Set(); // track every panel message ever posted so we can purge them

async function pushResult(channel, embed) {
  const msg = await channel.send({ embeds: [embed] });
  if (resultMsgIds.length > 0) {
    const old = resultMsgIds.shift();
    channel.messages.fetch(old).then(m => m.delete()).catch(() => {});
  }
  resultMsgIds.push(msg.id);
}

export async function startColourLoop(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return console.warn('[colour] no channel');
  // Delete old bot messages so stale buttons don't persist after restart
  const old = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (old) for (const m of old.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => {});
  await postPanel(channel);
  setInterval(() => tick(channel).catch(e => console.error('[colour]', e)), ROUND_MS);
  // Edit-only refresh every 8s for mobile — never posts a new message
  setInterval(async () => {
    if (!state?.panelMessageId) return;
    try {
      const msg = await channel.messages.fetch(state.panelMessageId);
      const embed = buildEmbed();
      await msg.edit({ embeds: [embed], components: [buildRow()] });
    } catch {} // silently skip if message gone
  }, 8_000);
}

async function postPanel(channel) {
  // start first round
  await openRound();
  await renderPanel(channel);
}

async function openRound() {
  const serverSeed = newServerSeed();
  const clientSeed = Date.now().toString(36);
  const preset = await getPreset('colour');
  const { rows } = await q(
    `INSERT INTO game_rounds(game,server_seed_hash,client_seed,nonce,preset_mode)
     VALUES('colour',$1,$2,0,$3)
     RETURNING *`,
    [hash(serverSeed), clientSeed, preset]
  );
  state = {
    round: rows[0],
    serverSeed,
    pool: { green: 0n, red: 0n, violet: 0n },
    bets: [],   // {userId, key, stake}
    endsAt: Date.now() + ROUND_MS,
    panelMessageId: null,
  };
}

function buildEmbed() {
  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('🎨 Colour Prediction')
    .setDescription(`Round closes at **<t:${Math.floor(state.endsAt / 1000)}:T>**`)
    .addFields(
      { name: '🟢 Green (2×)',  value: fmt(state.pool.green),  inline: true },
      { name: '🔴 Red (2×)',    value: fmt(state.pool.red),    inline: true },
      { name: '🟣 Violet (8×)', value: fmt(state.pool.violet), inline: true },
      { name: 'Last 15',
        value: lastResults.length
          ? lastResults.map(r => OPTIONS.find(o => o.key === r).color).join(' ')
          : '—' },
      { name: 'Server seed (commit)', value: '`' + state.round.server_seed_hash.slice(0, 24) + '…`' },
    );
}

function buildRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('colour:bet:green').setLabel('Bet 🟢').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('colour:bet:red').setLabel('Bet 🔴').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('colour:bet:violet').setLabel('Bet 🟣').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('colour:history').setLabel('📊 History').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('colour:rules').setLabel('📋 Rules').setStyle(ButtonStyle.Secondary),
  );
}

async function renderPanel(channel) {
  if (state.panelMessageId) {
    const msg = await channel.messages.fetch(state.panelMessageId).catch(() => null);
    if (msg) return msg.edit({ embeds: [buildEmbed()], components: [buildRow()] });
    // message gone — fall through to post a fresh one
  }
  const m = await channel.send({ embeds: [buildEmbed()], components: [buildRow()] });
  state.panelMessageId = m.id;
  allPanelMsgIds.add(m.id);
}

async function tick(channel) {
  if (!state) return;
  const settled = state;
  state = null; // lock out new bets during settlement

  // Delete ALL tracked panel messages (prevents accumulation)
  for (const id of allPanelMsgIds) {
    channel.messages.fetch(id).then(m => m.delete()).catch(() => {});
  }
  allPanelMsgIds.clear();

  // 1. Settle the round
  const preset = settled.round.preset_mode || await getPreset('colour');
  const rng = rngFloat(settled.serverSeed, settled.round.client_seed, 0);
  const winner = pickOutcome(OPTIONS, settled.pool, preset, rng);
  const winOpt = OPTIONS.find(o => o.key === winner);

  let pool = 0n, paid = 0n;
  for (const b of settled.bets) {
    pool += b.stake;
    const win = b.key === winner;
    const payout = win ? b.stake * BigInt(winOpt.payoutMultiplier) : 0n;
    paid += payout;
    await applyTx({
      userId: b.userId, type: win ? 'win' : 'bet', amount: win ? payout : 0n,
      lockDelta: -b.stake, ref: settled.round.id,
      meta: { game: 'colour', selection: b.key, result: winner, payout: payout.toString() }
    });
    await q(
      `UPDATE bets SET payout=$1, result=$2, settled_at=now() WHERE id=$3`,
      [payout.toString(), win ? 'win' : 'loss', b.betId]
    );
    logBetResult(channel.client, { user: b.username, discordId: b.discordId, game: 'colour', stake: b.stake.toString(), payout: payout.toString(), result: win ? 'win' : 'loss' });
    if (win && payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000)) {
      broadcastBigWin(channel.client, b.username, 'Colour', payout).catch(()=>{});
    }
  }
  await q(
    `UPDATE game_rounds SET server_seed=$1, outcome=$2, total_pool=$3, house_pnl=$4, ended_at=now() WHERE id=$5`,
    [settled.serverSeed, { winner }, pool.toString(), (pool - paid).toString(), settled.round.id]
  );
  lastResults.unshift(winner);
  if (lastResults.length > 15) lastResults.pop();
  logRound(channel.client, 'colour', settled.round.id, { winner, pool: pool.toString(), pnl: (pool - paid).toString(), preset });

  // 2. Post result before starting next round (auto-removes oldest if > 3)
  await pushResult(channel, new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle(`🎨 Result: ${winOpt.color} ${winner.toUpperCase()}`)
    .setDescription(`Pool: **${fmt(pool)}** • Paid: **${fmt(paid)}**\nReveal seed: \`${settled.serverSeed.slice(0, 24)}…\``));

  // 3. Open next round after result is posted
  await openRound();
  await renderPanel(channel);
}

// Interaction routing ──────────────────────────────────────────────
export async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    const [, action, key] = interaction.customId.split(':');
    if (action === 'bet') return openBetModal(interaction, key);
    if (action === 'history') return showHistory(interaction);
    if (action === 'rules') return showRules(interaction);
  }
  if (interaction.isModalSubmit()) {
    const [, , key] = interaction.customId.split(':');
    return placeBet(interaction, key);
  }
}

function openBetModal(i, key) {
  const modal = new ModalBuilder()
    .setCustomId(`colour:betmodal:${key}`)
    .setTitle(`Bet on ${key.toUpperCase()}`);
  const input = new TextInputBuilder()
    .setCustomId('amount').setLabel('Amount in ₹')
    .setStyle(TextInputStyle.Short).setRequired(true)
    .setPlaceholder(`min ${process.env.MIN_BET || 10}`);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return i.showModal(modal);
}

async function placeBet(i, key) {
  if (!allow(i.user.id, Number(process.env.MAX_BETS_PER_SECOND || 4)))
    return i.reply({ ephemeral: true, content: 'Slow down — too many bets.' });

  if (!state) return i.reply({ ephemeral: true, content: 'No round in progress.' });
  const remaining = state.endsAt - Date.now();
  if (remaining < 1500) return i.reply({ ephemeral: true, content: '⏱ Round closing — bets locked.' });

  const amount = Number(i.fields.getTextInputValue('amount'));
  const min = Number(process.env.MIN_BET || 10);
  const max = Number(process.env.MAX_BET || 10000);
  if (!Number.isFinite(amount) || amount < min || amount > max)
    return i.reply({ ephemeral: true, content: `Bet must be between ₹${min} and ₹${max}.` });

  let u;
  try { u = await requireActive(i.user.id, i.user.username); }
  catch { return i.reply({ ephemeral: true, content: '🚫 Your account is suspended.' }); }
  const stake = toPaise(amount);

  try {
    await applyTx({
      userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
      ref: state.round.id, meta: { game: 'colour', selection: key }
    });
  } catch (e) {
    if (String(e.message).includes('INSUFFICIENT_FUNDS'))
      return i.reply({ ephemeral: true, content: '💸 Insufficient balance.' });
    throw e;
  }
  const { rows: br } = await q(
    `INSERT INTO bets(user_id,round_id,game,stake,selection,result)
     VALUES ($1,$2,'colour',$3,$4,'pending') RETURNING id`,
    [u.id, state.round.id, stake.toString(), { key }]
  );
  state.pool[key] += stake;
  state.bets.push({ userId: u.id, discordId: i.user.id, username: i.user.username, key, stake, betId: br[0].id });

  await i.reply({ ephemeral: true,
    content: `✅ Bet placed: ${fmt(stake)} on **${key.toUpperCase()}**.`
  });
}

async function showHistory(i) {
  const { rows } = await q(
    `SELECT outcome, ended_at FROM game_rounds WHERE game='colour' AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 10`
  );
  const lines = rows.map(r => `• <t:${Math.floor(new Date(r.ended_at).getTime()/1000)}:R> — **${r.outcome?.winner ?? '—'}**`);
  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('Last 10 rounds').setDescription(lines.join('\n') || '—')]
  });
}

function showRules(i) {
  return i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎨 Colour Prediction — How to Play')
      .addFields(
        { name: 'Objective', value: 'Predict which colour wins before the round closes. Each round lasts **25 seconds**.' },
        { name: 'Colours & Payouts', value: '🟢 **Green** — pays **2×** your stake (45% chance)\n🔴 **Red** — pays **2×** your stake (45% chance)\n🟣 **Violet** — pays **8×** your stake (10% chance)' },
        { name: 'How to Bet', value: '1. Click **Bet 🟢**, **Bet 🔴**, or **Bet 🟣**\n2. Enter your stake amount\n3. Wait for the round to end — winners are paid instantly' },
        { name: 'Bet Limits', value: `Min ₹${process.env.MIN_BET || 10} — Max ₹${process.env.MAX_BET || 10000}` },
        { name: 'Fairness', value: 'The server seed hash is shown before each round and revealed after. You can verify the result was not changed.' },
      )],
  });
}
