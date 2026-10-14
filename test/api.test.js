const { test, before } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const http = require('node:http');
const { createStore, FirestoreStore } = require('../src/store');
const { FakeFirestore } = require('./fake-firestore');
const { createApp } = require('../src/create-app');

let base;
before(async () => {
  // STORE=firestore-fake runs the same suite through FirestoreStore on an in-memory fake;
  // with FIRESTORE_EMULATOR_HOST set it runs against the real emulator.
  const store = process.env.STORE === 'firestore-fake' ? new FirestoreStore(new FakeFirestore()) : createStore();
  const hash = bcrypt.hashSync('password123', 4);
  for (const [name, email, role] of [['Admin', 'admin@x.com', 'admin'], ['Ann Agent', 'ann@x.com', 'agent'], ['Bob Agent', 'bob@x.com', 'agent']]) {
    await store.createUser({ name, email, password_hash: hash, role });
  }
  const server = http.createServer(createApp(store)).listen(0);
  base = `http://localhost:${server.address().port}`;
  server.unref();
});

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const login = async (email) => { const c = client(); const r = await c('POST', '/api/login', { email, password: 'password123' }); assert.equal(r.status, 200); return c; };
const counts = (n) => ({ doors: n, contacts: n, calls: n, conversations: n, leads: n });
// Monday 2025-01-06 .. Sunday 2025-01-12
const WEEK = '2025-01-08';

test('requires login', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/dashboard')).status, 401);
  assert.equal((await c('POST', '/api/login', { email: 'ann@x.com', password: 'nope' })).status, 401);
});

test('agent logs stats, overwrites a day, sees weekly totals', async () => {
  const ann = await login('ann@x.com');
  assert.equal((await ann('PUT', '/api/stats', { date: '2025-01-06', ...counts(10) })).status, 200);
  assert.equal((await ann('PUT', '/api/stats', { date: '2025-01-07', ...counts(5) })).status, 200);
  assert.equal((await ann('PUT', '/api/stats', { date: '2025-01-07', ...counts(7) })).status, 200);
  assert.equal((await ann('PUT', '/api/stats', { date: '2025-01-13', ...counts(99) })).status, 200); // next week
  const { body } = await ann('GET', `/api/dashboard?week=${WEEK}`);
  assert.equal(body.weekStart, '2025-01-06');
  assert.equal(body.weekEnd, '2025-01-12');
  assert.equal(body.totals.doors, 17);
  assert.equal(body.daysEntered, 2);
  assert.equal(body.daily.length, 7);
});

test('rejects bad input', async () => {
  const ann = await login('ann@x.com');
  assert.equal((await ann('PUT', '/api/stats', { date: '2025-02-30', ...counts(1) })).status, 400);
  assert.equal((await ann('PUT', '/api/stats', { date: '2999-01-01', ...counts(1) })).status, 400);
  assert.equal((await ann('PUT', '/api/stats', { date: '2025-01-06', ...counts(-1) })).status, 400);
  assert.equal((await ann('PUT', '/api/stats', { date: '2025-01-06', ...counts(1.5) })).status, 400);
  assert.equal((await ann('PUT', '/api/stats', { date: '2025-01-06', doors: 1 })).status, 400);
});

test('agents cannot use admin endpoints or see others', async () => {
  const bob = await login('bob@x.com');
  assert.equal((await bob('GET', '/api/admin/overview')).status, 403);
  assert.equal((await bob('PUT', '/api/admin/goals/x', counts(1))).status, 403);
  assert.equal((await bob('GET', `/api/dashboard?week=${WEEK}`)).body.totals.doors, 0);
});

test('admin sets goals; agent sees them; overview shows team', async () => {
  const admin = await login('admin@x.com');
  const agents = (await admin('GET', '/api/admin/overview')).body.agents;
  const annId = agents.find((a) => a.name === 'Ann Agent').id;
  const bobId = agents.find((a) => a.name === 'Bob Agent').id;
  assert.equal((await admin('PUT', `/api/admin/goals/${annId}`, { doors: 100, contacts: 50, calls: 80, conversations: 20, leads: 5 })).status, 200);
  assert.equal((await admin('PUT', `/api/admin/goals/${bobId}`, counts(1))).status, 200);
  assert.equal((await admin('PUT', '/api/admin/goals/nope', counts(1))).status, 404);
  const ann = await login('ann@x.com');
  assert.equal((await ann('GET', `/api/dashboard?week=${WEEK}`)).body.goals.doors, 100);
  const ov = (await admin('GET', `/api/admin/overview?week=${WEEK}`)).body;
  assert.equal(ov.agents.length, 2);
  assert.equal(ov.agents.find((a) => a.name === 'Ann Agent').totals.doors, 17);
  assert.equal((await admin('PUT', '/api/admin/goals/all', counts(9))).status, 200);
  assert.equal((await ann('GET', `/api/dashboard?week=${WEEK}`)).body.goals.leads, 9);
});

test('admin manages agents; deactivated agent is locked out', async () => {
  const admin = await login('admin@x.com');
  assert.equal((await admin('POST', '/api/admin/agents', { name: 'Cy', email: 'cy@x.com', password: 'short' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/agents', { name: 'Cy', email: 'ann@x.com', password: 'password123' })).status, 409);
  assert.equal((await admin('POST', '/api/admin/agents', { name: 'Cy', email: 'cy@x.com', password: 'password123' })).status, 201);
  const cy = await login('cy@x.com');
  assert.equal((await cy('GET', '/api/me')).status, 200);
  const id = (await admin('GET', '/api/admin/overview')).body.agents.find((a) => a.email === 'cy@x.com').id;
  await admin('PATCH', `/api/admin/agents/${id}`, { active: false });
  assert.equal((await cy('GET', '/api/me')).status, 401);
  assert.equal((await client()('POST', '/api/login', { email: 'cy@x.com', password: 'password123' })).status, 401);
});

test('non-JSON writes are rejected (CSRF guard)', async () => {
  const ann = await login('ann@x.com');
  const res = await fetch(base + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(res.status, 415);
});
