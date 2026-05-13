import { EmbedBuilder, Colors } from 'discord.js';
import { q } from '../db/index.js';
import { slotsForced, SYMBOLS } from '../games/slots.js';

const COLOUR_OPTIONS = [
  { key: 'green',  color: '🟢', payout: 2 },
  { key: 'red',    color: '🔴', payout: 2 },
  { key: 'violet', color: '🟣', payout: 8 },
];

async function fetchPending(product, settledRoundId) {
  const { rows } = await q(
    `SELECT pp.*, gr.created_at AS round_started_at
     FROM prediction_purchases pp
     CROSS JOIN (SELECT created_at FROM game_rounds WHERE id = $1) gr
     WHERE pp.product = $2
       AND pp.paid_at       IS NOT NULL
       AND pp.delivered_at  IS NULL
       AND pp.expired_at    IS NULL`,
    [settledRoundId, product]
  );
  return rows;
}

async function didBetInRound(discordId, roundId, game) {
  const { rows } = await q(
    `SELECT b.id FROM bets b
     JOIN users u ON u.id = b.user_id
     WHERE b.round_id = $1 AND b.game = $2 AND u.discord_id = $3
     LIMIT 1`,
    [roundId, game, discordId]
  );
  return rows.length > 0;
}

async function expire(id, reason, client, discordId, message) {
  await q(`UPDATE prediction_purchases SET expired_at=now(), expired_reason=$1 WHERE id=$2`, [reason, id]);
  try {
    const u = await client.users.fetch(discordId);
    await u.send({ content: message });
  } catch {}
}

// Called in matka tick() after openRound() so state.predictedWinner is set
export async function deliverMatkaPredictions(client, settledRoundId, winner, endsAt) {
  const purchases = await fetchPending('matka', settledRoundId);
  for (const p of purchases) {
    const bet = await didBetInRound(p.discord_id, settledRoundId, 'matka');
    if (bet) {
      try {
        const u = await client.users.fetch(p.discord_id);
        await u.send({
          embeds: [new EmbedBuilder()
            .setColor(Colors.Purple)
            .setTitle('🎯 Matka — VIP Prediction')
            .setDescription(
              `**Winning number: ${winner}**\n` +
              `Round closes at <t:${Math.floor(endsAt / 1000)}:T>\n` +
              `*Bet on **${winner}** before the round ends to win 9× your stake!*`
            )],
        });
        await q(`UPDATE prediction_purchases SET delivered_at=now(), prior_bet_verified=true WHERE id=$1`, [p.id]);
      } catch (e) { console.warn('[matka vip]', p.discord_id, e.message); }
    } else {
      // Grace: if purchased during/after the settled round started → skip, check next round
      const purchasedBeforeRound = p.round_started_at && new Date(p.paid_at) < new Date(p.round_started_at);
      if (purchasedBeforeRound) {
        await expire(p.id, 'no_prior_bet', client, p.discord_id,
          '⚠️ Your **Matka VIP Prediction** has expired — no bet was placed in the required round. Contact support for assistance.');
      }
    }
  }
}

// Called in colour tick() after openRound() so state.predictedWinner is set
export async function deliverColourPredictions(client, settledRoundId, winner, endsAt) {
  const opt = COLOUR_OPTIONS.find(o => o.key === winner);
  const purchases = await fetchPending('colour', settledRoundId);
  for (const p of purchases) {
    const bet = await didBetInRound(p.discord_id, settledRoundId, 'colour');
    if (bet) {
      try {
        const u = await client.users.fetch(p.discord_id);
        await u.send({
          embeds: [new EmbedBuilder()
            .setColor(winner === 'green' ? Colors.Green : winner === 'red' ? Colors.Red : Colors.Purple)
            .setTitle('🎨 Colour — VIP Prediction')
            .setDescription(
              `**Winning colour: ${opt.color} ${winner.toUpperCase()}**\n` +
              `Round closes at <t:${Math.floor(endsAt / 1000)}:T>\n` +
              `*Bet on **${winner}** before the round ends to win ${opt.payout}× your stake!*`
            )],
        });
        await q(`UPDATE prediction_purchases SET delivered_at=now(), prior_bet_verified=true WHERE id=$1`, [p.id]);
      } catch (e) { console.warn('[colour vip]', p.discord_id, e.message); }
    } else {
      const purchasedBeforeRound = p.round_started_at && new Date(p.paid_at) < new Date(p.round_started_at);
      if (purchasedBeforeRound) {
        await expire(p.id, 'no_prior_bet', client, p.discord_id,
          '⚠️ Your **Colour VIP Prediction** has expired — no bet was placed in the required round. Contact support for assistance.');
      }
    }
  }
}

// Polls every 5s for paid slots purchases and delivers immediately
export function startSlotsPredictionPoller(client) {
  setInterval(async () => {
    try {
      const { rows } = await q(
        `SELECT * FROM prediction_purchases
         WHERE product = 'slots'
           AND paid_at      IS NOT NULL
           AND delivered_at IS NULL
           AND expired_at   IS NULL`
      );
      for (const p of rows) {
        // Expire after 24 hours
        if (new Date(p.paid_at) < new Date(Date.now() - 86_400_000)) {
          await expire(p.id, 'slots_timeout', client, p.discord_id,
            '⚠️ Your **Slots VIP Prediction** has expired (24-hour limit). Contact support for assistance.');
          continue;
        }
        const sym = SYMBOLS[p.slots_symbol_index];
        if (!sym) continue;
        slotsForced.set(p.discord_id, { type: 'symbol', symbol: sym });
        try {
          const u = await client.users.fetch(p.discord_id);
          await u.send({
            embeds: [new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle('🎰 Slots — VIP Prediction')
              .setDescription(
                `Your next spin will land **${sym.s} ${sym.s} ${sym.s}** (${sym.pay}× your stake)!\n\n` +
                `Go spin now — this expires in **24 hours**.`
              )],
          });
          await q(`UPDATE prediction_purchases SET delivered_at=now() WHERE id=$1`, [p.id]);
        } catch (e) { console.warn('[slots vip]', p.discord_id, e.message); }
      }
    } catch (e) { console.error('[slots poller]', e.message); }
  }, 5_000);
}
