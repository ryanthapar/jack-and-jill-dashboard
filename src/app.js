const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { METRICS } = require('./db');
const SqliteStore = require('./session-store');
const { isDate, addDays, weekStart, weekDays, todayUTC } = require('./dates');

const MAX_VALUE = 100000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCounts(body) {
  const out = {};
  for (const m of METRICS) {
    const v = body[m];
    if (!Number.isInteger(v) || v < 0 || v > MAX_VALUE) return { error: `${m} must be a whole number between 0 and ${MAX_VALUE}` };
    out[m] = v;
  }
  return { values: out };
}

function createApp(db, { secureCookies = false, sessionSecret } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    // CSRF: state-changing requests must be JSON (cross-site forms can't send that without CORS preflight).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'JSON required' });
    }
    next();
  });
  app.use(
    session({
      name: 'sid',
      secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
      store: new SqliteStore(db),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 7 * 864e5 },
    })
  );

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    upsertStat: db.prepare(`INSERT INTO stats (user_id, date, ${METRICS.join(',')}) VALUES (@user_id, @date, ${METRICS.map((m) => '@' + m).join(',')})
      ON CONFLICT(user_id, date) DO UPDATE SET ${METRICS.map((m) => `${m}=excluded.${m}`).join(',')}, updated_at=CURRENT_TIMESTAMP`),
    statsRange: db.prepare(`SELECT date, ${METRICS.join(',')} FROM stats WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date`),
    goals: db.prepare(`SELECT ${METRICS.join(',')} FROM goals WHERE user_id = ?`),
    upsertGoals: db.prepare(`INSERT INTO goals (user_id, ${METRICS.join(',')}) VALUES (@user_id, ${METRICS.map((m) => '@' + m).join(',')})
      ON CONFLICT(user_id) DO UPDATE SET ${METRICS.map((m) => `${m}=excluded.${m}`).join(',')}`),
    agents: db.prepare("SELECT id, name, email, active FROM users WHERE role = 'agent' ORDER BY active DESC, name COLLATE NOCASE"),
  };
  const zero = () => Object.fromEntries(METRICS.map((m) => [m, 0]));
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

  function weekReport(userId, start) {
    const days = weekDays(start);
    const rows = q.statsRange.all(userId, days[0], days[6]);
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    const totals = zero();
    const daily = days.map((date) => {
      const r = byDate[date];
      if (r) for (const m of METRICS) totals[m] += r[m];
      return { date, entered: !!r, ...(r ? Object.fromEntries(METRICS.map((m) => [m, r[m]])) : zero()) };
    });
    return { weekStart: days[0], weekEnd: days[6], daily, totals, goals: q.goals.get(userId) || zero(), daysEntered: rows.length };
  }

  function resolveWeek(req) {
    const s = req.query.week;
    return weekStart(isDate(s) ? s : todayUTC());
  }

  // ---- auth ----
  const attempts = new Map(); // key -> {n, reset}
  function throttled(key) {
    const now = Date.now();
    const a = attempts.get(key);
    if (!a || a.reset < now) return false;
    return a.n >= 10;
  }
  function recordFail(key) {
    const now = Date.now();
    const a = attempts.get(key);
    if (!a || a.reset < now) attempts.set(key, { n: 1, reset: now + 15 * 60e3 });
    else a.n++;
  }

  const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
    const u = q.userById.get(req.session.userId);
    if (!u || !u.active) return req.session.destroy(() => res.status(401).json({ error: 'Not signed in' }));
    req.user = u;
    next();
  };
  const requireAdmin = (req, res, next) =>
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

  app.post('/api/login', (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Email and password required' });
    const key = `${req.ip}|${email.toLowerCase()}`;
    if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = q.userByEmail.get(email.trim());
    const ok = u && u.active && bcrypt.compareSync(password, u.password_hash);
    if (!ok) {
      recordFail(key);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    attempts.delete(key);
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      req.session.userId = u.id;
      res.json({ user: publicUser(u) });
    });
  });

  app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); }));

  app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user), today: todayUTC() }));

  app.post('/api/me/password', requireAuth, (req, res) => {
    const { current, next: newPw } = req.body || {};
    if (typeof newPw !== 'string' || newPw.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    if (typeof current !== 'string' || !bcrypt.compareSync(current, req.user.password_hash)) return res.status(403).json({ error: 'Current password is incorrect' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPw, 10), req.user.id);
    res.json({ ok: true });
  });

  // ---- agent: daily stats + weekly dashboard ----
  app.put('/api/stats', requireAuth, (req, res) => {
    const { date } = req.body || {};
    if (!isDate(date)) return res.status(400).json({ error: 'Invalid date' });
    if (date > addDays(todayUTC(), 1)) return res.status(400).json({ error: 'Date cannot be in the future' });
    const { values, error } = parseCounts(req.body);
    if (error) return res.status(400).json({ error });
    q.upsertStat.run({ user_id: req.user.id, date, ...values });
    res.json({ ok: true });
  });

  app.get('/api/dashboard', requireAuth, (req, res) => res.json(weekReport(req.user.id, resolveWeek(req))));

  // ---- admin ----
  app.get('/api/admin/overview', requireAuth, requireAdmin, (req, res) => {
    const start = resolveWeek(req);
    const agents = q.agents.all().map((a) => ({ ...a, active: !!a.active, ...weekReport(a.id, start) }));
    res.json({ weekStart: start, weekEnd: addDays(start, 6), agents });
  });

  app.get('/api/admin/agents/:id/dashboard', requireAuth, requireAdmin, (req, res) => {
    const u = q.userById.get(Number(req.params.id));
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    res.json({ agent: publicUser(u), ...weekReport(u.id, resolveWeek(req)) });
  });

  app.post('/api/admin/agents', requireAuth, requireAdmin, (req, res) => {
    const { name, email, password } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Name required' });
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'Valid email required' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (q.userByEmail.get(email.trim())) return res.status(409).json({ error: 'That email is already in use' });
    const info = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'agent')")
      .run(name.trim(), email.trim(), bcrypt.hashSync(password, 10));
    q.upsertGoals.run({ user_id: info.lastInsertRowid, ...zero() });
    res.status(201).json({ id: info.lastInsertRowid });
  });

  app.patch('/api/admin/agents/:id', requireAuth, requireAdmin, (req, res) => {
    const u = q.userById.get(Number(req.params.id));
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    const { active, password } = req.body || {};
    if (active !== undefined) {
      if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, u.id);
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), u.id);
    }
    res.json({ ok: true });
  });

  // Set weekly goals for one agent, or for every agent when :id is "all".
  app.put('/api/admin/goals/:id', requireAuth, requireAdmin, (req, res) => {
    const { values, error } = parseCounts(req.body || {});
    if (error) return res.status(400).json({ error });
    if (req.params.id === 'all') {
      db.transaction(() => { for (const a of q.agents.all()) q.upsertGoals.run({ user_id: a.id, ...values }); })();
      return res.json({ ok: true });
    }
    const u = q.userById.get(Number(req.params.id));
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    q.upsertGoals.run({ user_id: u.id, ...values });
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });
  return app;
}

module.exports = { createApp };
