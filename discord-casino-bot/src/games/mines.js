import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset, getUserPreset, loadSession, saveSession, deleteSession } from '../repo.js';
import { resolveAmountPreset } from '../util/amountPreset.js';
import { newServerSeed, rngFloat } from '../util/fairness.js';
import { toPaise, fmt } from '../util/money.js';
import { logBetResult, broadcastBigWin } from '../admin/logs.js';

const lastBet = new Map(); // discordId -> { amount, mines }

// ─── Session helpers (DB-backed, survives restarts) ──────────────────

function sessionToData(s) {
  return {
    userId:     s.userId,
    username:   s.username,
    stake:      s.stake.toString(),
    mines:      s.mines,
    bombs:      [...s.bombs],
    revealed:   [...s.revealed],
    seed:       s.seed,
    preset:     s.preset,
    betId:      s.betId,
    multiplier: s.multiplier,
  };
}

function dataToSession(d) {
  return {
    userId:     d.userId,
    username:   d.username,
    stake:      BigInt(d.stake),
    mines:      d.mines,
    bombs:      new Set(d.bombs),
    revealed:   new Set(d.revealed),
    seed:       d.seed,
    preset:     d.preset,
    betId:      d.betId,
    multiplier: d.multiplier,
  };
}

async function getSession(discordId) {
  const row = await loadSession(discordId, 'mines');
  return row ? dataToSession(row.data) : null;
}

async function putSession(userId, discordId, s) {
  await saveSession(userId, 'mines', sessionToData(s), s.betId);
}

async function clearSession(userId) {
  await deleteSession(userId, 'mines');
}

// ─── Panel ───────────────────────────────────────────────────────────

export function postPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('💣 Mines')
      .setDescription('Pick safe tiles, cash out anytime. Hitting a mine = lose your stake.')
      .addFields({ name: '👥 Bets today', value: String(Math.floor(Math.random() * 21) + 30), inline: true })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mines:start').setLabel('💣 New Game').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mines:rules').setLabel('📋 Rules').setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function handleInteraction(i) {
  if (i.isButton()) {
    const [, action, ...rest] = i.customId.split(':');
    if (action === 'start')   return openModal(i);
    if (action === 'rules')   return showRules(i);
    if (action === 'rebet')   return rebet(i);
    if (action === 'tile')    return revealTile(i, +rest[0], +rest[1]);
    if (action === 'cashout') return cashOut(i);
  }
  if (i.isModalSubmit()) return startGame(i);
}

function showRules(i) {
  return i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('💣 Mines — How to Play')
      .addFields(
        { name: 'Objective', value: 'Reveal safe tiles on a 4×5 grid (20 tiles). Each safe tile increases your multiplier. Cash out before hitting a mine!' },
        { name: 'How to Play', value: '1. Set your **stake** and number of **mines** (1–19)\n2. Click tiles to reveal them\n3. 💎 = safe (multiplier increases)\n4. 💣 = mine (you lose your stake)\n5. Click **Cash Out** anytime to collect your winnings' },
        { name: 'Multiplier', value: 'Grows with each safe tile revealed. More mines = higher multiplier per tile.' },
        { name: 'Examples',value: '• 3 mines, 1 safe tile revealed → ~**1.16×**\n• 3 mines, 5 safe tiles → ~**2.00×**\n• 10 mines, 3 safe tiles → ~**4.5×**' },
        { name: 'Bet Limits', value: `Min ₹${process.env.MIN_BET || 10} — Max ₹${process.env.MAX_BET || 10000}` },
      )],
  });
}

function openModal(i) {
  const m = new ModalBuilder().setCustomId('mines:setup').setTitle('Mines setup');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('amount').setLabel('Stake ₹')
        .setStyle(TextInputStyle.Short).setRequired(true)
        .setPlaceholder(`min ₹${process.env.MIN_BET || 1} – max ₹${process.env.MAX_BET || 10000}`)),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('mines').setLabel('Mines (1-19)')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue('3')),
  );
  return i.showModal(m);
}

async function startGame(i) {
  await i.deferReply({ ephemeral: true });
  const amount = Number(i.fields.getTextInputValue('amount'));
  const mines  = Math.min(19, Math.max(1, Math.floor(Number(i.fields.getTextInputValue('mines')))));
  await executeStartGame(i, amount, mines);
}

