import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { q } from './db/index.js';
import { startColourLoop } from './games/colour.js';
import { startCrashLoop }  from './games/crash.js';
import * as wallet  from './channels/wallet.js';
import * as account from './channels/account.js';
import * as support from './channels/support.js';
import * as play    from './channels/play.js';
import * as mines   from './games/mines.js';
import * as dice    from './games/dice.js';
import * as bj      from './games/blackjack.js';
import * as slots   from './games/slots.js';
import * as colour  from './games/colour.js';
import * as crash   from './games/crash.js';
import { handleAdminInteraction, postAdminPanel } from './admin/adminPanel.js';
import { botHeartbeat } from './admin/logs.js';
import { startLiveDashboard } from './admin/liveDashboard.js';
import { startWebhookServer } from './cashfree.js';
import { checkAndSendWelcome } from './util/welcome.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

// ─── Routing table for the customId namespaces ──────────────────────────
const HANDLERS = {
  colour:     colour.handleInteraction,
  crash:      crash.handleInteraction,
  mines:      mines.handleInteraction,
  dice:       dice.handleInteraction,
  bj:         bj.handleInteraction,
  slots:      slots.handleInteraction,
  wallet:     wallet.handleInteraction,
  account:    account.handleInteraction,
  launch:     play.handleInteraction,
  support:    support.handleInteraction,
  wd:         handleAdminInteraction,
  admin:      handleAdminInteraction,
  userpanel:  handleAdminInteraction, // delegated inside handleAdminInteraction
};

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!(i.isButton() || i.isModalSubmit())) return;
    const ns = i.customId.split(':')[0];
    const fn = HANDLERS[ns];
    if (!fn) return;
    await fn(i);
    // Fire-and-forget: send welcome DM on first-ever interaction
    checkAndSendWelcome(i.client, i.user).catch(() => {});
  } catch (e) {
    console.error('[interaction error]', i.customId, e.message, e.stack);
    try {
      if (i.isRepliable()) {
        const msg = `⚠️ Something went wrong. (${e.message?.slice(0, 100) ?? 'unknown'})`;
        if (!i.replied && !i.deferred) await i.reply({ ephemeral: true, content: msg });
        else if (i.deferred && !i.replied) await i.editReply({ content: msg });
      }
    } catch {}
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Refund stale game sessions older than 24 h (orphaned by a previous crash/restart)
  try {
    const { rows: stale } = await q(
      `DELETE FROM game_sessions WHERE created_at < now() - interval '24 hours' RETURNING user_id, bet_id`
    );
    for (const row of stale) {
      const { rows: bet } = await q(`SELECT stake FROM bets WHERE id=$1 AND result='pending'`, [row.bet_id]);
      if (!bet[0]) continue;
      await q(
        `SELECT apply_transaction($1,'refund',0,$2,NULL,'{"kind":"stale_session"}')`,
        [row.user_id, (-BigInt(bet[0].stake)).toString()]
      );
      await q(`UPDATE bets SET result='loss', settled_at=now() WHERE id=$1`, [row.bet_id]);
      console.log(`[startup] refunded stale session bet ${row.bet_id}`);
    }
  } catch (e) { console.warn('[startup] stale session cleanup:', e.message); }

  // post panels in main channels (idempotent: posts once on each boot)
  const safePanel = async (id, fn) => {
    if (!id) return;
    try {
      const ch = await client.channels.fetch(id);
      // Delete previous bot messages in this channel before reposting panel
      const msgs = await ch.messages.fetch({ limit: 50 });
      const botMsgs = msgs.filter(m => m.author.id === client.user.id);
      for (const msg of botMsgs.values()) await msg.delete().catch(() => {});
      await fn(ch);
    } catch (e) { console.warn('panel', id, e.message); }
  };
  await safePanel(process.env.CH_PLAY,    play.postPanel);
  await safePanel(process.env.CH_WALLET,  wallet.postPanel);
  await safePanel(process.env.CH_ACCOUNT, account.postPanel);
  await safePanel(process.env.CH_SUPPORT, support.postPanel);

  // Each game gets its own channel; falls back to CH_PLAY if not set
  const ch = (key) => process.env[key] || process.env.CH_PLAY;
  await safePanel(ch('CH_MINES'),     mines.postPanel);
  await safePanel(ch('CH_DICE'),      dice.postPanel);
  await safePanel(ch('CH_BLACKJACK'), bj.postPanel);
  await safePanel(ch('CH_SLOTS'),     slots.postPanel);

  if (ch('CH_COLOUR')) startColourLoop(client, ch('CH_COLOUR')).catch(console.error);
  if (ch('CH_CRASH'))  startCrashLoop(client,  ch('CH_CRASH')).catch(console.error);

  await safePanel(process.env.CH_ADMIN_PANEL, postAdminPanel);

  if (process.env.CH_LIVE_DASHBOARD)
    startLiveDashboard(client, process.env.CH_LIVE_DASHBOARD).catch(console.error);

  // heartbeat
  setInterval(() => {
    q(`UPDATE bot_status SET last_seen=now(), version='1.0.0' WHERE id=1`).catch(()=>{});
  }, 30_000);
  botHeartbeat(client).catch(()=>{});
});

startWebhookServer(client);

client.login(process.env.DISCORD_TOKEN);
