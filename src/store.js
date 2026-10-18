const crypto = require('crypto');
const { weekDays } = require('./dates');

const METRICS = ['doors', 'contacts', 'calls', 'conversations', 'leads'];
const zero = () => Object.fromEntries(METRICS.map((m) => [m, 0]));
const pickCounts = (o) => Object.fromEntries(METRICS.map((m) => [m, o[m]]));
const lower = (s) => s.trim().toLowerCase();
const keyId = (key) => crypto.createHash('sha256').update(key).digest('hex'); // doc ids can't contain "/"
const statId = (userId, date) => `${userId}_${date}`;
const byName = (a, b) => (b.active - a.active) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

class EmailTakenError extends Error {}

// ---------------------------------------------------------------------------
// Both stores expose the same async interface; the app never touches Firestore directly.
//   users:    getUser(id) getUserByEmail(email) createUser(u) updateUser(id, fields) listAgents() hasAdmin()
//   goals:    getGoals(ids) -> {id: counts} setGoals(id, counts) setGoalsForAllAgents(counts)
//   stats:    upsertStat(userId, date, counts) getWeekStats(userIds, weekStart) -> {userId: {date: counts}}
//   sessions: getSession(sid) setSession(sid, data, expires) deleteSession(sid)
//   throttle: failCount(key) recordFail(key, windowMs) clearFails(key)
// ---------------------------------------------------------------------------

class FirestoreStore {
  // Collections are namespaced so this app can share a Firebase project with other apps.
  constructor(firestore, prefix = 'tracker_') { this.db = firestore; this.prefix = prefix; }
  col(name) { return this.db.collection(this.prefix + name); }
  user(doc) { return doc.exists ? { id: doc.id, ...doc.data() } : undefined; }

  async getUser(id) { return this.user(await this.col('users').doc(String(id)).get()); }
  async getUserByEmail(email) {
    const e = await this.col('emails').doc(lower(email)).get();
    return e.exists ? this.getUser(e.data().userId) : undefined;
  }
  // The emails/{address} doc enforces uniqueness inside a transaction.
  async createUser({ name, email, password_hash, role }) {
    const ref = this.col('users').doc();
    const emailRef = this.col('emails').doc(lower(email));
    await this.db.runTransaction(async (t) => {
      if ((await t.get(emailRef)).exists) throw new EmailTakenError();
      t.set(emailRef, { userId: ref.id });
      t.set(ref, { name, email: email.trim(), password_hash, role, active: true, created_at: new Date().toISOString() });
      if (role === 'agent') t.set(this.col('goals').doc(ref.id), zero());
    });
    return ref.id;
  }
  async updateUser(id, fields) { await this.col('users').doc(String(id)).update(fields); }
  async listAgents() {
    const snap = await this.col('users').where('role', '==', 'agent').get();
    return snap.docs.map((d) => this.user(d)).sort(byName);
  }
  async hasAdmin() { return !(await this.col('users').where('role', '==', 'admin').limit(1).get()).empty; }

  async getGoals(ids) {
    if (!ids.length) return {};
    const docs = await this.db.getAll(...ids.map((id) => this.col('goals').doc(String(id))));
    return Object.fromEntries(docs.filter((d) => d.exists).map((d) => [d.id, pickCounts(d.data())]));
  }
  async setGoals(id, counts) { await this.col('goals').doc(String(id)).set(pickCounts(counts)); }
  async setGoalsForAllAgents(counts) {
    const agents = await this.listAgents();
    for (let i = 0; i < agents.length; i += 400) { // batches are capped at 500 writes
      const batch = this.db.batch();
      for (const a of agents.slice(i, i + 400)) batch.set(this.col('goals').doc(a.id), pickCounts(counts));
      await batch.commit();
    }
  }

  async upsertStat(userId, date, counts) {
    await this.col('stats').doc(statId(userId, date)).set({ user_id: String(userId), date, ...pickCounts(counts), updated_at: new Date().toISOString() });
  }
  // Direct doc lookups (user x 7 days) — no queries, so no composite index is needed.
  async getWeekStats(userIds, weekStart) {
    const days = weekDays(weekStart);
    const out = Object.fromEntries(userIds.map((id) => [id, {}]));
    if (!userIds.length) return out;
    const refs = userIds.flatMap((id) => days.map((d) => this.col('stats').doc(statId(id, d))));
    for (const d of await this.db.getAll(...refs)) if (d.exists) out[d.data().user_id][d.data().date] = pickCounts(d.data());
    return out;
  }

  async getSession(sid) {
    const d = await this.col('sessions').doc(keyId(sid)).get();
    return d.exists && d.data().expires > Date.now() ? JSON.parse(d.data().data) : null;
  }
  async setSession(sid, data, expires) { await this.col('sessions').doc(keyId(sid)).set({ data: JSON.stringify(data), expires }); }
  async deleteSession(sid) { await this.col('sessions').doc(keyId(sid)).delete(); }

