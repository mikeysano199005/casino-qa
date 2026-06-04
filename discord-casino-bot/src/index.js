import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, REST, Routes } from 'discord.js';
import * as payCmd    from './commands/pay.js';
import * as addbalCmd from './commands/addbal.js';
import { q } from './db/index.js';
import { startColourLoop } from './games/colour.js';
import { startCrashLoop }  from './games/crash.js';
import { startMatkaLoop }  from './games/matka.js';
import { startIplLoop }    from './games/ipl.js';
import * as wallet  from './channels/wallet.js';
import * as account from './channels/account.js';
import * as support from './channels/support.js';
import * as play    from './channels/play.js';
import * as mines   from './games/mines.js';
import * as dice    from './games/dice.js';
import * as bj      from './games/blackjack.js';
import * as slots   from './games/slots.js';
import * as matka   from './games/matka.js';
import * as ipl     from './games/ipl.js';
import * as colour  from './games/colour.js';
import * as crash   from './games/crash.js';
import { handleAdminInteraction } from './admin/adminPanel.js';
import { handleSlotsAdminInteraction } from './admin/slotsAdmin.js';
import { handleIplAdmin } from './admin/iplAdmin.js';
import { botHeartbeat } from './admin/logs.js';
import { startLiveDashboard } from './admin/liveDashboard.js';
import { startWebhookServer } from './watchpay.js';
import { checkAndSendWelcome, checkAndSendWelcomeBack } from './util/welcome.js';
import { startSlotsPredictionPoller } from './util/predictionDelivery.js';
import { loadSettings, cfg } from './config.js';
import { postStaticPanels } from './panels.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

// ─── Routing table for the customId namespaces ──────────────────────────
const HANDLERS = {
  colour:     colour.handleInteraction,
  crash:      crash.handleInteraction,
  matka:      matka.handleInteraction,
  ipl:        ipl.handleInteraction,
  ipladmin:   handleIplAdmin,
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
  slotsadmin: handleSlotsAdminInteraction,
};

client.on(Events.InteractionCreate, async (i) => {
  try {
    // Slash commands
    if (i.isChatInputCommand()) {
      if (i.commandName === 'pay')    return payCmd.handleCommand(i);
      if (i.commandName === 'addbal') return addbalCmd.handleCommand(i);
      return;
    }
    // pay modal
    if (i.isModalSubmit() && i.customId === 'pay:create') return payCmd.handleModal(i);

    if (!(i.isButton() || i.isModalSubmit())) return;
    const ns = i.customId.split(':')[0];
    const fn = HANDLERS[ns];
    if (!fn) return;
    await fn(i);
    // Fire-and-forget: send welcome DM on first-ever interaction, or welcome-back after 7-day absence
    checkAndSendWelcome(i.client, i.user).catch(() => {});
    checkAndSendWelcomeBack(i.client, i.user).catch(() => {});
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

  // Load DB-backed settings (channel IDs + config) so cfg() overrides env.
  await loadSettings();

  // Register /pay slash command on the main guild (instant update, no 1-hour delay)
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.MAIN_GUILD_ID),
      { body: [payCmd.command.toJSON(), addbalCmd.command.toJSON()] },
    );
    console.log('✅ /pay command registered');
  } catch (e) { console.warn('[slash register]', e.message); }

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

  // post static panels in main channels (idempotent: posts once on each boot)
  await postStaticPanels(client);

  // Each game loop gets its own channel; falls back to CH_PLAY if not set.
  const ch = (key) => cfg(key) || cfg('CH_PLAY');
  if (ch('CH_COLOUR')) startColourLoop(client, ch('CH_COLOUR')).catch(console.error);
  if (ch('CH_CRASH'))  startCrashLoop(client,  ch('CH_CRASH')).catch(console.error);
  if (cfg('CH_MATKA')) startMatkaLoop(client, cfg('CH_MATKA')).catch(console.error);
  if (cfg('CH_IPL'))   startIplLoop(client);

  if (cfg('CH_LIVE_DASHBOARD'))
    startLiveDashboard(client, cfg('CH_LIVE_DASHBOARD')).catch(console.error);

  startSlotsPredictionPoller(client);

  // heartbeat
  setInterval(() => {
    q(`UPDATE bot_status SET last_seen=now(), version='1.0.0' WHERE id=1`).catch(()=>{});
  }, 30_000);
  botHeartbeat(client).catch(()=>{});
});

// Keep Express alive even if Discord login fails (bad token, network, etc.)
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message ?? err);
});

startWebhookServer(client);

client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[FATAL] Discord login failed:', e.message);
});
