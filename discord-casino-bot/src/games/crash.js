import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset } from '../repo.js';
import { newServerSeed, hash, rngFloat } from '../util/fairness.js';
import { toPaise, fmt } from '../util/money.js';
import { allow } from '../util/rateLimit.js';
import { logBet, logRound, broadcastBigWin } from '../admin/logs.js';

const TICK_MS = 1500;
let state = null;

export async function startCrashLoop(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return console.warn('[crash] no channel');
  await openRound(channel);
  setInterval(() => tick(channel).catch(e => console.error('[crash]', e)), TICK_MS);
}

async function openRound(channel) {
  const serverSeed = newServerSeed();
  const clientSeed = Date.now().toString(36);
  const preset = await getPreset('crash');
  // crash multiplier: house 99% rtp curve  m = 1/(1-r), capped
  const r = rngFloat(serverSeed, clientSeed, 0);
  let m;
  if (preset === 'house')      m = Math.max(1.00, 0.99 / Math.max(0.0001, 1 - r));
  else if (preset === 'low')   m = 1 + r * 9;     // mostly 1-10x, never tiny crash
  else if (preset === 'medium') m = Math.max(1.00, 0.5 + r * 5);
  else                          m = Math.max(1.00, 1 + r * 0.5);  // brutal
  m = Math.min(50, Math.round(m * 100) / 100);

  const { rows } = await q(
    `INSERT INTO game_rounds(game,server_seed_hash,client_seed,nonce,preset_mode,outcome)
     VALUES('crash',$1,$2,0,$3,$4) RETURNING *`,
    [hash(serverSeed), clientSeed, preset, { crashAt: m }]
  );
  state = {
    round: rows[0], serverSeed, crashAt: m, multiplier: 1.0,
    bets: [], cashedOut: new Set(), startedAt: Date.now(),
    panelMessageId: null, ended: false, channel,
  };
  await renderPanel(channel);
}

function multiplierAt(elapsedMs) {
  // exponential growth feel
  return +(Math.pow(1.07, elapsedMs / 1000)).toFixed(2);
}

async function renderPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor(state.ended ? Colors.Red : Colors.Gold)
    .setTitle(state.ended ? `💥 Crashed @ ${state.crashAt.toFixed(2)}×` : `🚀 Crash — ${state.multiplier.toFixed(2)}×`)
    .setDescription(state.ended
      ? `Next round starting…`
      : `Place bets, then **Cash Out** before crash!`)
    .addFields(
      { name: 'Active bets', value: String(state.bets.length), inline: true },
      { name: 'Server seed (commit)', value: '`' + state.round.server_seed_hash.slice(0, 24) + '…`', inline: true },
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('crash:bet').setLabel('Place Bet').setStyle(ButtonStyle.Success).setDisabled(state.ended),
    new ButtonBuilder().setCustomId('crash:cashout').setLabel('Cash Out').setStyle(ButtonStyle.Primary).setDisabled(state.ended),
  );
  if (state.panelMessageId) {
    const msg = await channel.messages.fetch(state.panelMessageId).catch(()=>null);
    if (msg) return msg.edit({ embeds: [embed], components: [row] });
  }
  const m = await channel.send({ embeds: [embed], components: [row] });
  state.panelMessageId = m.id;
}

async function tick(channel) {
  if (!state || state.ended) return;
  const elapsed = Date.now() - state.startedAt;
  state.multiplier = multiplierAt(elapsed);
  if (state.multiplier >= state.crashAt) {
    state.multiplier = state.crashAt;
    state.ended = true;
    await renderPanel(channel);
    await settle(channel);
    setTimeout(() => openRound(channel), 4000);
    return;
  }
  await renderPanel(channel);
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
        ref: state.round.id, meta: { game: 'crash', cashOutAt: b.cashOutAt }});
      if (payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000))
        broadcastBigWin(channel.client, b.username, 'Crash', payout).catch(()=>{});
    } else {
      // lost bet; release lock to zero
      await applyTx({ userId: b.userId, type: 'bet', amount: 0n, lockDelta: -b.stake,
        ref: state.round.id, meta: { game: 'crash', crashed: true }});
    }
    await q(`UPDATE bets SET payout=$1, result=$2, settled_at=now() WHERE id=$3`,
      [payout.toString(), payout > 0n ? 'win' : 'loss', b.betId]);
  }
  await q(
    `UPDATE game_rounds SET server_seed=$1, total_pool=$2, house_pnl=$3, ended_at=now() WHERE id=$4`,
    [state.serverSeed, pool.toString(), (pool - paid).toString(), state.round.id]
  );
  logRound(channel.client, 'crash', state.round.id, { crashAt: state.crashAt, pool: pool.toString(), pnl: (pool - paid).toString() });
  // Reveal server seed for provably-fair verification
  await channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Red)
      .setTitle(`💥 Crashed @ ${state.crashAt.toFixed(2)}×`)
      .setDescription(`Seed reveal: \`${state.serverSeed}\`\nHash: \`${state.round.server_seed_hash}\`\nVerify: HMAC-SHA256(seed, clientSeed:0)`)],
  }).catch(() => {});
}

export async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    const [, action] = interaction.customId.split(':');
    if (action === 'bet') return openBetModal(interaction);
    if (action === 'cashout') return cashOut(interaction);
  }
  if (interaction.isModalSubmit()) return placeBet(interaction);
}

function openBetModal(i) {
  const modal = new ModalBuilder().setCustomId('crash:betmodal').setTitle('Crash bet');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('amount').setLabel('Amount in ₹')
        .setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('auto').setLabel('Auto cash-out (e.g. 2.0, optional)')
        .setStyle(TextInputStyle.Short).setRequired(false)
    ),
  );
  return i.showModal(modal);
}

async function placeBet(i) {
  if (!state || state.ended) return i.reply({ ephemeral: true, content: 'Round closed.' });
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
  } catch (e) {
    return i.reply({ ephemeral: true, content: '💸 Insufficient balance.' });
  }
  const { rows: br } = await q(
    `INSERT INTO bets(user_id,round_id,game,stake,selection,result)
     VALUES($1,$2,'crash',$3,$4,'pending') RETURNING id`,
    [u.id, state.round.id, stake.toString(), { auto }]
  );
  state.bets.push({ userId: u.id, discordId: i.user.id, username: i.user.username, stake, betId: br[0].id, auto });
  logBet(i.client, { user: i.user.username, game: 'crash', stake: stake.toString() });
  await i.reply({ ephemeral: true, content: `✅ ${fmt(stake)} placed.${auto ? ` Auto cash-out @ ${auto}×.` : ''}` });
}

async function cashOut(i) {
  if (!state || state.ended) return i.reply({ ephemeral: true, content: 'Too late.' });
  const b = state.bets.find(x => x.discordId === i.user.id);
  if (!b) return i.reply({ ephemeral: true, content: 'No active bet.' });
  if (state.cashedOut.has(b.userId)) return i.reply({ ephemeral: true, content: 'Already cashed out.' });
  state.cashedOut.add(b.userId);
  b.cashOutAt = state.multiplier;
  await i.reply({ ephemeral: true, content: `💰 Cashed out @ ${b.cashOutAt.toFixed(2)}× — payout ${fmt(BigInt(Math.floor(Number(b.stake) * b.cashOutAt)))}` });
}

// auto cashout check (called every tick)
setInterval(() => {
  if (!state || state.ended) return;
  for (const b of state.bets) {
    if (b.auto && !state.cashedOut.has(b.userId) && state.multiplier >= b.auto) {
      state.cashedOut.add(b.userId);
      b.cashOutAt = b.auto;
    }
  }
}, 250);
