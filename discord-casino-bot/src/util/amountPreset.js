import { q } from '../db/index.js';

let _cfg = null;
let _ts  = 0;

async function load() {
  if (_cfg && Date.now() - _ts < 5000) return _cfg;
  const { rows } = await q(`SELECT * FROM amount_preset_config WHERE id=1`);
  _cfg = rows[0] ?? { enabled: false, easy_max: 10000, hard_min: 20000 };
  _ts  = Date.now();
  return _cfg;
}

export function invalidateAmountPreset() { _cfg = null; }

// Returns 'low', 'medium', or 'high' when enabled, else null (caller uses game preset)
export async function resolveAmountPreset(stakeInPaise) {
  const cfg = await load();
  if (!cfg.enabled) return null;
  const s = typeof stakeInPaise === 'bigint' ? stakeInPaise : BigInt(stakeInPaise);
  if (s < BigInt(cfg.easy_max)) return 'low';
  if (s > BigInt(cfg.hard_min)) return 'high';
  return 'medium';
}