  async failCount(key) {
    const d = await this.col('login_attempts').doc(keyId(key)).get();
    return d.exists && d.data().reset > Date.now() ? d.data().n : 0;
  }
  async recordFail(key, windowMs) {
    const ref = this.col('login_attempts').doc(keyId(key));
    await this.db.runTransaction(async (t) => {
      const d = await t.get(ref);
      const live = d.exists && d.data().reset > Date.now();
      t.set(ref, { n: live ? d.data().n + 1 : 1, reset: live ? d.data().reset : Date.now() + windowMs });
    });
  }
  async clearFails(key) { await this.col('login_attempts').doc(keyId(key)).delete(); }
}

// In-memory store for local development without credentials, and for tests. Data is lost on restart.
class MemoryStore {
  constructor() { this.users = new Map(); this.emails = new Map(); this.goals = new Map(); this.stats = new Map(); this.sessions = new Map(); this.fails = new Map(); this.seq = 0; }

  async getUser(id) { const u = this.users.get(String(id)); return u && { ...u }; }
  async getUserByEmail(email) { const id = this.emails.get(lower(email)); return id ? this.getUser(id) : undefined; }
  async createUser({ name, email, password_hash, role }) {
    if (this.emails.has(lower(email))) throw new EmailTakenError();
    const id = String(++this.seq);
    this.emails.set(lower(email), id);
    this.users.set(id, { id, name, email: email.trim(), password_hash, role, active: true, created_at: new Date().toISOString() });
    if (role === 'agent') this.goals.set(id, zero());
    return id;
  }
  async updateUser(id, fields) { Object.assign(this.users.get(String(id)), fields); }
  async listAgents() { return [...this.users.values()].filter((u) => u.role === 'agent').map((u) => ({ ...u })).sort(byName); }
  async hasAdmin() { return [...this.users.values()].some((u) => u.role === 'admin'); }

  async getGoals(ids) { return Object.fromEntries(ids.filter((id) => this.goals.has(String(id))).map((id) => [id, { ...this.goals.get(String(id)) }])); }
  async setGoals(id, counts) { this.goals.set(String(id), pickCounts(counts)); }
  async setGoalsForAllAgents(counts) { for (const a of await this.listAgents()) this.goals.set(a.id, pickCounts(counts)); }

  async upsertStat(userId, date, counts) { this.stats.set(statId(userId, date), { ...pickCounts(counts) }); }
  async getWeekStats(userIds, weekStart) {
    const days = weekDays(weekStart);
    return Object.fromEntries(userIds.map((id) => [id, Object.fromEntries(days.filter((d) => this.stats.has(statId(id, d))).map((d) => [d, { ...this.stats.get(statId(id, d)) }]))]));
  }

  async getSession(sid) { const s = this.sessions.get(sid); return s && s.expires > Date.now() ? JSON.parse(s.data) : null; }
  async setSession(sid, data, expires) { this.sessions.set(sid, { data: JSON.stringify(data), expires }); }
  async deleteSession(sid) { this.sessions.delete(sid); }

  async failCount(key) { const f = this.fails.get(key); return f && f.reset > Date.now() ? f.n : 0; }
  async recordFail(key, windowMs) {
    const f = this.fails.get(key);
    this.fails.set(key, f && f.reset > Date.now() ? { n: f.n + 1, reset: f.reset } : { n: 1, reset: Date.now() + windowMs });
  }
  async clearFails(key) { this.fails.delete(key); }
}

// Make every store call fail fast instead of hanging forever if the database stops responding.
function withTimeout(store, ms) {
  return new Proxy(store, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function' || prop === 'constructor') return v;
      return (...args) => {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Database timed out after ${ms / 1000}s (${String(prop)})`)), ms);
        });
        return Promise.race([v.apply(target, args), timeout]).finally(() => clearTimeout(timer));
      };
    },
  });
}

// FIREBASE_SERVICE_ACCOUNT holds the service-account key JSON. With FIRESTORE_EMULATOR_HOST set,
// the client talks to the local emulator instead. With neither, fall back to the in-memory store.
function createStore(env = process.env) {
  if (env.FIREBASE_SERVICE_ACCOUNT || env.FIRESTORE_EMULATOR_HOST) {
    const { Firestore } = require('@google-cloud/firestore');
    // preferRest: plain HTTPS instead of long-lived gRPC channels, which go stale and hang on serverless hosts.
    let opts = { ignoreUndefinedProperties: true, preferRest: true };
    if (env.FIREBASE_SERVICE_ACCOUNT) {
      const key = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
      opts = { ...opts, projectId: key.project_id, credentials: { client_email: key.client_email, private_key: key.private_key } };
    } else {
      opts.projectId = env.GCLOUD_PROJECT || 'demo-tracker';
    }
    return withTimeout(new FirestoreStore(new Firestore(opts), env.FIRESTORE_PREFIX ?? 'tracker_'), Number(env.DB_TIMEOUT_MS) || 8000);
  }
  return new MemoryStore();
}

module.exports = { withTimeout, createStore, FirestoreStore, MemoryStore, EmailTakenError, METRICS, zero };
