# Deploying Monarch to Railway

The repo ships everything Railway needs: a multi-stage **`Dockerfile`** (Bun build →
self-contained nitro `node-server` bundle) and **`railway.json`** (Dockerfile builder,
`/login` healthcheck). Railway injects `PORT`; the server reads it and binds all
interfaces. The app connects to Postgres **as the RLS-restricted `monarch_app` role**,
never as the owner — see the two-URL model in `src/db/client.ts`.

## One-time setup

### 1. Create the project and database

1. Railway → **New Project → Deploy from GitHub repo** → `IMBSpectral/monarch_advisory`.
2. In the service **Settings → Source**, set the deploy branch to **`tanush`**.
   Railway auto-detects the `Dockerfile` and `railway.json`.
3. In the project, **New → Database → Add PostgreSQL**.

### 2. Initialise the database (run locally, once)

Railway Postgres starts with only the `postgres` owner role. Migration `0002` creates the
`monarch_app` application role; production must give it a password. From the Postgres
service's **Variables** tab, copy **`DATABASE_PUBLIC_URL`** (the `*.proxy.rlwy.net` one),
then from the repo root:

```sh
export ADMIN="<DATABASE_PUBLIC_URL>"                 # postgres owner, public proxy

DATABASE_ADMIN_URL="$ADMIN" bun run db:migrate        # tables + monarch_app role + RLS policies
psql "$ADMIN" -c "ALTER ROLE monarch_app WITH PASSWORD 'CHOOSE_A_STRONG_PASSWORD';"
DATABASE_ADMIN_URL="$ADMIN" bun run db:seed           # demo org, founder login, chart of accounts, sample vouchers
```

> The inline `DATABASE_ADMIN_URL=` prefix overrides the local `.env`, so nothing in your
> dev config is touched. Seeding is optional but needed for a usable demo — it creates the
> login below. Skip it for an empty tenant you'll register into via `/signup`.

### 3. Point the app at the restricted role

On the **app service → Variables**, add (use the **internal** host, not the proxy):

| Variable       | Value                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL` | `postgresql://monarch_app:CHOOSE_A_STRONG_PASSWORD@postgres.railway.internal:5432/railway` |
| `NODE_ENV`     | `production`                                                                               |

`PORT` is injected by Railway — do **not** set it. The app never needs `DATABASE_ADMIN_URL`;
leaving it unset is the point (an operator must act deliberately to bypass tenancy).

### 4. Deploy

Trigger a redeploy (or push to `tanush`). Once healthy, **Settings → Networking → Generate
Domain** to get the public URL.

**Demo login:** `founder@imblabs.example` / `monarch-demo-2026`

## Redeploys & migrations

- Pushing to `tanush` auto-redeploys the Docker image.
- New migrations: run `DATABASE_ADMIN_URL="$ADMIN" bun run db:migrate` locally against the
  same public URL **before** the deploy that depends on them. Migrations are intentionally
  kept out of the runtime image (it carries only `.output`, no `drizzle-kit`), so schema
  changes are always a deliberate operator step, never an implicit one at boot.
