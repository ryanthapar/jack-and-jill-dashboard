const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { connect } = require('./db');
const { createApp } = require('./app');

const production = process.env.NODE_ENV === 'production';

async function init() {
  const db = await connect({
    url: process.env.DATABASE_URL || process.env.POSTGRES_URL,
    dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'pgdata'),
  });

  // Ensure an admin exists. On first run without ADMIN_PASSWORD (local dev only) a random one is generated.
  const [admin] = await db.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
  if (!admin) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.ADMIN_PASSWORD || (production ? null : crypto.randomBytes(9).toString('base64url'));
    if (!password) {
      console.warn('No admin exists. Set ADMIN_EMAIL and ADMIN_PASSWORD, then redeploy to create one.');
    } else {
      await db.query(
        "INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', $1, $2, 'admin') ON CONFLICT DO NOTHING",
        [email, bcrypt.hashSync(password, 10)]
      );
      console.log(`Created admin account: ${email}`);
      if (!process.env.ADMIN_PASSWORD) console.log(`Generated password (shown once, change it after logging in): ${password}`);
    }
  }

  if (production && !process.env.SESSION_SECRET) console.warn('Warning: set SESSION_SECRET in production.');
  return createApp(db, { secureCookies: production, sessionSecret: process.env.SESSION_SECRET });
}

// The exported Express app waits for init (DB connect + schema) before serving,
// so it works both as a long-running server and as a Vercel serverless function.
const ready = init();
ready.catch((e) => console.error('Startup failed:', e));
const wrapper = express();
wrapper.use((req, res, next) => ready.then((app) => app(req, res, next), next));
wrapper.use((err, req, res, next) => res.status(500).json({ error: 'Server unavailable' }));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  ready.then(() => wrapper.listen(port, () => console.log(`Listening on http://localhost:${port}`)));
}

module.exports = wrapper;
