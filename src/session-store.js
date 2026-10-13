const session = require('express-session');

// Postgres-backed session store so logins survive restarts and work across serverless instances.
class DbStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    setInterval(() => db.query('DELETE FROM sessions WHERE expires <= $1', [Date.now()]).catch(() => {}), 3600e3).unref();
  }
  expiry(sess) {
    return sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
  }
  get(sid, cb) {
    this.db.query('SELECT data FROM sessions WHERE sid = $1 AND expires > $2', [sid, Date.now()])
      .then((r) => cb(null, r[0] ? JSON.parse(r[0].data) : null), cb);
  }
  set(sid, sess, cb) {
    this.db.query(
      'INSERT INTO sessions (sid, data, expires) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data, expires = EXCLUDED.expires',
      [sid, JSON.stringify(sess), this.expiry(sess)]
    ).then(() => cb && cb(), (e) => cb && cb(e));
  }
  destroy(sid, cb) {
    this.db.query('DELETE FROM sessions WHERE sid = $1', [sid]).then(() => cb && cb(), (e) => cb && cb(e));
  }
}

module.exports = DbStore;
