const METRICS = ['doors', 'contacts', 'calls', 'conversations', 'leads'];
const counts = METRICS.map((m) => `${m} INTEGER NOT NULL DEFAULT 0`).join(',\n  ');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));
CREATE TABLE IF NOT EXISTS goals (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ${counts}
);
CREATE TABLE IF NOT EXISTS stats (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  ${counts},
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset BIGINT NOT NULL
);`;

// Returns { query(sql, params) -> rows[], tx(fn(query)), close() }.
// With DATABASE_URL set it uses Postgres (production / Vercel); otherwise an
// embedded Postgres (PGlite) — persisted to `dataDir`, or in memory if omitted.
async function connect({ url, dataDir } = {}) {
  let db;
  if (url) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(url);
    const pool = new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
    db = {
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn(async (sql, params) => (await c.query(sql, params)).rows);
          await c.query('COMMIT');
          return out;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally { c.release(); }
      },
      close: () => pool.end(),
    };
    // Serialize schema creation across concurrent cold starts.
    const c = await pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(727001)');
      await c.query(SCHEMA);
    } finally {
      await c.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
      c.release();
    }
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const pg = new PGlite(dataDir);
    await pg.exec(SCHEMA);
    db = {
      query: async (sql, params) => (await pg.query(sql, params)).rows,
      tx: (fn) => pg.transaction((t) => fn(async (sql, params) => (await t.query(sql, params)).rows)),
      close: () => pg.close(),
    };
  }
  return db;
}

module.exports = { connect, METRICS };
