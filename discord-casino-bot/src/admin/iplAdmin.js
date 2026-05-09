import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx } from '../repo.js';
import { fmt } from '../util/money.js';
import { logBetResult } from './logs.js';
import { postMatchPanel, updatePanel } from '../games/ipl.js';

const RAKE = 0.03;
const adminIds = () => (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdmin  = (id) => adminIds().includes(id);

export async function handleIplAdmin(i) {
  if (!isAdmin(i.user.id)) return i.reply({ ephemeral: true, content: 'Not authorised.' });

  if (i.isButton()) {
    const parts = i.customId.split(':');
    if (parts[1] === 'list')   return listMatches(i);
    if (parts[1] === 'create') return openCreateModal(i);
    if (parts[1] === 'manage') return showManage(i, parts[2]);
    if (parts[1] === 'lock')   return lockMatch(i, parts[2]);
    if (parts[1] === 'settle') return settleMatch(i, parts[2], parts[3]);
    if (parts[1] === 'void')   return voidMatch(i, parts[2]);
  }
  if (i.isModalSubmit() && i.customId === 'ipladmin:createmodal') {
    return createMatch(i);
  }
}

async function listMatches(i) {
  const { rows } = await q(
    `SELECT * FROM ipl_matches WHERE status IN ('open','locked') ORDER BY created_at DESC LIMIT 10`
  );

  const createBtn = new ButtonBuilder()
    .setCustomId('ipladmin:create')
    .setLabel('➕ Create Match')
    .setStyle(ButtonStyle.Success);

  if (!rows.length) {
    return i.reply({ ephemeral: true,
      content: 'No active matches.',
      components: [new ActionRowBuilder().addComponents(createBtn)],
    });
  }

  const lines = rows.map(r => {
    const lockTs = Math.floor(new Date(r.lock_at).getTime() / 1000);
    const total  = BigInt(r.pool_a) + BigInt(r.pool_b);
    return `• **${r.title}** [${r.status.toUpperCase()}] — ${fmt(total)} — locks <t:${lockTs}:T>`;
  });

  // Max 4 manage buttons + 1 create = 5 per row
  const manageButtons = rows.slice(0, 4).map(r =>
    new ButtonBuilder()
      .setCustomId(`ipladmin:manage:${r.id}`)
      .setLabel(r.title.slice(0, 25))
      .setStyle(ButtonStyle.Primary)
  );

  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle('🏏 Active IPL Matches')
      .setDescription(lines.join('\n'))],
    components: [new ActionRowBuilder().addComponents(...manageButtons, createBtn)],
  });
}

async function showManage(i, matchId) {
  const { rows } = await q(`SELECT * FROM ipl_matches WHERE id=$1`, [matchId]);
  const m = rows[0];
  if (!m) return i.reply({ ephemeral: true, content: 'Match not found.' });

  const totalPool = BigInt(m.pool_a) + BigInt(m.pool_b);
  const lockTs    = Math.floor(new Date(m.lock_at).getTime() / 1000);
  const { rows: betCount } = await q(
    `SELECT COUNT(*) AS n FROM ipl_bets WHERE match_id=$1`, [matchId]
  );

  const embed = new EmbedBuilder().setColor(Colors.Gold)
    .setTitle(`🏏 ${m.title}`)
    .addFields(
      { name: 'Status',         value: m.status.toUpperCase(),  inline: true },
      { name: `${m.team_a}`,   value: fmt(BigInt(m.pool_a)),   inline: true },
      { name: `${m.team_b}`,   value: fmt(BigInt(m.pool_b)),   inline: true },
      { name: 'Total Pool',     value: fmt(totalPool),          inline: true },
      { name: 'Bets Placed',    value: String(betCount[0].n),   inline: true },
      { name: 'Locks at',       value: `<t:${lockTs}:T>`,       inline: true },
    );

  const components = [];
  if (m.status === 'open') {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ipladmin:lock:${m.id}`).setLabel('🔒 Lock Now').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ipladmin:void:${m.id}`).setLabel('❌ Void Match').setStyle(ButtonStyle.Secondary),
    ));
  } else if (m.status === 'locked') {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ipladmin:settle:${m.id}:a`).setLabel(`🏆 ${m.team_a} Wins`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ipladmin:settle:${m.id}:b`).setLabel(`🏆 ${m.team_b} Wins`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ipladmin:void:${m.id}`).setLabel('❌ Void').setStyle(ButtonStyle.Secondary),
    ));
  }

  await i.reply({ ephemeral: true, embeds: [embed], components });
}

function openCreateModal(i) {
  const m = new ModalBuilder().setCustomId('ipladmin:createmodal').setTitle('Create IPL Match');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title')
        .setLabel('Match title (e.g. MI vs CSK #42)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('team_a')
        .setLabel('Team A name (e.g. Mumbai Indians)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('team_b')
        .setLabel('Team B name (e.g. Chennai Super Kings)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('lock_mins')
        .setLabel('Lock betting in X minutes from now')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue('60')
    ),
  );
  return i.showModal(m);
}

async function createMatch(i) {
  await i.deferReply({ ephemeral: true });
  try {
    const title    = i.fields.getTextInputValue('title').trim();
    const teamA    = i.fields.getTextInputValue('team_a').trim();
    const teamB    = i.fields.getTextInputValue('team_b').trim();
    const lockMins = Math.max(1, Math.floor(Number(i.fields.getTextInputValue('lock_mins')) || 60));
    const lockAt   = new Date(Date.now() + lockMins * 60_000);
    const channelId = process.env.CH_IPL;

    if (!channelId) return i.editReply({ content: '⚠️ CH_IPL environment variable is not set.' });
    if (!title || !teamA || !teamB) return i.editReply({ content: 'All fields are required.' });

    const { rows } = await q(
      `INSERT INTO ipl_matches(title, team_a, team_b, lock_at, channel_id, created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [title, teamA, teamB, lockAt, channelId, i.user.id]
    );
    await postMatchPanel(i.client, channelId, rows[0].id);
    await i.editReply({ content: `✅ Match **${title}** created! Betting open for **${lockMins} min**.` });
  } catch (e) {
    console.error('[ipl createMatch]', e);
    await i.editReply({ content: `❌ Error: ${e.message?.slice(0, 200) ?? 'unknown'}` });
  }
}

