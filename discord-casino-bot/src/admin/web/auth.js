// Discord OAuth2 login for the web admin panel. Access is restricted to the
// Discord user IDs in ADMIN_USER_IDS — the same allowlist the in-Discord admin
// buttons use. On success we issue a signed JWT in an httpOnly cookie.
import axios from 'axios';
import jwt from 'jsonwebtoken';

const COOKIE = 'admin_session';
const SCOPE = 'identify';

const adminIds = () => (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = (id) => adminIds().includes(String(id));

const sessionSecret = () => process.env.ADMIN_SESSION_SECRET || '';
const baseUrl = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const redirectUri = () => `${baseUrl()}/admin/callback`;

function configError() {
  const missing = [];
  if (!process.env.DISCORD_CLIENT_ID)     missing.push('DISCORD_CLIENT_ID');
  if (!process.env.DISCORD_CLIENT_SECRET) missing.push('DISCORD_CLIENT_SECRET');
  if (!process.env.ADMIN_SESSION_SECRET)  missing.push('ADMIN_SESSION_SECRET');
  if (!process.env.PUBLIC_BASE_URL)       missing.push('PUBLIC_BASE_URL');
  return missing.length ? missing : null;
}

// Middleware: require a valid admin session for /api/admin/* and the panel page.
export function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return deny(req, res);
    const payload = jwt.verify(token, sessionSecret());
    if (!isAdmin(payload.sub)) return deny(req, res);
    req.admin = { id: payload.sub, username: payload.username };
    next();
  } catch {
    return deny(req, res);
  }
}

function deny(req, res) {
  // req.path is stripped of the router mount prefix, so use originalUrl.
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/admin/login');
}

export function registerAuthRoutes(app) {
  app.get('/admin/login', (req, res) => {
    const missing = configError();
    if (missing) return res.status(500).send(`Admin panel not configured. Missing env: ${missing.join(', ')}`);
    const url = new URL('https://discord.com/api/oauth2/authorize');
    url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    res.redirect(url.toString());
  });

  app.get('/admin/callback', async (req, res) => {
    const missing = configError();
    if (missing) return res.status(500).send(`Admin panel not configured. Missing env: ${missing.join(', ')}`);
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code.');
    try {
      const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
        new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: redirectUri(),
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

      const me = await axios.get('https://discord.com/api/users/@me',
        { headers: { Authorization: `Bearer ${tokenRes.data.access_token}` } });

      if (!isAdmin(me.data.id)) {
        return res.status(403).send(`<body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding-top:80px">
          <h2>403 — Not authorised</h2><p>Your Discord account is not on the admin list.</p></body>`);
      }

      const token = jwt.sign(
        { sub: me.data.id, username: me.data.username },
        sessionSecret(),
        { expiresIn: '7d' });

      res.cookie(COOKIE, token, {
        httpOnly: true,
        secure: baseUrl().startsWith('https'),
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.redirect('/admin');
    } catch (e) {
      console.error('[admin oauth]', e.response?.data || e.message);
      res.status(500).send('OAuth failed. Check DISCORD_CLIENT_ID/SECRET and the redirect URI.');
    }
  });

  app.get('/admin/logout', (_req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/admin/login');
  });
}