async function rebet(i) {
  await i.deferReply({ ephemeral: true });
  const last = lastBet.get(i.user.id);
  if (!last) return i.editReply({ content: '⚠️ No previous game found. Use 💣 New Game first to set your bet.' });
  await executeStartGame(i, last.amount, last.mines);
}

async function executeStartGame(i, amount, mines) {
  try {
    const min = Number(process.env.MIN_BET || 10), max = Number(process.env.MAX_BET || 10000);
    if (!Number.isFinite(amount) || amount < min || amount > max)
      return i.editReply({ content: `Stake ₹${min}–₹${max}.` });

    let u;
    try { u = await requireActive(i.user.id, i.user.username); }
    catch (e) {
      if (e.code === 'NOT_FOUND') return i.editReply({ content: '⚠️ No account found — interact with the bot in another channel first.' });
      return i.editReply({ content: '🚫 Your account is suspended.' });
    }

    // Abort any existing session (refund orphaned stake)
    const existing = await getSession(i.user.id).catch(() => null);
    if (existing) {
      try {
        await applyTx({ userId: existing.userId, type: 'bet', amount: 0n, lockDelta: -existing.stake,
          ref: null, meta: { game: 'mines', result: 'abandoned' } });
        await q(`UPDATE bets SET result='abandoned', settled_at=now() WHERE id=$1`, [existing.betId]);
      } catch (e) { console.warn('[mines] abandon failed:', e.message); }
      await clearSession(existing.userId).catch(() => {});
    }

    const stake = toPaise(amount);
    const seed = newServerSeed();
    const preset = (await getUserPreset(u.id, 'mines')) ?? (await resolveAmountPreset(stake)) ?? await getPreset('mines');
    const bombs = new Set();
    let n = 0;
    while (bombs.size < mines) bombs.add(Math.floor(rngFloat(seed, 'b', n++) * 20));

    try {
      await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
        ref: null, meta: { game: 'mines', mines } });
    } catch { return i.editReply({ content: '💸 Insufficient balance.' }); }

    const { rows: br } = await q(
      `INSERT INTO bets(user_id,game,stake,selection,result)
       VALUES($1,'mines',$2,$3,'pending') RETURNING id`,
      [u.id, stake.toString(), { mines }]
    );
    const s = { userId: u.id, username: i.user.username, stake, mines, bombs,
      revealed: new Set(), seed, preset, betId: br[0].id, multiplier: 1.0 };
    await putSession(u.id, i.user.id, s);

    lastBet.set(i.user.id, { amount, mines });

    await i.editReply(renderBoard(s));
  } catch (e) {
    console.error('[mines startGame]', e);
    await i.editReply({ content: '⚠️ Something went wrong, please try again.' }).catch(() => {});
  }
}

function payoutMultiplier(safeRevealed, mines) {
  return +Math.pow(20 / (20 - mines), safeRevealed) * 0.97;
}

