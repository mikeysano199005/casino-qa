// Server-authoritative Aviator/crash engine for the web game.
// Runs continuous rounds (betting → flying → crashed) independent of Discord.
// The crash point and timing are decided here so real-money play can't be cheated.
// Reuses the same money/fairness/preset logic as the Discord crash game.
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset, getWallet } from '../repo.js';
import { newServerSeed, hash, rngFloat } from '../util/fairness.js';
import { toPaise } from '../util/money.js';
import { cfg } from '../config.js';
import { logBetResult, logRound, broadcastBigWin } from '../admin/logs.js';

const BETTING_MS = 7_000;   // betting window
const CRASHED_MS = 3_500;   // pause after crash before next round
const TICK_MS    = 250;     // engine tick / sync cadence

// multiplier as a function of elapsed ms since flight start (same as Discord crash)
const multiplierAt = (ms) => Math.pow(1.07, ms / 1000);

// Same crash-point curve as src/games/crash.js (honors the admin "crash" preset).
function computeCrashAt(preset, r) {
  let m;
  if (preset === 'house')        m = Math.max(1.00, 0.99 / Math.max(0.0001, 1 - r));
  else if (preset === 'low')     m = 1 + r * 9;
  else if (preset === 'medium')  m = Math.max(1.00, 0.5 + r * 5);
  else if (preset === 'extreme') m = r < 0.5 ? 1.00 : 1.02;
  else if (preset === 'high')    m = 1.00 + r * 0.10;
  else                           m = Math.max(1.00, 0.99 / Math.max(0.0001, 1 - r));
  return Math.min(50, Math.round(m * 100) / 100);
}

let client = null;
let state = null;            // current round state
const subscribers = new Set(); // { res, userId }
const history = [];          // recent crash multipliers (newest first)

// ── SSE plumbing ───────────────────────────────────────────────────────────
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}
function broadcast(event, data) { for (const s of subscribers) sse(s.res, event, data); }
function toUser(userId, event, data) { for (const s of subscribers) if (s.userId === userId) sse(s.res, event, data); }

export function addSubscriber(res, userId) {
  const sub = { res, userId };
  subscribers.add(sub);
  // immediate snapshot
  sse(res, 'state', publicState());
  sse(res, 'bets', publicBets());
  const mine = state?.bets.get(userId);
  sse(res, 'you', { bet: mine ? betView(mine) : null });
  return () => subscribers.delete(sub);
}
export function subscriberCount() { return subscribers.size; }

// ── views ──────────────────────────────────────────────────────────────────
const maskName = (n) => {
  const s = String(n || 'player');
  return s.length <= 2 ? s[0] + '***' : s[0] + '***' + s[s.length - 1];
};
const betView = (b) => ({ stake: b.stake.toString(), cashedOut: !!b.cashedOut, cashOutAt: b.cashOutAt || null,
  payout: b.cashedOut ? Math.floor(Number(b.stake) * b.cashOutAt).toString() : null });

function publicState() {
  if (!state) return { phase: 'waiting', serverTime: Date.now(), history: history.slice(0, 30) };
  return {
    phase: state.phase,
    roundId: state.round.id,
    serverTime: Date.now(),
    bettingEndsAt: state.bettingEndsAt || null,
    startTime: state.startedAt || null,
    crashAt: state.phase === 'crashed' ? state.crashAt : null,
    history: history.slice(0, 30),
    players: state.bets.size + (state.fakePlayers || 0),
    viewers: state.viewers || 0,
  };
}
function publicBets() {
  if (!state) return [];
  return [...state.bets.values()].map(b => ({
    name: maskName(b.username), stake: b.stake.toString(),
    cashedOut: !!b.cashedOut, cashOutAt: b.cashOutAt || null,
    payout: b.cashedOut ? Math.floor(Number(b.stake) * b.cashOutAt).toString() : null,
  }));
}

