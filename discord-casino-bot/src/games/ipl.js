import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive } from '../repo.js';
import { toPaise, fmt } from '../util/money.js';
import { allow } from '../util/rateLimit.js';
import { logBetResult } from '../admin/logs.js';

const RAKE    = 0.03;
const MIN_BET = 10;
const MAX_BET = 100_000;

export function startIplLoop(client) {
  setInterval(() => checkAutoLock(client).catch(e => console.error('[ipl autolock]', e)), 30_000);
}

async function checkAutoLock(client) {
  const { rows } = await q(
    `UPDATE ipl_matches SET status='locked' WHERE status='open' AND lock_at <= now() RETURNING *`
  );
  for (const match of rows) {
    console.log(`[ipl] auto-locked: ${match.title}`);
    await updatePanel(client, match).catch(() => {});
  }
}

export async function handleInteraction(i) {
  if (i.isButton()) {
    const parts = i.customId.split(':');
    if (parts[1] === 'bet')   return openBetModal(i, parts[2], parts[3]);
    if (parts[1] === 'mybet') return showMyBet(i, parts[2]);
  }
  if (i.isModalSubmit()) {
    const parts = i.customId.split(':');
    if (parts[1] === 'betmodal') return placeBet(i, parts[2], parts[3]);
  }
}

function buildEmbed(match) {
  const totalPool = BigInt(match.pool_a) + BigInt(match.pool_b);
  const lockTs    = Math.floor(new Date(match.lock_at).getTime() / 1000);

  let desc, color;
  if (match.status === 'open') {
    desc  = `Betting closes at **<t:${lockTs}:T>**`;
    color = Colors.Green;
  } else if (match.status === 'locked') {
    desc  = '🔒 **Betting is CLOSED — awaiting result**';
    color = Colors.Orange;
  } else if (match.status === 'settled') {
    const winTeam = match.winner === 'a' ? match.team_a : match.team_b;
    desc  = `🏆 **Winner: ${winTeam}** — payouts sent!`;
    color = Colors.Gold;
  } else {
    desc  = '❌ **Match voided — all bets refunded**';
    color = Colors.Grey;
  }

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🏏 ${match.title}`)
    .setDescription(desc)
    .addFields(
      { name: `🔵 ${match.team_a}`, value: fmt(BigInt(match.pool_a)), inline: true },
      { name: `🔴 ${match.team_b}`, value: fmt(BigInt(match.pool_b)), inline: true },
      { name: 'Total Pool',         value: fmt(totalPool),            inline: true },
    );
}

function buildRow(match) {
  const locked = match.status !== 'open';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ipl:bet:${match.id}:a`)
      .setLabel(`Bet 🔵 ${match.team_a}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(locked),
    new ButtonBuilder()
      .setCustomId(`ipl:bet:${match.id}:b`)
      .setLabel(`Bet 🔴 ${match.team_b}`)
      .setStyle(ButtonStyle.Danger)
      .setDisabled(locked),
    new ButtonBuilder()
      .setCustomId(`ipl:mybet:${match.id}`)
      .setLabel('My Bet')
      .setStyle(ButtonStyle.Secondary),
  );
}

export async function postMatchPanel(client, channelId, matchId) {
  const { rows } = await q(`SELECT * FROM ipl_matches WHERE id=$1`, [matchId]);
  const match = rows[0];
  if (!match) return null;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;

  const msg = await channel.send({ embeds: [buildEmbed(match)], components: [buildRow(match)] });
  await q(`UPDATE ipl_matches SET panel_message_id=$1 WHERE id=$2`, [msg.id, matchId]);
  return msg;
}

export async function updatePanel(client, match) {
  if (!match.panel_message_id || !match.channel_id) return;
  try {
    const channel = await client.channels.fetch(match.channel_id).catch(() => null);
    if (!channel) return;
    const msg = await channel.messages.fetch(match.panel_message_id).catch(() => null);
    if (!msg) return;
    await msg.edit({ embeds: [buildEmbed(match)], components: [buildRow(match)] });
  } catch (e) {
    console.error('[ipl] updatePanel:', e.message);
  }
}

function openBetModal(i, matchId, team) {
  const modal = new ModalBuilder()
    .setCustomId(`ipl:betmodal:${matchId}:${team}`)
    .setTitle('IPL Bet');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Stake in ₹')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(`₹${MIN_BET} – ₹${MAX_BET.toLocaleString()}`)
    )
  );
  return i.showModal(modal);
}

async function placeBet(i, matchId, team) {
  if (!allow(i.user.id, Number(process.env.MAX_BETS_PER_SECOND || 4)))
    return i.reply({ ephemeral: true, content: 'Too fast.' });

  const { rows: mr } = await q(`SELECT * FROM ipl_matches WHERE id=$1`, [matchId]);
  const match = mr[0];
  if (!match || match.status !== 'open')
    return i.reply({ ephemeral: true, content: '⏱ Betting is closed for this match.' });

  const amount = Number(i.fields.getTextInputValue('amount'));
  if (!Number.isFinite(amount) || amount < MIN_BET || amount > MAX_BET)
    return i.reply({ ephemeral: true, content: `Bet ₹${MIN_BET}–₹${MAX_BET.toLocaleString()}.` });

  let u;
  try { u = await requireActive(i.user.id, i.user.username); }
  catch { return i.reply({ ephemeral: true, content: '🚫 Your account is suspended.' }); }

  const { rows: existing } = await q(
    `SELECT id FROM ipl_bets WHERE match_id=$1 AND user_id=$2`, [matchId, u.id]
  );
  if (existing.length > 0)
    return i.reply({ ephemeral: true, content: 'You already have a bet on this match.' });

  const stake = toPaise(amount);
  try {
    await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
      ref: matchId, meta: { game: 'ipl', match: match.title, team } });
  } catch {
    return i.reply({ ephemeral: true, content: '💸 Insufficient balance.' });
  }

  // Race check: match might have been locked between the status check and deduction
  const { rows: mr2 } = await q(`SELECT status FROM ipl_matches WHERE id=$1`, [matchId]);
  if (!mr2[0] || mr2[0].status !== 'open') {
    await applyTx({ userId: u.id, type: 'refund', amount: stake, lockDelta: -stake,
      ref: matchId, meta: { game: 'ipl', reason: 'match_locked_race' } }).catch(() => {});
    return i.reply({ ephemeral: true, content: '⏱ Betting just closed — your stake has been refunded.' });
  }

  await q(
    `INSERT INTO ipl_bets(match_id, user_id, discord_id, username, team, stake)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [matchId, u.id, i.user.id, i.user.username, team, stake.toString()]
  );

  const poolCol = team === 'a' ? 'pool_a' : 'pool_b';
  const { rows: updated } = await q(
    `UPDATE ipl_matches SET ${poolCol}=${poolCol}+$1 WHERE id=$2 RETURNING *`,
    [stake.toString(), matchId]
  );
  if (updated[0]) updatePanel(i.client, updated[0]).catch(() => {});

  const teamName = team === 'a' ? match.team_a : match.team_b;
  await i.reply({ ephemeral: true, content: `✅ **${fmt(stake)}** placed on **${teamName}**!` });
}

