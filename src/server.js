const crypto = require('crypto');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createStore, EmailTakenError } = require('./store');
const { createApp } = require('./create-app');

const production = process.env.NODE_ENV === 'production';

async function init() {
  if (production && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be set in production');
  if (production && !process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT must be set in production');
  const store = createStore();

  // Ensure an admin exists. On first run without ADMIN_PASSWORD (local dev only) a random one is generated.
  if (!(await store.hasAdmin())) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const password = process.env.ADMIN_PASSWORD || (production ? null : crypto.randomBytes(9).toString('base64url'));
    if (!password) {
      console.warn('No admin exists. Set ADMIN_EMAIL and ADMIN_PASSWORD, then redeploy to create one.');
    } else {
      try {
        await store.createUser({ name: 'Admin', email, password_hash: bcrypt.hashSync(password, 10), role: 'admin' });
        console.log(`Created admin account: ${email}`);
        if (!process.env.ADMIN_PASSWORD) console.log(`Generated password (shown once, change it after logging in): ${password}`);
      } catch (e) {
        if (!(e instanceof EmailTakenError)) throw e; // another instance created it first
      }
    }
  }
  return createApp(store, { secureCookies: production, sessionSecret: process.env.SESSION_SECRET });
}

// The exported Express app serves static files immediately and API requests once init (DB + admin
// check) succeeds. A failed or slow init is not cached: the next request tries again.
let appPromise = null;
function getApp() {
  if (!appPromise) {
    appPromise = init();
    appPromise.catch((e) => { console.error('Startup failed:', e); appPromise = null; });
  }
  return appPromise;
}
getApp().catch(() => {});

const wrapper = express();
wrapper.use(express.static(path.join(__dirname, '..', 'public')));
wrapper.use(async (req, res, next) => {
  try {
    const app = await getApp();
    app(req, res, next);
  } catch (err) {
    next(err);
  }
});
// Startup failures report their reason instead of crashing the function.
wrapper.use((err, req, res, next) => {
  res.status(503).json({ error: 'Server unavailable', reason: String(err && err.message).replace(/\s+/g, ' ').slice(0, 300) });
});
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  getApp().then(() => wrapper.listen(port, () => console.log(`Listening on http://localhost:${port}`)));
}

module.exports = wrapper;
