# Agent Accountability Tracker

Agents log daily activity (doors knocked, contacts, calls, conversations, leads) and see weekly progress against goals set by admins.

## Run

```
npm install
npm start          # http://localhost:3000
npm test
```

On first start an admin is created. Set `ADMIN_EMAIL` / `ADMIN_PASSWORD` to choose the credentials; otherwise
`admin@example.com` is used with a random password printed once to the console.

| Env var | Purpose |
|---|---|
| `PORT` | Port (default 3000) |
| `DB_PATH` | SQLite file (default `data/app.db`) |
| `SESSION_SECRET` | Required in production |
| `NODE_ENV=production` | Enables `Secure` cookies — serve over HTTPS |

## Roles

- **Agent** – logs stats for any date up to today (re-saving a date overwrites it), views a weekly dashboard (Mon–Sun) with progress bars vs. goals and a daily breakdown, flags missing days.
- **Admin** – team overview per week (click an agent for detail), set weekly goals per agent or for everyone at once, add agents, reset passwords, deactivate/reactivate.

Goals are weekly targets that apply to every week. Data is stored in SQLite, so the host needs a persistent disk.
