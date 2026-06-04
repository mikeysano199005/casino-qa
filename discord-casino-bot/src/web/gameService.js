// Pure game outcome helpers for the web games. Mirror the Discord games' math
// exactly (same fairness RNG + presets) so payouts/rigging are identical.
import { rngFloat } from '../util/fairness.js';
import { SYMBOLS, slotsForced } from '../games/slots.js';

const TOTAL_W = SYMBOLS.reduce((s, x) => s + x.w, 0);
export function pickSymbol(rng) {
  let r = rng * TOTAL_W;
  for (const s of SYMBOLS) { r -= s.w; if (r <= 0) return s; }
  return SYMBOLS[0];
}
const idxOf = (sym) => SYMBOLS.findIndex(s => s.s === sym.s);
const threeRandom = (seed) => [pickSymbol(rngFloat(seed, 'a', 0)), pickSymbol(rngFloat(seed, 'b', 1)), pickSymbol(rngFloat(seed, 'c', 2))];
function threeDistinct(seed) {
  const r = threeRandom(seed);
  if (r[0].s === r[1].s) r[1] = SYMBOLS[(idxOf(r[1]) + 1) % SYMBOLS.length];
  if (r[1].s === r[2].s || r[0].s === r[2].s) r[2] = SYMBOLS[(idxOf(r[2]) + 2) % SYMBOLS.length];
  return r;
}

// ── Dice ─────────────────────────────────────────────────────────────────
// side: 'UNDER' | 'OVER', target 2..98. Returns { roll, win, payout, multiplier }.
export function diceOutcome(stake, side, target, seed, preset) {
  const isUnder = side === 'UNDER';
  const winChance = isUnder ? (target - 1) / 100 : (99 - target) / 100;
  const payoutMult = 0.97 / winChance;
  let roll = Math.floor(rngFloat(seed, 'roll', 0) * 99) + 1;
  const bias = rngFloat(seed, 'bias', 0);
  const jitter = Math.floor(rngFloat(seed, 'jitter', 0) * 5);
  if (preset === 'low' && bias < 0.9)
    roll = isUnder ? Math.max(1, target - 1 - jitter) : target + 1 + jitter;
  if ((preset === 'high' || preset === 'extreme') && bias < 0.99)
    roll = isUnder ? target + 1 + jitter : Math.max(1, target - 1 - jitter);
  roll = Math.min(99, Math.max(1, roll));
  const win = isUnder ? roll < target : roll > target;
  const payout = win ? BigInt(Math.floor(Number(stake) * payoutMult)) : 0n;
  return { roll, win, payout, multiplier: +payoutMult.toFixed(4) };
}

// ── Slots ────────────────────────────────────────────────────────────────
// Returns { reels: [sym,sym,sym], win, mult }. Honors slotsForced + presets.
export function slotsSpin(seed, discordId, preset) {
  let reels;
  const forced = slotsForced.get(discordId);
  if (forced) {
    if (forced.type === 'symbol') { reels = [forced.symbol, forced.symbol, forced.symbol]; slotsForced.delete(discordId); }
    else if (forced.type === 'win') { const s = pickSymbol(rngFloat(seed, 'f', 0)); reels = [s, s, s]; if (--forced.remaining <= 0) slotsForced.delete(discordId); }
    else { reels = threeDistinct(seed); if (--forced.remaining <= 0) slotsForced.delete(discordId); }
  } else if (preset === 'low' && Math.random() < 0.4) {
    const s = pickSymbol(rngFloat(seed, 'a', 0)); reels = [s, s, s];
  } else if (preset === 'extreme') {
    reels = threeDistinct(seed);
  } else if (preset === 'high' && Math.random() < 0.99) {
    reels = threeRandom(seed);
    if (reels[0].s === reels[1].s && reels[1].s === reels[2].s) reels[2] = SYMBOLS[(idxOf(reels[2]) + 1) % SYMBOLS.length];
  } else if (preset === 'medium') {
    if (rngFloat(seed, 'med', 0) < 0.5) { const s = pickSymbol(rngFloat(seed, 'a', 0)); reels = [s, s, s]; }
    else reels = threeRandom(seed);
  } else {
    reels = threeRandom(seed);
  }
  const win = reels[0].s === reels[1].s && reels[1].s === reels[2].s;
  return { reels, win, mult: win ? reels[0].pay : 0 };
}

// ── Mines ──────────────────────────────────────────────────────────────────
// 20-tile grid (indices 0..19), same as the Discord game so payouts match.
export const MINES_TILES = 20;
export function minesBombs(seed, mines) {
  const bombs = new Set();
  let n = 0;
  while (bombs.size < mines) bombs.add(Math.floor(rngFloat(seed, 'b', n++) * MINES_TILES));
  return [...bombs];
}
export function minesMultiplier(safeRevealed, mines) {
  return +(Math.pow(MINES_TILES / (MINES_TILES - mines), safeRevealed) * 0.97).toFixed(4);
}