async function lockMatch(i, matchId) {
  const { rows } = await q(
    `UPDATE ipl_matches SET status='locked' WHERE id=$1 AND status='open' RETURNING *`,
    [matchId]
  );
  if (!rows[0]) return i.reply({ ephemeral: true, content: 'Match not found or already locked.' });
  await updatePanel(i.client, rows[0]).catch(() => {});
  await i.reply({ ephemeral: true, content: `🔒 Betting locked for **${rows[0].title}**.` });
}

async function settleMatch(i, matchId, winner) {
  await i.deferReply({ ephemeral: true });
  try {
    const { rows: mr } = await q(`SELECT * FROM ipl_matches WHERE id=$1`, [matchId]);
    const match = mr[0];
    if (!match || match.status !== 'locked')
      return i.editReply({ content: 'Match must be in locked state before settling.' });

    await q(
      `UPDATE ipl_matches SET status='settled', winner=$1, settled_at=now() WHERE id=$2`,
      [winner, matchId]
    );

    const { rows: bets } = await q(
      `SELECT * FROM ipl_bets WHERE match_id=$1 AND result='pending'`, [matchId]
    );
    const totalPool = BigInt(match.pool_a) + BigInt(match.pool_b);
    const winPool   = winner === 'a' ? BigInt(match.pool_a) : BigInt(match.pool_b);

    let paid = 0n;
    for (const bet of bets) {
      const stake    = BigInt(bet.stake);
      const isWinner = bet.team === winner;
      let payout     = 0n;

      if (isWinner && winPool > 0n) {
        payout = (stake * totalPool * BigInt(Math.round((1 - RAKE) * 10_000))) / winPool / 10_000n;
      }

      await applyTx({
        userId: bet.user_id, type: isWinner ? 'win' : 'bet',
        amount: isWinner ? payout : 0n, lockDelta: -stake,
        ref: matchId, meta: { game: 'ipl', team: bet.team, winner },
      });
      await q(
        `UPDATE ipl_bets SET payout=$1, result=$2, settled_at=now() WHERE id=$3`,
        [payout.toString(), isWinner ? 'win' : 'loss', bet.id]
      );
      logBetResult(i.client, {
        user: bet.username, discordId: bet.discord_id, game: 'ipl',
        stake: stake.toString(), payout: payout.toString(), result: isWinner ? 'win' : 'loss',
      });
      if (isWinner) paid += payout;
    }

    const { rows: settled } = await q(`SELECT * FROM ipl_matches WHERE id=$1`, [matchId]);
    await updatePanel(i.client, settled[0]).catch(() => {});

    const winTeam     = winner === 'a' ? match.team_a : match.team_b;
    const houseProfit = totalPool - paid;
    await i.editReply({
      content: [
        `🏆 **${winTeam}** declared winner!`,
        `Pool: ${fmt(totalPool)} • Paid out: ${fmt(paid)} • House: ${fmt(houseProfit)}`,
        `${bets.length} bets settled.`,
      ].join('\n'),
    });
  } catch (e) {
    console.error('[ipl settleMatch]', e);
    await i.editReply({ content: `❌ Error: ${e.message?.slice(0, 200) ?? 'unknown'}` });
  }
}

async function voidMatch(i, matchId) {
  await i.deferReply({ ephemeral: true });
  try {
    const { rows: mr } = await q(
      `UPDATE ipl_matches SET status='void', settled_at=now()
       WHERE id=$1 AND status IN ('open','locked') RETURNING *`,
      [matchId]
    );
    if (!mr[0]) return i.editReply({ content: 'Match not found or already settled/void.' });
    const match = mr[0];

    const { rows: bets } = await q(
      `SELECT * FROM ipl_bets WHERE match_id=$1 AND result='pending'`, [matchId]
    );
    for (const bet of bets) {
      const stake = BigInt(bet.stake);
      await applyTx({ userId: bet.user_id, type: 'refund', amount: stake, lockDelta: -stake,
        ref: matchId, meta: { game: 'ipl', reason: 'match_void' } });
      await q(
        `UPDATE ipl_bets SET payout=$1, result='void', settled_at=now() WHERE id=$2`,
        [stake.toString(), bet.id]
      );
    }

    await updatePanel(i.client, match).catch(() => {});
    await i.editReply({ content: `❌ **${match.title}** voided. ${bets.length} bet(s) fully refunded.` });
  } catch (e) {
    console.error('[ipl voidMatch]', e);
    await i.editReply({ content: `❌ Error: ${e.message?.slice(0, 200) ?? 'unknown'}` });
  }
}
