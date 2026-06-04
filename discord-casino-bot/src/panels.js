// Re-posts the static channel panels (launcher, wallet, games, admin) using the
// live Discord client. Shared by boot (index.js) and the web admin "Re-post
// panels" action so a changed channel ID can take effect without a full restart.
// Game *loops* (colour/crash/matka) are NOT here — they capture their channel at
// boot and need an "Apply & Restart" instead.
//
// Returns a per-panel result list so the web UI can show exactly what happened
// (posted to which channel, or why it failed).
import * as wallet  from './channels/wallet.js';
import * as account from './channels/account.js';
import * as support from './channels/support.js';
import * as play    from './channels/play.js';
import * as mines   from './games/mines.js';
import * as dice    from './games/dice.js';
import * as bj      from './games/blackjack.js';
import * as slots   from './games/slots.js';
import { postAdminPanel } from './admin/adminPanel.js';
import { postSlotsAdminPanel } from './admin/slotsAdmin.js';
import { cfg } from './config.js';

// Deletes this bot's previous messages in the channel, then posts the panel.
async function safePanel(client, label, id, fn) {
  if (!id) return { label, ok: false, skipped: true, reason: 'no channel set' };
  try {
    const ch = await client.channels.fetch(id);
    const msgs = await ch.messages.fetch({ limit: 50 });
    const botMsgs = msgs.filter(m => m.author.id === client.user.id);
    for (const msg of botMsgs.values()) await msg.delete().catch(() => {});
    await fn(ch);
    return { label, ok: true, channel: ch.name, guild: ch.guild?.name, channelId: id };
  } catch (e) {
    console.warn('[panel]', label, id, e.message);
    return { label, ok: false, error: e.message, channelId: id };
  }
}

// Each game falls back to CH_PLAY if its own channel isn't set.
const gameCh = (key) => cfg(key) || cfg('CH_PLAY');

export async function postStaticPanels(client) {
  const tasks = [
    ['Play / launcher', cfg('CH_PLAY'),     play.postPanel],
    ['Wallet',          cfg('CH_WALLET'),   wallet.postPanel],
    ['Account',         cfg('CH_ACCOUNT'),  account.postPanel],
    ['Support',         cfg('CH_SUPPORT'),  support.postPanel],
    ['Mines',           gameCh('CH_MINES'), mines.postPanel],
    ['Dice',            gameCh('CH_DICE'),  dice.postPanel],
    ['Blackjack',       gameCh('CH_BLACKJACK'), bj.postPanel],
    ['Slots',           gameCh('CH_SLOTS'), slots.postPanel],
    ['Admin panel',     cfg('CH_ADMIN_PANEL'), postAdminPanel],
    ['Slots admin',     cfg('CH_SLOTS_ADMIN'), postSlotsAdminPanel],
  ];
  const results = [];
  for (const [label, id, fn] of tasks) results.push(await safePanel(client, label, id, fn));
  return results;
}
