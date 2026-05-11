import { rngFloat, rngInt } from '../util/fairness.js';

/*
 * Preset-aware outcome chooser.
 *
 * Inputs:
 *   options:  array of { key, payoutMultiplier, naturalProbability }
 *   pool:     map { key -> total stake on that outcome }  (in paise BigInt)
 *   preset:   'house' | 'low' | 'medium' | 'high'
 *   rng:      a [0,1) random float
 *
 * 'house' is provably-fair RNG via natural probabilities.
 * 'low'   tends to pick the option with highest stake (users mostly win).
 * 'medium' ~50/50 between best-for-house and best-for-users.
 * 'high'  tends to pick the option with the lowest total payout liability
 *         (lowest stake * payoutMultiplier on that side wins us most).
 */
export function pickOutcome(options, pool, preset, rng) {
  const stakes = Object.fromEntries(
    options.map(o => [o.key, BigInt(pool[o.key] || 0n)])
  );

  if (preset === 'house') {
    let r = rng;
    for (const o of options) {
      r -= o.naturalProbability;
      if (r <= 0) return o.key;
    }
    return options[options.length - 1].key;
  }

  // House liability if outcome k wins = stakes[k] * payout
  const liability = options.map(o => ({
    key: o.key,
    score: Number(stakes[o.key]) * o.payoutMultiplier,
  }));
  const maxStake  = options.reduce((a, b) =>
    stakes[a.key] > stakes[b.key] ? a : b
  );
  const minLiab   = liability.reduce((a, b) => (a.score <= b.score ? a : b));
  const maxLiab   = liability.reduce((a, b) => (a.score >= b.score ? a : b));

  if (preset === 'low') {
    // 90% pick the side with most user money (users win)
    if (rng < 0.9) return maxStake.key;
    return options[Math.floor(rng * options.length)].key;
  }
  if (preset === 'high') {
    if (rng < 0.99) return minLiab.key;
    return maxLiab.key;
  }
  // medium: 50/50 between users-favouring and house-favouring
  if (rng < 0.5) return maxStake.key;
  return minLiab.key;
}

export { rngFloat, rngInt };
