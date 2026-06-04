// DB-backed runtime settings with env-var fallback.
//
//   cfg('CH_BET_LOGS')  →  DB override if present, else process.env.CH_BET_LOGS
//
// The web admin panel writes to the `settings` table via setSetting(); the
// in-memory cache is refreshed on every write and once at boot (loadSettings()).
// Channels read through cfg() at send-time (e.g. logs.js) therefore re-route
// immediately, with no restart.
import { q } from './db/index.js';
import { logAudit } from './repo.js';

const cache = new Map(); // key -> value (string)

export async function loadSettings() {
  try {
    const { rows } = await q(`SELECT key, value FROM settings`);
    cache.clear();
    for (const r of rows) cache.set(r.key, r.value);
    return cache.size;
  } catch (e) {
    console.warn('[config] loadSettings failed:', e.message);
    return 0;
  }
}

// DB override → env fallback. Empty-string DB values are treated as "unset".
export function cfg(key) {
  const v = cache.get(key);
  if (v !== undefined && v !== null && v !== '') return v;
  return process.env[key];
}

// Raw DB value only (no env fallback) — used by the settings editor so it can
// distinguish "overridden in DB" from "using env default".
export function dbValue(key) {
  const v = cache.get(key);
  return v === undefined ? null : v;
}

export async function setSetting(key, value, actor = 'web-admin') {
  const clean = value == null ? '' : String(value).trim();
  await q(
    `INSERT INTO settings(key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, clean, String(actor)]
  );
  await loadSettings();
  logAudit(String(actor), 'setting_change', key, null, { value: clean }).catch(() => {});
}

// ─── Key metadata for the UI (grouped, labelled) ─────────────────────────
// `apply` notes how a change takes effect:
//   live    → immediate (read per-send)
//   panel   → needs "Re-post panels"
//   restart → needs "Apply & Restart" (game loops captured at boot)

export const CHANNEL_KEYS = [
  { key: 'CH_PLAY',             label: 'Play / launcher',        group: 'Player',  apply: 'panel'   },
  { key: 'CH_WALLET',          label: 'Wallet',                 group: 'Player',  apply: 'panel'   },
  { key: 'CH_ACCOUNT',         label: 'Account',                group: 'Player',  apply: 'panel'   },
  { key: 'CH_SUPPORT',         label: 'Support',                group: 'Player',  apply: 'panel'   },
  { key: 'CH_CHAT',            label: 'Chat (big-win broadcast)', group: 'Player', apply: 'live'   },

  { key: 'CH_COLOUR',          label: 'Colour prediction',      group: 'Games',   apply: 'restart' },
  { key: 'CH_CRASH',           label: 'Crash',                  group: 'Games',   apply: 'restart' },
  { key: 'CH_MATKA',           label: 'Matka King',             group: 'Games',   apply: 'restart' },
  { key: 'CH_MINES',           label: 'Mines',                  group: 'Games',   apply: 'panel'   },
  { key: 'CH_DICE',            label: 'Dice',                   group: 'Games',   apply: 'panel'   },
  { key: 'CH_BLACKJACK',       label: 'Blackjack',              group: 'Games',   apply: 'panel'   },
  { key: 'CH_SLOTS',           label: 'Slots',                  group: 'Games',   apply: 'panel'   },
  { key: 'CH_MATKA_PREDICTION', label: 'Matka VIP predictions', group: 'Games',  apply: 'live'    },

  { key: 'CH_ADMIN_PANEL',      label: 'Admin panel',           group: 'Admin',   apply: 'panel'   },
  { key: 'CH_WITHDRAW_REQUESTS', label: 'Withdraw requests',    group: 'Admin',   apply: 'live'    },
  { key: 'CH_WITHDRAW_HISTORY', label: 'Withdraw history',      group: 'Admin',   apply: 'live'    },
  { key: 'CH_DEPOSIT_LOGS',     label: 'Deposit logs',          group: 'Admin',   apply: 'live'    },
  { key: 'CH_PAYMENT_ERRORS',   label: 'Payment errors',        group: 'Admin',   apply: 'live'    },
  { key: 'CH_BET_LOGS',         label: 'Bet logs',              group: 'Admin',   apply: 'live'    },
  { key: 'CH_ROUND_LOGS',       label: 'Round logs',            group: 'Admin',   apply: 'live'    },
  { key: 'CH_ALERTS',           label: 'Alerts',                group: 'Admin',   apply: 'live'    },
  { key: 'CH_SUSPICIOUS',       label: 'Suspicious activity',   group: 'Admin',   apply: 'live'    },
  { key: 'CH_AUDIT_LOG',        label: 'Audit log',             group: 'Admin',   apply: 'live'    },
  { key: 'CH_BOT_STATUS',       label: 'Bot status',            group: 'Admin',   apply: 'live'    },
  { key: 'CH_LIVE_DASHBOARD',   label: 'Live dashboard',        group: 'Admin',   apply: 'restart' },
];

// Economy config — stored/edited as ₹ rupees in the UI, but the env vars are
// already in rupees today (parsed by the consuming code), so we store as-is.
export const CONFIG_KEYS = [
  { key: 'MIN_BET',                 label: 'Min bet (₹)',                 group: 'Economy' },
  { key: 'MAX_BET',                 label: 'Max bet (₹)',                 group: 'Economy' },
  { key: 'MIN_DEPOSIT',             label: 'Min deposit (₹)',             group: 'Economy' },
  { key: 'MAX_DEPOSIT',             label: 'Max deposit (₹)',             group: 'Economy' },
  { key: 'MIN_WITHDRAW',            label: 'Min withdraw (₹)',            group: 'Economy' },
  { key: 'WITHDRAW_COOLDOWN_HOURS', label: 'Withdraw cooldown (hours)',   group: 'Economy' },
  { key: 'BIG_WIN_BROADCAST',       label: 'Big-win broadcast threshold', group: 'Economy' },
];
