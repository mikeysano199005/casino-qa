import { EmbedBuilder, Colors } from 'discord.js';
import { q } from '../db/index.js';
import { fmt } from '../util/money.js';

let msgId = null;
let channel = null;

async function fetchStats() {
  const { rows: [k] } = await q(`SELECT
    (SELECT COUNT(*) FROM users)                                                                        AS total_users,
    (SELECT COUNT(DISTINCT user_id) FROM bets WHERE created_at > now() - interval '24 hours')          AS active_24h,
    (SELECT COUNT(*) FROM game_sessions)                                                                AS live_sessions,
    (SELECT COUNT(*) FROM bets WHERE created_at > now() - interval '5 minutes')                        AS bets_5m,
    (SELECT COALESCE(SUM(stake::bigint),0) FROM bets WHERE created_at > now() - interval '5 minutes')  AS vol_5m,
    (SELECT COUNT(*) FROM bets WHERE created_at > now() - interval '1 hour')                           AS bets_1h,
    (SELECT COALESCE(SUM(stake::bigint),0) FROM bets WHERE created_at > now() - interval '1 hour')     AS vol_1h,
    (SELECT COALESCE(SUM(stake::bigint - payout::bigint),0) FROM bets
      WHERE settled_at > now() - interval '24 hours' AND result NOT IN ('pending','push','abandoned'))  AS ggr_24h,
    (SELECT COUNT(*) FROM deposits WHERE status='paid' AND created_at > now() - interval '24 hours')   AS dep_count,
    (SELECT COALESCE(SUM(amount::bigint),0) FROM deposits WHERE status='paid'
      AND created_at > now() - interval '24 hours')                                                    AS dep_vol,
    (SELECT COUNT(*) FROM withdrawals WHERE status='paid' AND settled_at > now() - interval '24 hours') AS wd_count,
    (SELECT COALESCE(SUM(amount::bigint),0) FROM withdrawals WHERE status='paid'
      AND settled_at > now() - interval '24 hours')                                                    AS wd_vol,
    (SELECT COUNT(*) FROM withdrawals WHERE status='pending')                                          AS pending_wd
  `);

  const { rows: recentBets } = await q(`
    SELECT b.game, b.stake, b.payout, b.result, u.username
    FROM bets b JOIN users u ON u.id = b.user_id
    WHERE b.created_at > now() - interval '5 minutes'
    ORDER BY b.created_at DESC LIMIT 8
  `);

  return { k, recentBets };
}

function buildEmbeds(k, recentBets) {
  const ggr = BigInt(k.ggr_24h);
  const ggrColor = ggr >= 0n ? Colors.Green : Colors.Red;

  const main = new EmbedBuilder()
    .setColor(ggrColor)
    .setTitle('📡 Live Dashboard')
    .addFields(
      { name: '👥 Players',         value: `**${k.total_users}** registered • **${k.active_24h}** played today`,          inline: false },
      { name: '🎮 Active Games',    value: `**${k.live_sessions}** live (Mines / Blackjack mid-hand)`,                    inline: false },
      { name: '🎯 Bets — last 5m',  value: `**${k.bets_5m}** bets • ${fmt(BigInt(k.vol_5m))} staked`,                   inline: true },
      { name: '🎯 Bets — last 1h',  value: `**${k.bets_1h}** bets • ${fmt(BigInt(k.vol_1h))} staked`,                   inline: true },
      { name: `📊 House Profit (24h)`, value: `**${fmt(ggr)}**\n_Bets collected − Winnings paid out_`,                   inline: false },
      { name: '💰 Deposits today',  value: `**${k.dep_count}** deposits • ${fmt(BigInt(k.dep_vol))} received`,            inline: true },
      { name: '🏧 Withdrawals paid', value: `**${k.wd_count}** paid • ${fmt(BigInt(k.wd_vol))} sent`,                    inline: true },
      { name: '⏳ Pending Withdrawals', value: `**${k.pending_wd}** waiting for your approval — check Admin Panel`,       inline: false },
    )
    .setFooter({ text: 'Live • updates every 30s' })
    .setTimestamp();

  const recentLines = recentBets.length
    ? recentBets.map(b => {
        const icon = b.result === 'win' ? '✅' : b.result === 'push' ? '↔️' : '❌';
        const net = b.result === 'win'
          ? `+${fmt(BigInt(b.payout) - BigInt(b.stake))}`
          : b.result === 'push' ? `±0` : `-${fmt(BigInt(b.stake))}`;
        return `${icon} **${b.username}** • ${b.game} • stake ${fmt(BigInt(b.stake))} • ${net}`;
      }).join('\n')
    : '*No bets in the last 5 minutes.*';

  const feed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('🎯 Recent Bets (last 5 min)')
    .setDescription(recentLines);

  return [main, feed];
}

async function update() {
  if (!channel) return;
  try {
    const { k, recentBets } = await fetchStats();
    const embeds = buildEmbeds(k, recentBets);

    if (msgId) {
      try {
        const m = await channel.messages.fetch(msgId);
        await m.edit({ embeds });
        return;
      } catch {
        msgId = null;
      }
    }
    const sent = await channel.send({ embeds });
    msgId = sent.id;
  } catch (e) {
    console.error('[dashboard]', e.message);
  }
}

export async function startLiveDashboard(client, channelId) {
  channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return console.warn('[dashboard] channel not found:', channelId);

  // Clear old dashboard messages
  const old = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (old) {
    for (const m of old.filter(m => m.author.id === client.user.id).values()) {
      await m.delete().catch(() => {});
    }
  }

  await update();
  setInterval(() => update().catch(e => console.error('[dashboard]', e)), 30_000);
}
