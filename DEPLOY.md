# Deploying to Render

The Medusa backend (`apps/backend`) runs as one Render web service in Singapore, with Render Postgres and Render Key Value on the private network.

| Resource | Render name | Plan |
| --- | --- | --- |
| Web service | `luxury-medusa` | Free (512 MB, sleeps after 15 min idle) |
| Postgres 17 | `luxury-medusa-db` | Free (expires 2026-11-27, deleted 14 days later unless upgraded) |
| Key Value | `luxury-medusa-redis` | Free (25 MB, no persistence, `noeviction`) |

## Service settings

Leave Root Directory empty. The monorepo root holds the only lockfile.

- Build command:
  `npm ci --include=dev && NODE_OPTIONS=--max-old-space-size=4096 npm run build --workspace=apps/backend -- --no-lint`
- Start command:
  `export NODE_OPTIONS=--max-old-space-size=384 && cd apps/backend/.medusa/server && npm run predeploy && exec ../../../../node_modules/.bin/medusa start`
- Health check path: `/health`

Free instances have no pre-deploy command, so migrations (`predeploy` = `medusa db:migrate --execute-safe-links`) run at every boot. On a paid plan, move `cd apps/backend/.medusa/server && npm run predeploy` into the Pre-Deploy Command, drop it from the start command, and raise `--max-old-space-size` to about 75% of the instance RAM.

`--include=dev` is required because `NODE_ENV=production` makes npm skip dev dependencies, and `medusa build` needs `ts-node`. There is no second `npm install` inside `.medusa/server`; it resolves packages from the root `node_modules`.

## Environment variables

| Key | Value |
| --- | --- |
| `NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Postgres internal connection string, with no `sslmode` parameter |
| `REDIS_URL` | Key Value internal connection string |
| `MEDUSA_WORKER_MODE` | `shared` |
| `JWT_SECRET`, `COOKIE_SECRET` | random, `openssl rand -base64 32` |
| `AUTH_MFA_ENCRYPTION_KEY` | random. Never change it after admins enroll MFA. |
| `MEDUSA_BACKEND_URL` | `https://<service>.onrender.com`. Baked into the admin at build time: after changing it, use "Save, rebuild, and deploy". |
| `ADMIN_CORS` | `https://<service>.onrender.com` |
| `STORE_CORS` | storefront origin(s), e.g. `https://your-store.vercel.app` |
| `AUTH_CORS` | admin origin plus storefront origin(s) |

CORS lists are comma-separated with no spaces and no trailing slashes.

## Admin user

Free instances have no Shell. Create admins from your machine against the external database URL:

1. In the Render dashboard, add your IP to the Postgres "Access Control" list.
2. Run:
   ```bash
   cd apps/backend/.medusa/server   # after `npm run build --workspace=apps/backend`
   DATABASE_URL='<external connection string>' REDIS_URL= NODE_ENV=production \
     JWT_SECRET=x COOKIE_SECRET=x ../../../../node_modules/.bin/medusa user -e you@example.com --invite
   ```
3. Open `https://<service>.onrender.com/app/invite?token=<token>` and set a password.
4. Remove your IP from the access list.

## Known limits

- Product images: without `S3_*` variables, uploads go to local disk and disappear on every deploy, restart, or spin-down. Configure S3-compatible storage (Cloudflare R2, Supabase Storage, AWS S3) with the variables in `apps/backend/.env.template`.
- 512 MB is below Medusa's documented 2 GB minimum. If the service restarts with out-of-memory errors, move to a 2 GB plan.
- Postgres TLS is configured in `medusa-config.ts` (`DATABASE_SSL`, `DATABASE_CA_CERT`), never with `?sslmode=` in `DATABASE_URL`.

## Storefront

Not installed. To add one, copy `apps/storefront` from [medusajs/dtc-starter](https://github.com/medusajs/dtc-starter) and deploy it to Vercel with Root Directory `apps/storefront` and:

- `NEXT_PUBLIC_MEDUSA_BACKEND_URL` = the Render URL
- `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` = the "Default Publishable API Key" from Admin > Settings > Publishable API Keys
- `NEXT_PUBLIC_DEFAULT_REGION` = a country code in one of your regions

Then add the Vercel URL to `STORE_CORS` and `AUTH_CORS` on Render.
