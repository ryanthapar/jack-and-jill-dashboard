const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { METRICS, zero, EmailTakenError } = require('./store');
const { isDate, addDays, weekStart, weekDays, todayUTC } = require('./dates');

const MAX_VALUE = 100000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// express-session adapter over the app store.
class StoreSessions extends session.Store {
  constructor(store) { super(); this.s = store; }
  get(sid, cb) { this.s.getSession(sid).then((d) => cb(null, d), cb); }
  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
    this.s.setSession(sid, sess, expires).then(() => cb && cb(), (e) => cb && cb(e));
  }
  destroy(sid, cb) { this.s.deleteSession(sid).then(() => cb && cb(), (e) => cb && cb(e)); }
}

function parseCounts(body) {
  const out = {};
  for (const m of METRICS) {
    const v = body[m];
    if (!Number.isInteger(v) || v < 0 || v > MAX_VALUE) return { error: `${m} must be a whole number between 0 and ${MAX_VALUE}` };
    out[m] = v;
  }
  return { values: out };
}

function createApp(store, { secureCookies = false, sessionSecret } = {}) {
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
      store: new StoreSessions(store),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 7 * 864e5 },
    })
  );

  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
  const userById = (id) => (typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? store.getUser(id) : undefined);

  // Weekly reports for several users, with batched reads.
  async function weekReports(userIds, start) {
    const days = weekDays(start);
    const [stats, goals] = await Promise.all([store.getWeekStats(userIds, start), store.getGoals(userIds)]);
    return Object.fromEntries(userIds.map((id) => {
      const mine = stats[id] || {};
      const totals = zero();
      const daily = days.map((date) => {
        const r = mine[date];
        if (r) for (const m of METRICS) totals[m] += r[m];
        return { date, entered: !!r, ...(r || zero()) };
      });
      return [id, { weekStart: days[0], weekEnd: days[6], daily, totals, goals: goals[id] || zero(), daysEntered: Object.keys(mine).length }];
    }));
  }
  const weekReport = async (id, start) => (await weekReports([id], start))[id];

  // Today's and this month's progress. Goals are stored weekly, so the daily goal is a seventh of
  // the weekly one and the monthly goal scales by the month's length in weeks.
  async function periodReports(userIds) {
    const today = todayUTC();
    const [y, m] = today.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthStart = `${today.slice(0, 8)}01`;
    const monthEnd = addDays(monthStart, daysInMonth - 1);
    const weeks = [];
    for (let w = weekStart(monthStart); w <= monthEnd; w = addDays(w, 7)) weeks.push(w);
    const [weekStats, goals] = await Promise.all([Promise.all(weeks.map((w) => store.getWeekStats(userIds, w))), store.getGoals(userIds)]);
    return Object.fromEntries(userIds.map((id) => {
      const day = zero();
      const month = zero();
      for (const ws of weekStats) {
        for (const [date, r] of Object.entries(ws[id] || {})) {
          if (date === today) for (const k of METRICS) day[k] += r[k];
          if (date >= monthStart && date <= monthEnd) for (const k of METRICS) month[k] += r[k];
        }
      }
      const g = goals[id] || zero();
      const scale = (f) => Object.fromEntries(METRICS.map((k) => [k, Math.ceil(g[k] * f)]));
      return [id, { today, monthStart, monthEnd, day: { totals: day, goals: scale(1 / 7) }, month: { totals: month, goals: scale(daysInMonth / 7) } }];
    }));
  }

  function resolveWeek(req) {
    const s = req.query.week;
    return weekStart(isDate(s) ? s : todayUTC());
  }

  // ---- auth ----
  const MAX_ATTEMPTS = 10;
  const WINDOW_MS = 15 * 60e3;

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
    if ((await store.failCount(key)) >= MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const u = await store.getUserByEmail(email);
    const ok = u && u.active && bcrypt.compareSync(password, u.password_hash);
    if (!ok) {
      await store.recordFail(key, WINDOW_MS);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    await store.clearFails(key);
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
    await store.updateUser(req.user.id, { password_hash: bcrypt.hashSync(newPw, 10) });
    res.json({ ok: true });
  });

  // ---- agent: daily stats + weekly dashboard ----
  app.put('/api/stats', requireAuth, async (req, res) => {
    const { date } = req.body || {};
    if (!isDate(date)) return res.status(400).json({ error: 'Invalid date' });
    if (date > addDays(todayUTC(), 1)) return res.status(400).json({ error: 'Date cannot be in the future' });
    const { values, error } = parseCounts(req.body);
    if (error) return res.status(400).json({ error });
    await store.upsertStat(req.user.id, date, values);
    res.json({ ok: true });
  });

  app.get('/api/dashboard', requireAuth, async (req, res) => {
    const [report, periods] = await Promise.all([weekReport(req.user.id, resolveWeek(req)), periodReports([req.user.id])]);
    res.json({ ...report, periods: periods[req.user.id] });
  });

  // ---- admin ----
  app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
    const start = resolveWeek(req);
    const agents = await store.listAgents();
    const ids = agents.map((a) => a.id);
    const [reports, periods] = await Promise.all([weekReports(ids, start), periodReports(ids)]);
    const team = { week: { totals: zero(), goals: zero() }, day: { totals: zero(), goals: zero() }, month: { totals: zero(), goals: zero() } };
    for (const a of agents.filter((x) => x.active)) {
      const parts = { week: reports[a.id], day: periods[a.id].day, month: periods[a.id].month };
      for (const [p, src] of Object.entries(parts)) for (const k of METRICS) { team[p].totals[k] += src.totals[k]; team[p].goals[k] += src.goals[k]; }
    }
    res.json({
      weekStart: start, weekEnd: addDays(start, 6), team: { ...team, today: todayUTC(), monthStart: periods[ids[0]]?.monthStart },
      agents: agents.map((a) => ({ id: a.id, name: a.name, email: a.email, active: a.active, ...reports[a.id] })),
    });
  });

  app.get('/api/admin/agents/:id/dashboard', requireAuth, requireAdmin, async (req, res) => {
    const u = await userById(req.params.id);
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    const [report, periods] = await Promise.all([weekReport(u.id, resolveWeek(req)), periodReports([u.id])]);
    res.json({ agent: publicUser(u), ...report, periods: periods[u.id] });
  });

  app.post('/api/admin/agents', requireAuth, requireAdmin, async (req, res) => {
    const { name, email, password } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Name required' });
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'Valid email required' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    try {
      const id = await store.createUser({ name: name.trim(), email, password_hash: bcrypt.hashSync(password, 10), role: 'agent' });
      res.status(201).json({ id });
    } catch (e) {
      if (e instanceof EmailTakenError) return res.status(409).json({ error: 'That email is already in use' });
      throw e;
    }
  });

  app.patch('/api/admin/agents/:id', requireAuth, requireAdmin, async (req, res) => {
    const u = await userById(req.params.id);
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    const { active, password } = req.body || {};
    if (active !== undefined && typeof active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const fields = {};
    if (active !== undefined) fields.active = active;
    if (password !== undefined) fields.password_hash = bcrypt.hashSync(password, 10);
    if (Object.keys(fields).length) await store.updateUser(u.id, fields);
    res.json({ ok: true });
  });

  // Set weekly goals for one agent, or for every agent when :id is "all".
  app.put('/api/admin/goals/:id', requireAuth, requireAdmin, async (req, res) => {
    const { values, error } = parseCounts(req.body || {});
    if (error) return res.status(400).json({ error });
    if (req.params.id === 'all') {
      await store.setGoalsForAllAgents(values);
      return res.json({ ok: true });
    }
    const u = await userById(req.params.id);
    if (!u || u.role !== 'agent') return res.status(404).json({ error: 'Agent not found' });
    await store.setGoals(u.id, values);
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Server error', reason: String(err && err.message).replace(/\s+/g, ' ').slice(0, 300) });
  });
  return app;
}

module.exports = { createApp };
