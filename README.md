# Agent Accountability Tracker

Agents log daily activity (doors knocked, contacts, calls, conversations, leads) and see weekly progress against goals set by admins.

## Run locally

```
npm install
npm start          # http://localhost:3000
npm test
```

With no Firebase settings the app uses an in-memory store, so data is lost when it restarts. That is fine for trying it out.
On first start an admin is created: set `ADMIN_EMAIL` / `ADMIN_PASSWORD`, or `admin@example.com` is used with a random password printed once to the console.

To keep data locally, run the Firestore emulator and set `FIRESTORE_EMULATOR_HOST=localhost:8080`.
`STORE=firestore-fake npm test` runs the test suite through the Firestore code on an in-memory fake;
with `FIRESTORE_EMULATOR_HOST` set it runs against the real emulator.

## Deploy on Vercel (Firestore)

1. Create a Firebase project and a Firestore database (production mode, so client access is denied — only this server reads/writes).
2. Firebase console → Project settings → Service accounts → Generate new private key. This downloads a JSON file.
3. In Vercel → Settings → Environment Variables, add:
   - `FIREBASE_SERVICE_ACCOUNT` — the entire contents of that JSON file
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — creates the first admin on the first request
   - `SESSION_SECRET` — any long random string
4. Redeploy.

| Env var | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Service-account key JSON (required in production) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin account, created only if no admin exists |
| `SESSION_SECRET` | Required in production |
| `FIRESTORE_EMULATOR_HOST` | Use a local Firestore emulator |
| `PORT` | Port when run as a server (default 3000) |
| `NODE_ENV=production` | Enables `Secure` cookies (HTTPS only; Vercel sets this) |

Collections (all prefixed `tracker_`, or `FIRESTORE_PREFIX`, so the app can share a Firebase project): `users`, `emails` (enforces unique emails), `goals`, `stats` (one doc per agent per day), `sessions`, `login_attempts`.
A separate Firebase project is still recommended.
No composite indexes are needed.

## Roles

- **Agent** – logs stats for any date up to today (re-saving a date overwrites it), views a weekly dashboard (Mon–Sun) with progress bars vs. goals and a daily breakdown, flags missing days.
- **Admin** – team overview per week (click an agent for detail), set weekly goals per agent or for everyone at once, add agents, reset passwords, deactivate/reactivate.

Goals are weekly targets that apply to every week.
