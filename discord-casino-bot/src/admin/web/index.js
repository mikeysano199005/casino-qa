// Mounts the web admin panel onto the existing Express app:
//   /admin/login | /admin/callback | /admin/logout  → Discord OAuth (public)
//   /admin (+ static assets)                         → SPA   (requireAdmin)
//   /api/admin/*                                      → JSON API (requireAdmin)
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAuthRoutes, requireAdmin } from './auth.js';
import { adminApiRouter } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

export function mountAdminPanel(app, client) {
  // OAuth routes first so /admin/login etc. win over the static /admin mount.
  registerAuthRoutes(app);

  // JSON API
  app.use('/api/admin', requireAdmin, adminApiRouter(client));

  // SPA + assets (gated). express.static serves index.html for the bare /admin.
  app.use('/admin', requireAdmin, express.static(PUBLIC_DIR));

  console.log('▶ admin panel mounted at /admin');
}
