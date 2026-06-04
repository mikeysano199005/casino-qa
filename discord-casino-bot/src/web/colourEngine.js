// Server-authoritative Colour Prediction engine for the web (red/green/violet).
// Continuous rounds (betting -> result), SSE-streamed, reusing fairness/presets/
// money exactly like the Discord colour game. Its own subscriber set + clock.
import { q } from '../db/index.js';
import { applyTx, requireActive, getPreset, getWallet } from '../repo.js';
import { newServerSeed, hash, rngFloat } from '../util/fairness.js';
import { toPaise } from '../util/money.js';
import { cfg } from '../config.js';
import { logBetResult, logRound, broadcastBigWin } from '../admin/logs.js';
import { pickOutcome } from '../games/outcome.js';

const OPTIONS = [
  { key: 'green',  payoutMultiplier: 2, naturalProbability: 0.45 },
  { key: 'red',    payoutMultiplier: 2, naturalProbability: 0.45 },
  { key: 'violet', payoutMultiplier: 8, naturalProbability: 0.10 },
];
const BETTING_MS = 15_000;
const RESULT_MS  = 4_500;
const TICK_MS    = 500;

let client = null;
let state = null;
const subs = new Set();        // { res, userId }
const history = [];            // recent winners (newest first)

function sse(res, event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
function broadcast(event, data) { for (const s of subs) sse(s.res, event, data); }
function toUser(userId, event, data) { for (const s of subs) if (s.userId === userId) sse(s.res, event, data); }
export function colourSubscriberCount() { return subs.size; }

export function addColourSubscriber(res, userId) {
  const sub = { res, userId };
  subs.add(sub);
  sse(res, 'state', publicState());
  sse(res, 'bets', publicBets());
  const mine = state?.bets.get(userId);
  sse(res, 'you', { bet: mine ? { key: mine.key, stake: mine.stake.toString() } : null });
  return () => subs.delete(sub);
}

const maskName = (n) => { const s = String(n || 'p'); return s.length <= 2 ? s[0] + '***' : s[0] + '***' + s[s.length - 1]; };

function publicState() {
  if (!state) return { phase: 'waiting', serverTime: Date.now(), history: history.slice(0, 20) };
  return {
    phase: state.phase, roundId: state.round.id, serverTime: Date.now(),
    bettingEndsAt: state.bettingEndsAt || null,
    winner: state.phase === 'result' ? state.winner : null,
    pools: { green: state.pool.green.toString(), red: state.pool.red.toString(), violet: state.pool.violet.toString() },
    players: state.bets.size,
    history: history.slice(0, 20),
    viewers: subs.size,
  };
}
function publicBets() {
  if (!state) return [];
  return [...state.bets.values()].map(b => ({ name: maskName(b.username), key: b.key, stake: b.stake.toString() }));
}

async function openRound() {
  const serverSeed = newServerSeed();
  const clientSeed = Date.now().toString(36);
  let preset = 'house';
  try { preset = await getPreset('colour'); } catch {}
  let round;
  try {
    const { rows } = await q(
      `INSERT INTO game_rounds(game,server_seed_hash,client_seed,nonce,preset_mode) VALUES('colour',$1,$2,0,$3) RETURNING *`,
      [hash(serverSeed), clientSeed, preset]);
    round = rows[0];
  } catch (e) { console.warn('[web colour] openRound DB:', e.message); round = { id: null }; }

  state = {
    round, serverSeed, clientSeed, preset, phase: 'betting',
    bettingEndsAt: Date.now() + BETTING_MS, winner: null,
    pool: { green: 0n, red: 0n, violet: 0n }, bets: new Map(),
  };
  broadcast('state', publicState());
  broadcast('bets', publicBets());
}

async function settle() {
  const rng = rngFloat(state.serverSeed, state.clientSeed, 0);
  const winner = pickOutcome(OPTIONS, state.pool, state.preset, rng);
  const winOpt = OPTIONS.find(o => o.key === winner);
  state.winner = winner;

  let pool = 0n, paid = 0n;
  for (const b of state.bets.values()) {
    pool += b.stake;
    const win = b.key === winner;
    const payout = win ? b.stake * BigInt(winOpt.payoutMultiplier) : 0n;
    paid += payout;
    try {
      await applyTx({ userId: b.userId, type: win ? 'win' : 'bet', amount: win ? payout : 0n, lockDelta: -b.stake, ref: state.round.id, meta: { game: 'colour', selection: b.key, result: winner } });
      if (b.betId) await q(`UPDATE bets SET payout=$1, result=$2, settled_at=now() WHERE id=$3`, [payout.toString(), win ? 'win' : 'loss', b.betId]);
      logBetResult(client, { user: b.username, discordId: b.discordId, game: 'colour', stake: b.stake.toString(), payout: payout.toString(), result: win ? 'win' : 'loss' });
      if (win && payout >= toPaise(Number(cfg('BIG_WIN_BROADCAST') || 5000))) broadcastBigWin(client, b.username, 'Colour', payout).catch(() => {});
      const w = await getWallet(b.userId);
      toUser(b.userId, 'wallet', { balance: w.available.toString() });
    } catch (e) { console.warn('[web colour] settle:', e.message); }
  }
  if (state.round.id) {
    await q(`UPDATE game_rounds SET server_seed=$1, outcome=$2, total_pool=$3, house_pnl=$4, ended_at=now() WHERE id=$5`,
      [state.serverSeed, JSON.stringify({ winner }), pool.toString(), (pool - paid).toString(), state.round.id]).catch(() => {});
    logRound(client, 'colour', state.round.id, { winner, web: true, pool: pool.toString(), pnl: (pool - paid).toString() });
  }
  history.unshift(winner);
  if (history.length > 30) history.pop();
}

async function tick() {
  if (!state) return;
  if (state.phase === 'betting' && Date.now() >= state.bettingEndsAt) {
    state.phase = 'result';
    await settle();
    broadcast('state', publicState());
    broadcast('bets', publicBets());
    setTimeout(() => openRound().catch(e => console.error('[web colour] openRound', e.message)), RESULT_MS);
  } else if (state.phase === 'betting') {
    broadcast('sync', { serverTime: Date.now() });
  }
}

export function startColourEngine(discordClient) {
  if (state) return;
  client = discordClient;
  openRound().catch(e => console.error('[web colour] initial', e.message));
  setInterval(() => tick().catch(e => console.error('[web colour] tick', e.message)), TICK_MS);
  console.log('▶ web colour engine started');
}

export async function colourBet(discordId, username, amountRupees, key) {
  if (cfg('MAINTENANCE_MODE') === 'true') return { ok: false, error: 'maintenance' };
  if (!state || state.phase !== 'betting') return { ok: false, error: 'betting_closed' };
  if (!OPTIONS.find(o => o.key === key)) return { ok: false, error: 'bad_selection' };
  const min = Number(cfg('MIN_BET') || 1), max = Number(cfg('MAX_BET') || 10000);
  const amount = Number(amountRupees);
  if (!Number.isFinite(amount) || amount < min || amount > max) return { ok: false, error: `bet_range_${min}_${max}` };

  let u; try { u = await requireActive(discordId, username); } catch { return { ok: false, error: 'suspended' }; }
  if (state.bets.has(u.id)) return { ok: false, error: 'already_bet' };

  const stake = toPaise(amount);
  try { await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake, ref: state.round.id, meta: { game: 'colour', selection: key } }); }
  catch { return { ok: false, error: 'insufficient' }; }

  let betId = null;
  if (state.round.id) {
    const { rows } = await q(`INSERT INTO bets(user_id,round_id,game,stake,selection,result) VALUES($1,$2,'colour',$3,$4,'pending') RETURNING id`,
      [u.id, state.round.id, stake.toString(), { key }]).catch(() => ({ rows: [{}] }));
    betId = rows[0]?.id || null;
  }
  state.bets.set(u.id, { userId: u.id, discordId, username, key, stake, betId });
  state.pool[key] += stake;
  broadcast('bets', publicBets());
  broadcast('state', publicState());
  const w = await getWallet(u.id);
  toUser(u.id, 'you', { bet: { key, stake: stake.toString() } });
  return { ok: true, balance: w.available.toString() };
}
