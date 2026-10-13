const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { METRICS } = require('./db');
const DbStore = require('./session-store');
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
      store: new DbStore(db),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 7 * 864e5 },
    })
  );

  const cols = METRICS.join(', ');
  const vals = (from) => METRICS.map((_, i) => '$' + (i + from)).join(', ');
  const setExcluded = METRICS.map((m) => `${m} = EXCLUDED.${m}`).join(', ');
  const one = async (sql, params) => (await db.query(sql, params))[0];
  const userByEmail = (email) => one('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  const userById = (id) => (Number.isInteger(id) ? one('SELECT * FROM users WHERE id = $1', [id]) : undefined);
  const upsertGoals = (query, userId, v) =>
    query(`INSERT INTO goals (user_id, ${cols}) VALUES ($1, ${vals(2)}) ON CONFLICT (user_id) DO UPDATE SET ${setExcluded}`, [userId, ...METRICS.map((m) => v[m])]);
  const zero = () => Object.fromEntries(METRICS.map((m) => [m, 0]));
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

  // Weekly reports for several users with two queries total.
  async function weekReports(userIds, start) {
    const days = weekDays(start);
    const [stats, goals] = await Promise.all([
      db.query(`SELECT user_id, date, ${cols} FROM stats WHERE user_id = ANY($1) AND date BETWEEN $2 AND $3`, [userIds, days[0], days[6]]),
      db.query(`SELECT user_id, ${cols} FROM goals WHERE user_id = ANY($1)`, [userIds]),
    ]);
    return Object.fromEntries(userIds.map((id) => {
      const byDate = Object.fromEntries(stats.filter((r) => r.user_id === id).map((r) => [r.date, r]));
      const totals = zero();
      const daily = days.map((date) => {
        const r = byDate[date];
        if (r) for (const m of METRICS) totals[m] += r[m];
        return { date, entered: !!r, ...(r ? Object.fromEntries(METRICS.map((m) => [m, r[m]])) : zero()) };
      });
      const g = goals.find((r) => r.user_id === id);
      return [id, {
        weekStart: days[0], weekEnd: days[6], daily, totals,
        goals: g ? Object.fromEntries(METRICS.map((m) => [m, g[m]])) : zero(),
        daysEntered: Object.keys(byDate).length,
      }];
    }));
  }
  const weekReport = async (id, start) => (await weekReports([id], start))[id];

  function resolveWeek(req) {
    const s = req.query.week;
    return weekStart(isDate(s) ? s : todayUTC());
  }

  // ---- auth ----
  const MAX_ATTEMPTS = 10;
  async function throttled(key) {
    const a = await one('SELECT n FROM login_attempts WHERE key = $1 AND reset > $2', [key, Date.now()]);
    return !!a && a.n >= MAX_ATTEMPTS;
  }
  const recordFail = (key) =>
    db.query(
      `INSERT INTO login_attempts (key, n, reset) VALUES ($1, 1, $2)
       ON CONFLICT (key) DO UPDATE SET n = CASE WHEN login_attempts.reset > $3 THEN login_attempts.n + 1 ELSE 1 END,
                                       reset = CASE WHEN login_attempts.reset > $3 THEN login_attempts.reset ELSE $2 END`,
      [key, Date.now() + 15 * 60e3, Date.now()]
    );

  const requireAuth = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
    const u = await userById(req.session.userId);
    if (!u || !u.active) return req.session.destroy(() => res.status(401).json({ error: 'Not signed in' }));
    req.user = u;
    next();
  };
  const requireAdmin = (req, res, next) =>
    req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

  app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Email and password required' });
    const key = `${req.ip}|${email.trim().toLowerCase()}`;
    if (await throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = await userByEmail(email.trim());
    const ok = u && u.active && bcrypt.compareSync(password, u.password_hash);
    if (!ok) {
      await recordFail(key);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    await db.query('DELETE FROM login_attempts WHERE key = $1', [key]);
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      req.session.userId = u.id;
      res.json({ user: publicUser(u) });
    });
  });

  app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); }));

  app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user), today: todayUTC() }));

  app.post('/api/me/password', requireAuth, async (req, res) => {
    const { current, next: newPw } = req.body || {};
    if (typeof newPw !== 'string' || newPw.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    if (typeof current !== 'string' || !bcrypt.compareSync(current, req.user.password_hash)) return res.status(403).json({ error: 'Current password is incorrect' });
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(newPw, 10), req.user.id]);
    res.json({ ok: true });
  });

  // ---- agent: daily stats + weekly dashboard ----
  app.put('/api/stats', requireAuth, async (req, res) => {
    const { date } = req.body || {};
    if (!isDate(date)) return res.status(400).json({ error: 'Invalid date' });
    if (date > addDays(todayUTC(), 1)) return res.status(400).json({ error: 'Date cannot be in the future' });
    const { values, error } = parseCounts(req.body);
    if (error) return res.status(400).json({ error });
    await db.query(
      `INSERT INTO stats (user_id, date, ${cols}) VALUES ($1, $2, ${vals(3)})
       ON CONFLICT (user_id, date) DO UPDATE SET ${setExcluded}, updated_at = now()`,
      [req.user.id, date, ...METRICS.map((m) => values[m])]
    );
    res.json({ ok: true });
  });

  app.get('/api/dashboard', requireAuth, async (req, res) => res.json(await weekReport(req.user.id, resolveWeek(req))));

  // ---- admin ----
  app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
    const start = resolveWeek(req);
    const agents = await db.query("SELECT id, name, email, active FROM users WHERE role = 'agent' ORDER BY active DESC, lower(name)");
    const reports = await weekReports(agents.map((a) => a.id), start);
    res.json({ weekStart: start, weekEnd: addDays(start, 6), agents: agents.map((a) => ({ ...a, ...reports[a.id] })) });
  });

  app.get('/api/admin/agents/:id/dashboard', requireAuth, requireAdmin, async (req, res) => {
    const u = await userById(Number(req.params.id));
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    res.json({ agent: publicUser(u), ...(await weekReport(u.id, resolveWeek(req))) });
  });

  app.post('/api/admin/agents', requireAuth, requireAdmin, async (req, res) => {
    const { name, email, password } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Name required' });
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'Valid email required' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (await userByEmail(email.trim())) return res.status(409).json({ error: 'That email is already in use' });
    const id = await db.tx(async (query) => {
      const [row] = await query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'agent') RETURNING id", [name.trim(), email.trim(), bcrypt.hashSync(password, 10)]);
      await upsertGoals(query, row.id, zero());
      return row.id;
    });
    res.status(201).json({ id });
  });

  app.patch('/api/admin/agents/:id', requireAuth, requireAdmin, async (req, res) => {
    const u = await userById(Number(req.params.id));
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    const { active, password } = req.body || {};
    if (active !== undefined && typeof active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (active !== undefined) await db.query('UPDATE users SET active = $1 WHERE id = $2', [active, u.id]);
    if (password !== undefined) await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(password, 10), u.id]);
    res.json({ ok: true });
  });

  // Set weekly goals for one agent, or for every agent when :id is "all".
  app.put('/api/admin/goals/:id', requireAuth, requireAdmin, async (req, res) => {
    const { values, error } = parseCounts(req.body || {});
    if (error) return res.status(400).json({ error });
    if (req.params.id === 'all') {
      await db.query(
        `INSERT INTO goals (user_id, ${cols}) SELECT id, ${METRICS.map((_, i) => `$${i + 1}::int`).join(", ")} FROM users WHERE role = 'agent' ON CONFLICT (user_id) DO UPDATE SET ${setExcluded}`,
        METRICS.map((m) => values[m])
      );
      return res.json({ ok: true });
    }
    const u = await userById(Number(req.params.id));
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    await upsertGoals(db.query, u.id, values);
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
