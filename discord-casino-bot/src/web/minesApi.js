// Web Mines: session-based via the existing game_sessions table. Reuses the exact
// 20-tile bomb math + preset bomb-swap, and the standard lock/settle money pattern.
import { q } from '../db/index.js';
import { applyTx, requireActive, getWallet, getPreset, getUserPreset, loadSession, saveSession, deleteSession } from '../repo.js';
import { resolveAmountPreset } from '../util/amountPreset.js';
import { newServerSeed } from '../util/fairness.js';
import { toPaise } from '../util/money.js';
import { cfg } from '../config.js';
import { logBetResult, broadcastBigWin } from '../admin/logs.js';
import { minesBombs, minesMultiplier, MINES_TILES } from './gameService.js';

async function resolvePreset(userId, stake) {
  return (await getUserPreset(userId, 'mines')) || (await resolveAmountPreset(stake)) || (await getPreset('mines'));
}

export function mountMinesApi(app, client, requirePlay) {
  app.post('/api/play/mines/start', requirePlay, async (req, res) => {
    if (cfg('MAINTENANCE_MODE') === 'true') return res.status(400).json({ error: 'maintenance' });
    const amount = Number(req.body?.amount);
    const mines = Math.floor(Number(req.body?.mines));
    const min = Number(cfg('MIN_BET') || 1), max = Number(cfg('MAX_BET') || 10000);
    if (!Number.isFinite(amount) || amount < min || amount > max) return res.status(400).json({ error: 'bet_range', min, max });
    if (!Number.isFinite(mines) || mines < 1 || mines > MINES_TILES - 1) return res.status(400).json({ error: 'bad_mines' });

    let u; try { u = await requireActive(req.player.discordId, req.player.name); } catch { return res.status(400).json({ error: 'suspended' }); }
    const existing = await loadSession(req.player.discordId, 'mines');
    if (existing) return res.status(400).json({ error: 'active_game' });

    const stake = toPaise(amount);
    try { await applyTx({ userId: u.id, type: 'bet', amount: -stake, lockDelta: stake, ref: null, meta: { game: 'mines', mines } }); }
    catch { return res.status(400).json({ error: 'insufficient' }); }

    const preset = await resolvePreset(u.id, stake);
    const seed = newServerSeed();
    const bombs = minesBombs(seed, mines);
    const { rows: br } = await q(`INSERT INTO bets(user_id,game,stake,selection,result) VALUES($1,'mines',$2,$3,'pending') RETURNING id`,
      [u.id, stake.toString(), { mines }]);
    const data = { userId: u.id, username: u.username, stake: stake.toString(), mines, bombs, revealed: [], seed, preset, multiplier: 1 };
    await saveSession(u.id, 'mines', data, br[0].id);
    res.json({ ok: true, tiles: MINES_TILES, mines, revealed: [], multiplier: 1, balance: (await getWallet(u.id)).available.toString() });
  });

  app.post('/api/play/mines/reveal', requirePlay, async (req, res) => {
    const idx = Math.floor(Number(req.body?.idx));
    const sess = await loadSession(req.player.discordId, 'mines');
    if (!sess) return res.status(400).json({ error: 'no_game' });
    const s = sess.data; const betId = sess.bet_id;
    if (!Number.isFinite(idx) || idx < 0 || idx >= MINES_TILES) return res.status(400).json({ error: 'bad_idx' });
    if (s.revealed.includes(idx)) return res.status(400).json({ error: 'already' });

    const bombs = new Set(s.bombs);
    // Preset bomb-swap on the very first reveal.
    if (s.revealed.length === 0) {
      if (s.preset === 'low' && bombs.has(idx)) {
        const safe = [...Array(MINES_TILES).keys()].find(k => !bombs.has(k));
        if (safe != null) { bombs.delete(idx); bombs.add(safe); }
      } else if ((s.preset === 'high' || s.preset === 'extreme') && !bombs.has(idx)) {
        const rm = [...bombs][0]; bombs.delete(rm); bombs.add(idx);
      }
      s.bombs = [...bombs];
    }

    const stake = BigInt(s.stake);
    if (bombs.has(idx)) {
      await applyTx({ userId: s.userId, type: 'bet', amount: 0n, lockDelta: -stake, ref: null, meta: { game: 'mines', result: 'bomb' } });
      if (betId) await q(`UPDATE bets SET payout='0', result='loss', settled_at=now() WHERE id=$1`, [betId]);
      logBetResult(client, { user: s.username, discordId: req.player.discordId, game: 'mines', stake: s.stake, payout: '0', result: 'loss' });
      await deleteSession(s.userId, 'mines');
      return res.json({ ok: true, bomb: true, idx, bombs: [...bombs], balance: (await getWallet(s.userId)).available.toString() });
    }

    s.revealed.push(idx);
    s.multiplier = minesMultiplier(s.revealed.length, s.mines);
    await saveSession(s.userId, 'mines', s, betId);
    res.json({ ok: true, bomb: false, idx, revealed: s.revealed, multiplier: s.multiplier, next: minesMultiplier(s.revealed.length + 1, s.mines) });
  });

  app.post('/api/play/mines/cashout', requirePlay, async (req, res) => {
    const sess = await loadSession(req.player.discordId, 'mines');
    if (!sess) return res.status(400).json({ error: 'no_game' });
    const s = sess.data; const betId = sess.bet_id;
    if (s.revealed.length === 0) return res.status(400).json({ error: 'no_gems' });

    const stake = BigInt(s.stake);
    const payout = BigInt(Math.floor(Number(stake) * s.multiplier));
    await applyTx({ userId: s.userId, type: 'win', amount: payout, lockDelta: -stake, ref: null, meta: { game: 'mines', multiplier: s.multiplier } });
    if (betId) await q(`UPDATE bets SET payout=$1, result='win', settled_at=now() WHERE id=$2`, [payout.toString(), betId]);
    logBetResult(client, { user: s.username, discordId: req.player.discordId, game: 'mines', stake: s.stake, payout: payout.toString(), result: 'win' });
    if (payout >= toPaise(Number(cfg('BIG_WIN_BROADCAST') || 5000))) broadcastBigWin(client, s.username, 'Mines', payout).catch(() => {});
    await deleteSession(s.userId, 'mines');
    res.json({ ok: true, payout: payout.toString(), multiplier: s.multiplier, bombs: s.bombs, balance: (await getWallet(s.userId)).available.toString() });
  });

  app.get('/api/play/mines/state', requirePlay, async (req, res) => {
    const sess = await loadSession(req.player.discordId, 'mines');
    if (!sess) return res.json({ active: false });
    const s = sess.data;
    res.json({ active: true, tiles: MINES_TILES, mines: s.mines, revealed: s.revealed, multiplier: s.multiplier, next: minesMultiplier(s.revealed.length + 1, s.mines), stake: s.stake });
  });
}
