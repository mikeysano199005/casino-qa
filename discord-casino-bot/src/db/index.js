import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const url = process.env.DATABASE_URL || '';

// Supabase Transaction Pooler uses port 6543 and doesn't support prepared statements.
// Direct connection (port 5432) or Session Pooler (port 5432) support them fine.
const isSupabasePooler = url.includes('pooler.supabase.com') && url.includes(':6543');

export const pool = new Pool({
  connectionString: url,
  ssl: url.includes('supabase') || url.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
  max: isSupabasePooler ? 10 : 20,
  // Transaction Pooler requires this; harmless on direct connections
  ...(isSupabasePooler ? { statement_timeout: 10_000 } : {}),
});

pool.on('error', (err) => console.error('[db pool error]', err.message));

export const q = (text, params) => pool.query(text, params);

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
