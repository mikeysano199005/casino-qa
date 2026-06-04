// Web Aviator: no-login access via a signed token, then a cookie session.
// Mounts the game page (/play), static assets, and the play API (/api/play/*).
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { upsertUser, getWallet } from '../repo.js';
import { startEngine, addSubscriber, placeBet, cashOut, subscriberCount } from './crashEngine.js';
import { mountAccountApi } from './accountApi.js';
import { mountGamesApi } from './gamesApi.js';
import { mountMinesApi } from './minesApi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'play_session';
const secret = () => process.env.ADMIN_SESSION_SECRET || 'dev-secret-change-me';

// Signed login token embedded in the Discord "Play on Web" link (per user).
export function signPlayToken(discordId, name) {
  return jwt.sign({ sub: String(discordId), name: name || 'player', kind: 'play' }, secret(), { expiresIn: '2h' });
}

function readSession(req) {
  // Prefer a fresh ?t token (from the Discord link); otherwise the cookie.
  const t = req.query?.t || req.cookies?.[COOKIE];
  if (!t) return null;
  try {
    const p = jwt.verify(String(t), secret());
    if (p.kind !== 'play') return null;
    return { discordId: p.sub, name: p.name };
  } catch { return null; }
}

function requirePlay(req, res, next) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  req.player = s;
  next();
}

export function mountPlay(app, client) {
  startEngine(client);

  // Static assets (css/js) — no auth needed.
  app.use('/play/assets', express.static(PUBLIC_DIR));

  // Game page: accept ?t (Discord link) or existing cookie.
  app.get('/play', async (req, res) => {
    const s = readSession(req);
    if (!s) {
      res.status(401).setHeader('Content-Type', 'text/html');
      return res.send(`<body style="background:#0d0d0f;color:#fff;font-family:system-ui;text-align:center;padding-top:80px">
        <h2>🔒 Open from Discord</h2><p>Tap the <b>🌐 Play on Web</b> button in the server to get your private link.</p></body>`);
    }
    try { await upsertUser(s.discordId, s.name); } catch {}
    res.cookie(COOKIE, signPlayToken(s.discordId, s.name), {
      httpOnly: true, sameSite: 'lax',
      secure: (process.env.PUBLIC_BASE_URL || '').startsWith('https'),
      maxAge: 2 * 60 * 60 * 1000,
    });
    res.sendFile(path.join(PUBLIC_DIR, 'play.html'));
  });

  // ── API ──────────────────────────────────────────────────────────────
  app.get('/api/play/me', requirePlay, async (req, res) => {
    try {
      const u = await upsertUser(req.player.discordId, req.player.name);
      const w = await getWallet(u.id);
      res.json({ name: req.player.name, balance: (w?.available ?? 0).toString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/play/stream', requirePlay, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    // resolve internal user id so the engine can target per-user events
    upsertUser(req.player.discordId, req.player.name)
      .then(u => {
        const remove = addSubscriber(res, u.id);
        const hb = setInterval(() => { try { res.write(`event: hb\ndata: ${subscriberCount()}\n\n`); } catch {} }, 20000);
        req.on('close', () => { clearInterval(hb); remove(); });
      })
      .catch(() => res.end());
  });

  app.post('/api/play/bet', requirePlay, async (req, res) => {
    const out = await placeBet(req.player.discordId, req.player.name, req.body?.amount);
    res.status(out.ok ? 200 : 400).json(out);
  });

  app.post('/api/play/cashout', requirePlay, async (req, res) => {
    const out = await cashOut(req.player.discordId, req.player.name);
    res.status(out.ok ? 200 : 400).json(out);
  });

  // Wallet (deposit/withdraw) + account (profile/history/daily/redeem/referral).
  mountAccountApi(app, client, requirePlay);
  // Instant games: dice + slots.
  mountGamesApi(app, client, requirePlay);
  // Mines (session-based).
  mountMinesApi(app, client, requirePlay);

  console.log('▶ web aviator mounted at /play');
}