async function showMyBet(i, matchId) {
  const { rows: mr } = await q(`SELECT * FROM ipl_matches WHERE id=$1`, [matchId]);
  const match = mr[0];
  if (!match) return i.reply({ ephemeral: true, content: 'Match not found.' });

  const { rows: ur } = await q(`SELECT * FROM users WHERE discord_id=$1`, [i.user.id]);
  if (!ur[0]) return i.reply({ ephemeral: true, content: 'No account found.' });

  const { rows: br } = await q(
    `SELECT * FROM ipl_bets WHERE match_id=$1 AND user_id=$2`, [matchId, ur[0].id]
  );
  if (!br[0]) return i.reply({ ephemeral: true, content: "You haven't bet on this match." });

  const bet      = br[0];
  const teamName = bet.team === 'a' ? match.team_a : match.team_b;
  const totalPool = BigInt(match.pool_a) + BigInt(match.pool_b);
  const winPool   = bet.team === 'a' ? BigInt(match.pool_a) : BigInt(match.pool_b);

  let estPayout = 'N/A';
  if (winPool > 0n) {
    const est = (BigInt(bet.stake) * totalPool * BigInt(Math.round((1 - RAKE) * 10_000))) / winPool / 10_000n;
    estPayout = fmt(est);
  }

  const isActive = match.status === 'open' || match.status === 'locked';
  const lines = [
    `Team: **${teamName}**`,
    `Stake: **${fmt(BigInt(bet.stake))}**`,
    `Status: **${bet.result}**`,
    isActive
      ? `Est. payout: **${estPayout}** (if ${teamName} wins, 3% rake)`
      : `Payout: **${bet.payout != null ? fmt(BigInt(bet.payout)) : '₹0'}**`,
  ];

  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Blue)
      .setTitle(`🏏 Your bet — ${match.title}`)
      .setDescription(lines.join('\n'))]
  });
}
