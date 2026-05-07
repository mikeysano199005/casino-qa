import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, '../../migrations');

// Track which migrations have already run
const c = await pool.connect();
try {
  await c.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      ran_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows: done } = await c.query(`SELECT filename FROM schema_migrations`);
  const ran = new Set(done.map(r => r.filename));

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const pending = files.filter(f => !ran.has(f));

  if (!pending.length) {
    console.log('✅ No pending migrations.');
  } else {
    for (const f of pending) {
      console.log(`▶ running ${f} …`);
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query(`INSERT INTO schema_migrations(filename) VALUES ($1)`, [f]);
        await c.query('COMMIT');
        console.log(`  ✅ ${f} done`);
      } catch (e) {
        await c.query('ROLLBACK');
        console.error(`  ❌ ${f} failed:`, e.message);
        process.exit(1);
      }
    }
    console.log('✅ All migrations complete.');
  }
} finally {
  c.release();
  await pool.end();
}
