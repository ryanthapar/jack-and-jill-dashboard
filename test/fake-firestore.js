// Minimal in-memory stand-in for the subset of the @google-cloud/firestore API that FirestoreStore uses.
let auto = 0;
class Doc {
  constructor(id, data) { this.id = id; this.exists = data !== undefined; this._d = data; }
  data() { return this.exists ? JSON.parse(JSON.stringify(this._d)) : undefined; }
}
class Ref {
  constructor(db, col, id) { this.db = db; this.col = col; this.id = id; }
  get tbl() { return (this.db.t[this.col] ||= new Map()); }
  async get() { return new Doc(this.id, this.tbl.get(this.id)); }
  async set(data) { this.tbl.set(this.id, JSON.parse(JSON.stringify(data))); }
  async update(f) { if (!this.tbl.has(this.id)) throw new Error('NOT_FOUND'); Object.assign(this.tbl.get(this.id), f); }
  async delete() { this.tbl.delete(this.id); }
}
class Query {
  constructor(db, col, filters = [], max = Infinity) { Object.assign(this, { db, col, filters, max }); }
  where(f, op, v) { if (op !== '==') throw new Error('fake supports == only'); return new Query(this.db, this.col, [...this.filters, [f, v]], this.max); }
  limit(n) { return new Query(this.db, this.col, this.filters, n); }
  async get() {
    const docs = [...(this.db.t[this.col] || new Map())].filter(([, d]) => this.filters.every(([f, v]) => d[f] === v)).slice(0, this.max).map(([id, d]) => new Doc(id, d));
    return { docs, empty: docs.length === 0 };
  }
}
class Col extends Query {
  doc(id) { return new Ref(this.db, this.col, id || `auto${++auto}`); }
}
class FakeFirestore {
  constructor() { this.t = {}; }
  collection(name) { return new Col(this, name); }
  async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); }
  batch() { const ops = []; return { set: (r, d) => ops.push([r, d]), commit: async () => { for (const [r, d] of ops) await r.set(d); } }; }
  async runTransaction(fn) {
    const writes = [];
    const t = { get: (r) => r.get(), set: (r, d) => writes.push([r, d]) };
    const out = await fn(t); // throw => nothing is written, like a rolled-back transaction
    for (const [r, d] of writes) await r.set(d);
    return out;
  }
}
module.exports = { FakeFirestore };
