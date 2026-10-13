# Agent Accountability Tracker

Agents log daily activity (doors knocked, contacts, calls, conversations, leads) and see weekly progress against goals set by admins.

## Run locally

```
npm install
npm start          # http://localhost:3000
npm test
```

With no `DATABASE_URL`, an embedded Postgres (PGlite) stores data in `data/pgdata`, so no setup is needed.
On first start an admin is created: set `ADMIN_EMAIL` / `ADMIN_PASSWORD`, or `admin@example.com` is used with a random password printed once to the console.
To test against a real Postgres: `DATABASE_URL=postgres://... npm test`.

## Deploy on Vercel

1. In the Vercel project, add a Postgres database (Storage / Marketplace, e.g. Neon). This sets `DATABASE_URL` automatically.
2. Add environment variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (creates the first admin on first request), and `SESSION_SECRET` (any long random string).
3. Redeploy. Tables are created automatically.

| Env var | Purpose |
|---|---|
| `DATABASE_URL` / `POSTGRES_URL` | Postgres connection string (required on Vercel) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin account, created only if no admin exists |
| `SESSION_SECRET` | Required in production |
| `PORT` | Port when run as a server (default 3000) |
| `NODE_ENV=production` | Enables `Secure` cookies (HTTPS only; Vercel sets this) |

## Roles

- **Agent** – logs stats for any date up to today (re-saving a date overwrites it), views a weekly dashboard (Mon–Sun) with progress bars vs. goals and a daily breakdown, flags missing days.
- **Admin** – team overview per week (click an agent for detail), set weekly goals per agent or for everyone at once, add agents, reset passwords, deactivate/reactivate.

Goals are weekly targets that apply to every week.