// ── round lifecycle ──────────────────────────────────────────────────────────
async function openRound() {
  const serverSeed = newServerSeed();
  const clientSeed = Date.now().toString(36);
  let preset = 'house';
  try { preset = await getPreset('crash'); } catch {}
  const crashAt = computeCrashAt(preset, rngFloat(serverSeed, clientSeed, 0));

  let round;
  try {
    const { rows } = await q(
      `INSERT INTO game_rounds(game,server_seed_hash,client_seed,nonce,preset_mode,outcome)
       VALUES('crash',$1,$2,0,$3,$4) RETURNING *`,
      [hash(serverSeed), clientSeed, preset, { crashAt, web: true }]
    );
    round = rows[0];
  } catch (e) {
    console.warn('[web crash] openRound DB error:', e.message);
    // fall back to an in-memory round id so the game keeps running
    round = { id: null };
  }

  state = {
    round, serverSeed, crashAt,
    phase: 'betting',
    bettingEndsAt: Date.now() + BETTING_MS,
    startedAt: null,
    bets: new Map(),                       // userId -> bet
    fakePlayers: Math.floor(Math.random() * 60) + 40,
    viewers: Math.floor(Math.random() * 120) + 200,
  };
  broadcast('state', publicState());
  broadcast('bets', publicBets());
}

async function settle() {
  let pool = 0n, paid = 0n;
  for (const b of state.bets.values()) {
    pool += b.stake;
    if (b.cashedOut) { paid += BigInt(Math.floor(Number(b.stake) * b.cashOutAt)); continue; } // already settled on cashout
    // loss: release the lock, keep the stake
    try {
      await applyTx({ userId: b.userId, type: 'bet', amount: 0n, lockDelta: -b.stake,
        ref: state.round.id, meta: { game: 'crash', web: true, crashed: true } });
      if (b.betId) await q(`UPDATE bets SET payout='0', result='loss', settled_at=now() WHERE id=$1`, [b.betId]);
      logBetResult(client, { user: b.username, discordId: b.discordId, game: 'crash',
        stake: b.stake.toString(), payout: '0', result: 'loss' });
    } catch (e) { console.warn('[web crash] settle loss error:', e.message); }
  }
  if (state.round.id) {
    await q(`UPDATE game_rounds SET server_seed=$1, total_pool=$2, house_pnl=$3, ended_at=now() WHERE id=$4`,
      [state.serverSeed, pool.toString(), (pool - paid).toString(), state.round.id]).catch(() => {});
    logRound(client, 'crash', state.round.id, { crashAt: state.crashAt, web: true, pool: pool.toString(), pnl: (pool - paid).toString() });
  }
  history.unshift(state.crashAt);
  if (history.length > 40) history.pop();
}

async function tick() {
  if (!state) return;
  const now = Date.now();

  if (state.phase === 'betting') {
    if (now >= state.bettingEndsAt) {
      state.phase = 'flying';
      state.startedAt = now;
      broadcast('state', publicState());
    } else {
      broadcast('sync', { serverTime: now });
    }
    return;
  }

  if (state.phase === 'flying') {
    const mult = multiplierAt(now - state.startedAt);
    if (mult >= state.crashAt) {
      state.phase = 'crashed';
      broadcast('state', publicState()); // includes crashAt now
      await settle();
      broadcast('bets', publicBets());
      setTimeout(() => { openRound().catch(e => console.error('[web crash] openRound', e.message)); }, CRASHED_MS);
      state.crashedAt = now;
    } else {
      broadcast('sync', { serverTime: now });
    }
    return;
  }
}

export function startEngine(discordClient) {
  if (state) return; // already running
  client = discordClient;
  openRound().catch(e => console.error('[web crash] initial openRound', e.message));
  setInterval(() => tick().catch(e => console.error('[web crash] tick', e.message)), TICK_MS);
  // refresh viewer count a touch for liveliness
  setInterval(() => { if (state) { state.viewers = Math.floor(Math.random() * 120) + 200; } }, 9000);
  console.log('▶ web aviator engine started');
}

