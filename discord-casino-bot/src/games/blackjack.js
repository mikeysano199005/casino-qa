import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
} from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset, loadSession, saveSession, deleteSession } from '../repo.js';
import { resolveAmountPreset } from '../util/amountPreset.js';
import { newServerSeed, rngFloat } from '../util/fairness.js';
import { toPaise, fmt } from '../util/money.js';
import { logBetResult, broadcastBigWin } from '../admin/logs.js';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function newDeck(seed) {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rngFloat(seed, 'shuffle', i) * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const r = c.slice(0, -1);
    if (r === 'A') { total += 11; aces++; }
    else if (['K', 'Q', 'J', '10'].includes(r)) total += 10;
    else total += +r;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isNatural(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

// ─── Session helpers (DB-backed) ─────────────────────────────────────

function sessionToData(s) {
  return {
    userId:  s.userId,
    stake:   s.stake.toString(),
    deck:    s.deck,
    player:  s.player,
    dealer:  s.dealer,
    betId:   s.betId,
    doubled: s.doubled,
  };
}

function dataToSession(d) {
  return {
    userId:  d.userId,
    stake:   BigInt(d.stake),
    deck:    d.deck,
    player:  d.player,
    dealer:  d.dealer,
    betId:   d.betId,
    doubled: d.doubled,
  };
}

async function getSession(discordId) {
  const row = await loadSession(discordId, 'blackjack');
  return row ? dataToSession(row.data) : null;
}

async function putSession(userId, discordId, s) {
  await saveSession(userId, 'blackjack', sessionToData(s), s.betId);
}

async function clearSession(userId) {
  await deleteSession(userId, 'blackjack');
}

// ─── Panel ───────────────────────────────────────────────────────────

export function postPanel(channel) {
  return channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🃏 Blackjack')
      .setDescription('Beat the dealer without going over 21. Natural 21 pays 3:2.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bj:start').setLabel('🃏 New Hand').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('bj:rules').setLabel('📋 Rules').setStyle(ButtonStyle.Secondary),
    )],
  });
}

export async function handleInteraction(i) {
  if (i.isButton()) {
    const [, action] = i.customId.split(':');
    if (action === 'start')  return openModal(i);
    if (action === 'rules')  return showRules(i);
    if (action === 'hit')    return hit(i);
    if (action === 'stand')  return stand(i);
    if (action === 'double') return double(i);
  }
  if (i.isModalSubmit()) return startHand(i);
}

function showRules(i) {
  return i.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🃏 Blackjack — How to Play')
      .addFields(
        { name: 'Objective', value: 'Get closer to **21** than the dealer without going over (busting).' },
        { name: 'Card Values', value: '• **2–10** = face value\n• **J, Q, K** = 10\n• **Ace** = 11 (counts as 1 if you\'d bust)' },
        { name: 'Your Actions', value: '**Hit** — take another card\n**Stand** — keep your hand\n**Double Down** — double your bet, take exactly one more card' },
        { name: 'Dealer Rules', value: 'Dealer must hit on 16 or less, stands on 17+. Dealer\'s first card is hidden.' },
        { name: 'Payouts', value: '• Win → **2×** your stake\n• Natural Blackjack (21 in 2 cards) → **2.5×** your stake\n• Push (tie) → stake returned\n• Bust or dealer wins → lose stake' },
        { name: 'Bet Limits', value: `Min ₹${process.env.MIN_BET || 10} — Max ₹${process.env.MAX_BET || 10000}` },
      )],
  });
}

function openModal(i) {
  const m = new ModalBuilder().setCustomId('bj:bet').setTitle('Blackjack');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('amount').setLabel('Stake ₹')
      .setStyle(TextInputStyle.Short).setRequired(true)
      .setPlaceholder(`min ₹${process.env.MIN_BET || 1} – max ₹${process.env.MAX_BET || 10000}`)
  ));
  return i.showModal(m);
}

