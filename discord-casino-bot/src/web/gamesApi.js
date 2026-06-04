// Web Dice + Slots: single-shot bet endpoints reusing the shared outcome logic
// and the exact money pattern (lock → settle → bets row). Honors presets + rigging.
import { q } from '../db/index.js';
import { applyTx, requireActive, getWallet, getPreset, getUserPreset } from '../repo.js';
import { resolveAmountPreset } from '../util/amountPreset.js';
import { newServerSeed } from '../util/fairness.js';
import { toPaise } from '../util/money.js';
import { cfg } from '../config.js';
import { logBetResult, broadcastBigWin } from '../admin/logs.js';
import { diceOutcome, slotsSpin } from './gameService.js';
import { SYMBOLS } from '../games/slots.js';

async function resolvePreset(userId, game, stake) {
  return (await getUserPreset(userId, game)) || (await resolveAmountPreset(stake)) || (await getPreset(game));
}
const betLimits = () => ({ min: Number(cfg('MIN_BET') || 1), max: Number(cfg('MAX_BET') || 10000) });

export function mountGamesApi(app, client, requirePlay) {
  app.get('/api/play/slots/symbols', requirePlay, (_req, res) =>
    res.json(SYMBOLS.map((s, i) => ({ index: i, symbol: s.s, pay: s.pay }))));

  app.post('/api/play/dice', requirePlay, async (req, res) => {
    if (cfg('MAINTENANCE_MODE') === 'true') return res.status(400).json({ error: 'maintenance' });
    const amount = Number(req.body?.amount);
    const side = req.body?.side === 'OVER' ? 'OVER' : 'UNDER';
    const target = Math.floor(Number(req.body?.target));
    const { min, max } = betLimits();
    if (!Number.isFinite(amount) || amount < min || amount > max) return res.status(400).json({ error: 'bet_range', min, max });
    if (!Number.isFinite(target) || target < 2 || target > 98) return res.status(400).json({ error: 'bad_target' });

    let u; try { u = await requireActive(req.player.discordId, req.player.name); } catch { return res.status(400).json({ error: 'suspended' }); }
    const stake = toPaise(amount);
    try { await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake, ref: null, meta: { game: 'dice', side, target } }); }
    catch { return res.status(400).json({ error: 'insufficient' }); }

    const preset = await resolvePreset(u.id, 'dice', stake);
    const o = diceOutcome(stake, side, target, newServerSeed(), preset);
    await applyTx({ userId: u.id, type: o.win ? 'win' : 'bet', amount: o.win ? o.payout : 0n, lockDelta: -stake, ref: null, meta: { game: 'dice', roll: o.roll } });
    await q(`INSERT INTO bets(user_id,game,stake,selection,payout,result,settled_at) VALUES($1,'dice',$2,$3,$4,$5,now())`,
      [u.id, stake.toString(), { side, target, roll: o.roll }, (o.win ? o.payout : 0n).toString(), o.win ? 'win' : 'loss']);
    logBetResult(client, { user: u.username, discordId: req.player.discordId, game: 'dice', stake: stake.toString(), payout: (o.win ? o.payout : 0n).toString(), result: o.win ? 'win' : 'loss' });
    if (o.win && o.payout >= toPaise(Number(cfg('BIG_WIN_BROADCAST') || 5000))) broadcastBigWin(client, u.username, 'Dice', o.payout).catch(() => {});
    const w = await getWallet(u.id);
    res.json({ ok: true, roll: o.roll, win: o.win, payout: (o.win ? o.payout : 0n).toString(), multiplier: o.multiplier, balance: w.available.toString() });
  });

  app.post('/api/play/slots', requirePlay, async (req, res) => {
    if (cfg('MAINTENANCE_MODE') === 'true') return res.status(400).json({ error: 'maintenance' });
    const amount = Number(req.body?.amount);
    const { min, max } = betLimits();
    if (!Number.isFinite(amount) || amount < min || amount > max) return res.status(400).json({ error: 'bet_range', min, max });

    let u; try { u = await requireActive(req.player.discordId, req.player.name); } catch { return res.status(400).json({ error: 'suspended' }); }
    const stake = toPaise(amount);
    try { await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake, ref: null, meta: { game: 'slots' } }); }
    catch { return res.status(400).json({ error: 'insufficient' }); }

    const preset = await resolvePreset(u.id, 'slots', stake);
    const o = slotsSpin(newServerSeed(), req.player.discordId, preset);
    const payout = o.win ? BigInt(Math.floor(Number(stake) * o.mult)) : 0n;
    await applyTx({ userId: u.id, type: o.win ? 'win' : 'bet', amount: payout, lockDelta: -stake, ref: null, meta: { game: 'slots' } });
    await q(`INSERT INTO bets(user_id,game,stake,selection,payout,result,settled_at) VALUES($1,'slots',$2,$3,$4,$5,now())`,
      [u.id, stake.toString(), { reels: o.reels.map(s => s.s) }, payout.toString(), o.win ? 'win' : 'loss']);
    logBetResult(client, { user: u.username, discordId: req.player.discordId, game: 'slots', stake: stake.toString(), payout: payout.toString(), result: o.win ? 'win' : 'loss' });
    if (o.win && payout >= toPaise(Number(cfg('BIG_WIN_BROADCAST') || 5000))) broadcastBigWin(client, u.username, 'Slots', payout).catch(() => {});
    const w = await getWallet(u.id);
    res.json({ ok: true, reels: o.reels.map(s => s.s), win: o.win, mult: o.mult, payout: payout.toString(), balance: w.available.toString() });
  });
}