// ── player actions ───────────────────────────────────────────────────────────
export async function placeBet(discordId, username, amountRupees) {
  if (cfg('MAINTENANCE_MODE') === 'true') return { ok: false, error: 'maintenance' };
  if (!state || state.phase !== 'betting') return { ok: false, error: 'betting_closed' };

  const min = Number(cfg('MIN_BET') || 1), max = Number(cfg('MAX_BET') || 10000);
  const amount = Number(amountRupees);
  if (!Number.isFinite(amount) || amount < min || amount > max) return { ok: false, error: `bet_range_${min}_${max}` };

  let u;
  try { u = await requireActive(discordId, username); }
  catch { return { ok: false, error: 'account_suspended' }; }

  if (state.bets.has(u.id)) return { ok: false, error: 'already_bet' };

  const stake = toPaise(amount);
  try {
    await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake,
      ref: state.round.id, meta: { game: 'crash', web: true } });
  } catch { return { ok: false, error: 'insufficient_balance' }; }

  let betId = null;
  if (state.round.id) {
    const { rows } = await q(
      `INSERT INTO bets(user_id,round_id,game,stake,selection,result) VALUES($1,$2,'crash',$3,$4,'pending') RETURNING id`,
      [u.id, state.round.id, stake.toString(), {}]).catch(() => ({ rows: [{}] }));
    betId = rows[0]?.id || null;
  }
  const bet = { userId: u.id, discordId, username, stake, betId, cashedOut: false, cashOutAt: null };
  state.bets.set(u.id, bet);

  broadcast('bets', publicBets());
  const w = await getWallet(u.id);
  toUser(u.id, 'you', { bet: betView(bet) });
  return { ok: true, balance: w.available.toString(), bet: betView(bet) };
}

export async function cashOut(discordId, username) {
  if (!state) return { ok: false, error: 'no_round' };
  let u;
  try { u = await requireActive(discordId, username); } catch { return { ok: false, error: 'account_suspended' }; }
  const bet = state.bets.get(u.id);
  if (!bet) return { ok: false, error: 'no_bet' };
  if (bet.cashedOut) return { ok: false, error: 'already_cashed' };
  if (state.phase !== 'flying') return { ok: false, error: 'not_flying' };

  // Authoritative multiplier = server clock at receipt, clamped below crashAt.
  const mult = multiplierAt(Date.now() - state.startedAt);
  if (mult >= state.crashAt) return { ok: false, error: 'crashed' };
  const cashOutAt = Math.max(1, Math.floor(mult * 100) / 100);
  bet.cashedOut = true;
  bet.cashOutAt = cashOutAt;

  const payout = BigInt(Math.floor(Number(bet.stake) * cashOutAt));
  try {
    await applyTx({ userId: u.id, type: 'win', amount: payout, lockDelta: -bet.stake,
      ref: state.round.id, meta: { game: 'crash', web: true, cashOutAt } });
    if (bet.betId) await q(`UPDATE bets SET payout=$1, result='win', settled_at=now() WHERE id=$2`, [payout.toString(), bet.betId]);
    logBetResult(client, { user: username, discordId, game: 'crash',
      stake: bet.stake.toString(), payout: payout.toString(), result: 'win' });
    if (payout >= toPaise(Number(cfg('BIG_WIN_BROADCAST') || 5000)))
      broadcastBigWin(client, username, 'Aviator', payout).catch(() => {});
  } catch (e) {
    console.warn('[web crash] cashout settle error:', e.message);
    return { ok: false, error: 'settle_failed' };
  }

  broadcast('bets', publicBets());
  const w = await getWallet(u.id);
  toUser(u.id, 'you', { bet: betView(bet) });
  return { ok: true, payout: payout.toString(), multiplier: cashOutAt, balance: w.available.toString() };
}
