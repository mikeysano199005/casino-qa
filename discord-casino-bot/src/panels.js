// Re-posts the static channel panels (launcher, wallet, games, admin) using the
// live Discord client. Shared by boot (index.js) and the web admin "Re-post
// panels" action so a changed channel ID can take effect without a full restart.
// Game *loops* (colour/crash/matka) are NOT here — they capture their channel at
// boot and need an "Apply & Restart" instead.
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

const SLOTS_ADMIN_CH = '1503762578357223629';

// Deletes this bot's previous messages in the channel, then posts the panel.
async function safePanel(client, id, fn) {
  if (!id) return;
  try {
    const ch = await client.channels.fetch(id);
    const msgs = await ch.messages.fetch({ limit: 50 });
    const botMsgs = msgs.filter(m => m.author.id === client.user.id);
    for (const msg of botMsgs.values()) await msg.delete().catch(() => {});
    await fn(ch);
  } catch (e) { console.warn('[panel]', id, e.message); }
}

// Each game falls back to CH_PLAY if its own channel isn't set.
const gameCh = (key) => cfg(key) || cfg('CH_PLAY');

export async function postStaticPanels(client) {
  await safePanel(client, cfg('CH_PLAY'),    play.postPanel);
  await safePanel(client, cfg('CH_WALLET'),  wallet.postPanel);
  await safePanel(client, cfg('CH_ACCOUNT'), account.postPanel);
  await safePanel(client, cfg('CH_SUPPORT'), support.postPanel);

  await safePanel(client, gameCh('CH_MINES'),     mines.postPanel);
  await safePanel(client, gameCh('CH_DICE'),      dice.postPanel);
  await safePanel(client, gameCh('CH_BLACKJACK'), bj.postPanel);
  await safePanel(client, gameCh('CH_SLOTS'),     slots.postPanel);

  await safePanel(client, cfg('CH_ADMIN_PANEL'), postAdminPanel);
  await safePanel(client, SLOTS_ADMIN_CH,        postSlotsAdminPanel);
}
