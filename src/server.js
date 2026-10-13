const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { open } = require('./db');
const { createApp } = require('./app');

const db = open(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db'));

// First run: create an admin account.
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', ?, ?, 'admin')").run(email, bcrypt.hashSync(password, 10));
  console.log(`Created admin account: ${email}`);
  if (generated) console.log(`Generated password (shown once, change it after logging in): ${password}`);
}

const secure = process.env.NODE_ENV === 'production';
if (secure && !process.env.SESSION_SECRET) console.warn('Warning: set SESSION_SECRET in production.');
const app = createApp(db, { secureCookies: secure, sessionSecret: process.env.SESSION_SECRET });
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on http://localhost:${port}`));