async function startHand(i) {
  const amount = Number(i.fields.getTextInputValue('amount'));
  const min = Number(process.env.MIN_BET || 10), max = Number(process.env.MAX_BET || 10000);
  if (!Number.isFinite(amount) || amount < min || amount > max)
    return i.reply({ ephemeral: true, content: `Stake ₹${min}–₹${max}.` });

  let u;
  try { u = await requireActive(i.user.id, i.user.username); }
  catch { return i.reply({ ephemeral: true, content: '🚫 Your account is suspended.' }); }

  // Abandon any existing session (refund orphaned stake)
  const existing = await getSession(i.user.id);
  if (existing) {
    await applyTx({ userId: existing.userId, type: 'bet', amount: 0n, lockDelta: -existing.stake,
      ref: null, meta: { game: 'blackjack', result: 'abandoned' } });
    await q(`UPDATE bets SET result='loss', settled_at=now() WHERE id=$1`, [existing.betId]);
    await clearSession(existing.userId);
  }

  const stake = toPaise(amount);
  try {
    await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
      ref: null, meta: { game: 'blackjack' } });
  } catch { return i.reply({ ephemeral: true, content: '💸 Insufficient.' }); }

  const seed = newServerSeed();
  const preset = (await resolveAmountPreset(stake)) ?? await getPreset('blackjack');
  const deck = newDeck(seed);

  if (preset === 'low') {
    const idx = deck.findIndex(c => /^(10|A|K|Q|J)/.test(c));
    if (idx > -1) { const card = deck.splice(idx, 1)[0]; deck.unshift(card); }
  } else if (preset === 'high' || preset === 'extreme') {
    // Give dealer two high cards (near-certain 20/21), player two low cards (stiff hand)
    // Deal order from end: player[0], player[1], dealer[0], dealer[1]
    // So push order onto end: dealer[1], dealer[0], player[1], player[0]
    const hi = [], lo = [];
    for (let i = 0; i < deck.length && (hi.length < 2 || lo.length < 2); i++) {
      if (hi.length < 2 && /^(A|10|K|Q|J)/.test(deck[i])) hi.push(deck.splice(i--, 1)[0]);
      else if (lo.length < 2 && /^[5-8]/.test(deck[i]))   lo.push(deck.splice(i--, 1)[0]);
    }
    if (hi.length === 2 && lo.length === 2) deck.push(hi[0], hi[1], lo[0], lo[1]);
  }

  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];

  const { rows } = await q(
    `INSERT INTO bets(user_id,game,stake,selection,result)
     VALUES($1,'blackjack',$2,$3,'pending') RETURNING id`,
    [u.id, stake.toString(), { initial: { player, dealer: [dealer[0], '??'] } }]
  );
  const s = { userId: u.id, stake, deck, player, dealer, betId: rows[0].id, doubled: false };
  await putSession(u.id, i.user.id, s);
  // result logged after settlement in finish() / natural BJ below

  // Natural blackjack: settle immediately at 3:2
  if (isNatural(player) && !isNatural(dealer)) {
    const payout = s.stake + BigInt(Math.floor(Number(s.stake) * 1.5));
    await applyTx({ userId: s.userId, type: 'win', amount: payout, lockDelta: -s.stake,
      ref: null, meta: { game: 'blackjack', result: 'natural' } });
    await q(`UPDATE bets SET payout=$1, result='win', settled_at=now() WHERE id=$2`,
      [payout.toString(), s.betId]);
    await clearSession(s.userId);
    logBetResult(i.client, { user: i.user.username, discordId: i.user.id, game: 'blackjack', stake: s.stake.toString(), payout: payout.toString(), result: 'win' });
    if (payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000))
      broadcastBigWin(i.client, i.user.username, 'Blackjack', payout).catch(() => {});
    return i.reply({ ephemeral: true,
      content: `🎉 Blackjack! ${fmt(payout)} (3:2)`,
      ...render(s, true),
    });
  }

  await i.reply({ ephemeral: true, ...render(s, false) });
}

function render(s, reveal) {
  const dealerView = reveal ? s.dealer.join(' ') : `${s.dealer[0]} 🂠`;
  const dealerVal  = reveal ? handValue(s.dealer) : '?';
  const e = new EmbedBuilder().setColor(Colors.Gold).setTitle('🃏 Blackjack')
    .addFields(
      { name: 'Dealer', value: `${dealerView} (${dealerVal})` },
      { name: 'You',    value: `${s.player.join(' ')} (${handValue(s.player)})` },
    );
  return {
    embeds: [e],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bj:hit').setLabel('Hit').setStyle(ButtonStyle.Primary).setDisabled(reveal),
      new ButtonBuilder().setCustomId('bj:stand').setLabel('Stand').setStyle(ButtonStyle.Secondary).setDisabled(reveal),
      new ButtonBuilder().setCustomId('bj:double').setLabel('Double').setStyle(ButtonStyle.Success)
        .setDisabled(reveal || s.player.length !== 2 || s.doubled),
    )],
  };
}

async function hit(i) {
  const s = await getSession(i.user.id);
  if (!s) return i.reply({ ephemeral: true, content: 'No hand.' });
  s.player.push(s.deck.pop());
  if (handValue(s.player) > 21) return finish(i, s);
  await putSession(s.userId, i.user.id, s);
  await i.update(render(s, false));
}

async function stand(i) {
  const s = await getSession(i.user.id);
  if (!s) return i.reply({ ephemeral: true, content: 'No hand.' });
  return finish(i, s);
}

async function double(i) {
  const s = await getSession(i.user.id);
  if (!s) return i.reply({ ephemeral: true, content: 'No hand.' });
  if (s.doubled || s.player.length !== 2) return i.reply({ ephemeral: true, content: 'Cannot double.' });
  try {
    await applyTx({ userId: s.userId, type: 'bet', amount: -s.stake, lockDelta: s.stake,
      ref: null, meta: { game: 'blackjack', double: true } });
  } catch { return i.reply({ ephemeral: true, content: '💸 Insufficient for double.' }); }
  s.stake *= 2n; s.doubled = true;
  s.player.push(s.deck.pop());
  return finish(i, s);
}

async function finish(i, s) {
  while (handValue(s.dealer) < 17) s.dealer.push(s.deck.pop());
  const pv = handValue(s.player), dv = handValue(s.dealer);
  let result, payout = 0n;
  if (pv > 21)        { result = 'loss'; }
  else if (dv > 21)   { result = 'win';  payout = s.stake * 2n; }
  else if (pv > dv)   { result = 'win';  payout = s.stake * 2n; }
  else if (pv === dv) { result = 'push'; payout = s.stake; }
  else                { result = 'loss'; }

  await applyTx({ userId: s.userId, type: result === 'loss' ? 'bet' : 'win',
    amount: payout, lockDelta: -s.stake, ref: null,
    meta: { game: 'blackjack', pv, dv, result } });
  await q(`UPDATE bets SET payout=$1, result=$2, settled_at=now() WHERE id=$3`,
    [payout.toString(), result, s.betId]);
  await clearSession(s.userId);
  logBetResult(i.client, { user: i.user.username, discordId: i.user.id, game: 'blackjack', stake: s.stake.toString(), payout: payout.toString(), result });

  if (result === 'win' && payout >= toPaise(process.env.BIG_WIN_BROADCAST || 5000))
    broadcastBigWin(i.client, i.user.username, 'Blackjack', payout).catch(() => {});

  await i.update({
    ...render(s, true),
    content: result === 'win' ? `💰 Win ${fmt(payout)}` : result === 'push' ? '↔️ Push' : '💀 Loss',
  });
}
