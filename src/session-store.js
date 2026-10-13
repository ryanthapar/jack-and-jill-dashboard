const session = require('express-session');

// Minimal SQLite-backed session store so logins survive restarts.
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.get_ = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.set_ = db.prepare(
      'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'
    );
    this.del_ = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.purge_ = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    setInterval(() => this.purge_.run(Date.now()), 3600 * 1000).unref();
  }
  expiry(sess) {
    return sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
  }
  get(sid, cb) {
    try {
      const row = this.get_.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.set_.run(sid, JSON.stringify(sess), this.expiry(sess)); cb && cb(); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.del_.run(sid); cb && cb(); } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;