// Grid is 4×5 = 20 tiles (indices 0-19) + action row = exactly 5 Discord action rows
function renderBoard(s, revealAll = false, outcome = 'playing') {
  const gemsFound = [...s.revealed].filter(idx => !s.bombs.has(idx)).length;
  const safeTotal = 20 - s.mines;
  const payout    = BigInt(Math.floor(Number(s.stake) * s.multiplier));
  const nextMult  = gemsFound < safeTotal ? payoutMultiplier(gemsFound + 1, s.mines) : null;
  const nextPay   = nextMult ? BigInt(Math.floor(Number(s.stake) * nextMult)) : null;

  let color, title, desc;
  if (outcome === 'loss') {
    color = Colors.Red;
    title = '💥 Mine Hit!';
    desc  = `You hit a mine and lost **${fmt(s.stake)}**.\n💎 Found **${gemsFound}** gem${gemsFound !== 1 ? 's' : ''} before detonation.`;
  } else if (outcome === 'win') {
    color = Colors.Green;
    title = `🏆 Cashed Out — ${s.multiplier.toFixed(2)}×`;
    desc  = `Won **${fmt(payout)}** • 💎 **${gemsFound}** gem${gemsFound !== 1 ? 's' : ''} collected safely.`;
  } else {
    color = gemsFound > 0 ? Colors.Gold : Colors.DarkGrey;
    title = `💣 Mines — ${s.mines} mine${s.mines !== 1 ? 's' : ''}`;
    if (gemsFound > 0) {
      desc = [
        `💎 **${gemsFound}** found  •  **${s.multiplier.toFixed(2)}×**  •  Cash Out: **${fmt(payout)}**`,
        nextMult ? `➡️ Next gem: **${nextMult.toFixed(2)}×** → ${fmt(nextPay)}` : `🎯 All gems found — cash out now!`,
      ].join('\n');
    } else {
      desc = [
        `**Stake:** ${fmt(s.stake)}  •  **Mines:** ${s.mines}  •  **Safe tiles:** ${safeTotal}`,
        nextMult ? `💡 First gem pays **${nextMult.toFixed(2)}×** → ${fmt(nextPay)}` : '',
      ].filter(Boolean).join('\n');
    }
  }

  const rows = [];
  for (let r = 0; r < 4; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 5; c++) {
      const idx    = r * 5 + c;
      const isBomb = s.bombs.has(idx);
      const isOpen = s.revealed.has(idx) || revealAll;
      let label = '⬜', style = ButtonStyle.Secondary;
      if (isOpen) {
        if (isBomb) { label = '💣'; style = ButtonStyle.Danger; }
        else        { label = '💎'; style = ButtonStyle.Success; }
      }
      row.addComponents(
        new ButtonBuilder().setCustomId(`mines:tile:${r}:${c}`).setLabel(label)
          .setStyle(style).setDisabled(isOpen || revealAll)
      );
    }
    rows.push(row);
  }

  if (revealAll) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mines:rebet').setLabel('🔁 Bet Again').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('mines:start').setLabel('💣 Change Bet').setStyle(ButtonStyle.Secondary),
    ));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mines:cashout')
        .setLabel(gemsFound > 0 ? `💰 Cash Out — ${fmt(payout)}` : 'Cash Out')
        .setStyle(ButtonStyle.Primary).setDisabled(gemsFound === 0),
    ));
  }

  return {
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc)],
    components: rows,
  };
}

async function revealTile(i, r, c) {
  const s = await getSession(i.user.id);
  if (!s) return i.reply({ ephemeral: true, content: 'No active game. Click New Game.' });
  const idx = r * 5 + c;

  if (s.preset === 'low' && s.bombs.has(idx) && s.revealed.size === 0) {
    const safeIdx = [...Array(20).keys()].find(k => !s.bombs.has(k));
    s.bombs.delete(idx); s.bombs.add(safeIdx);
  } else if ((s.preset === 'high' || s.preset === 'extreme') && !s.bombs.has(idx) && s.revealed.size === 0) {
    const removeBomb = [...s.bombs][0];
    s.bombs.delete(removeBomb); s.bombs.add(idx);
  }

  s.revealed.add(idx);
  if (s.bombs.has(idx)) {
    await applyTx({ userId: s.userId, type: 'bet', amount: 0n, lockDelta: -s.stake,
      ref: null, meta: { game: 'mines', result: 'bomb' } });
    await q(`UPDATE bets SET payout=0, result='loss', settled_at=now() WHERE id=$1`, [s.betId]);
    await clearSession(s.userId);
    logBetResult(i.client, { user: s.username, discordId: i.user.id, game: 'mines', stake: s.stake.toString(), payout: '0', result: 'loss' });
    return i.update(renderBoard(s, true, 'loss'));
  }
  s.multiplier = payoutMultiplier(s.revealed.size, s.mines);
  await putSession(s.userId, i.user.id, s);
  await i.update(renderBoard(s));
}

async function cashOut(i) {
  const s = await getSession(i.user.id);
  if (!s) return i.reply({ ephemeral: true, content: 'No active game.' });
  const payout = BigInt(Math.floor(Number(s.stake) * s.multiplier));
  await applyTx({ userId: s.userId, type: 'win', amount: payout, lockDelta: -s.stake,
    ref: null, meta: { game: 'mines', multiplier: s.multiplier } });
  await q(`UPDATE bets SET payout=$1, result='win', settled_at=now() WHERE id=$2`,
    [payout.toString(), s.betId]);
  logBetResult(i.client, { user: s.username, discordId: i.user.id, game: 'mines', stake: s.stake.toString(), payout: payout.toString(), result: 'win' });
  if (payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000))
    broadcastBigWin(i.client, i.user.username, 'Mines', payout).catch(() => {});
  await clearSession(s.userId);
  await i.update(renderBoard(s, true, 'win'));
}
