# Railway deployment test

This internal test profile runs the authenticated Go dashboard server with
Railway Redis. The image downloads and checksum-verifies the public
`githubnext/gh-aw-cao` dashboard snapshot at build time, then ingests that
immutable snapshot into Redis before accepting traffic.

The Railway edge does not publish a stable ingress proxy CIDR. The image
therefore terminates the platform hop in an in-container Caddy process and
forwards requests to the CAO server over loopback. The CAO server trusts only
that loopback boundary and continues to require HTTPS, an allowed host, GitHub
OAuth, server-side sessions, and explicit organization or team authorization.

## Create the Railway project

1. Create a Railway project from the `githubnext/gh-aw-cao` repository and
   select the branch or commit to test.
2. Add a Redis service to the same Railway environment.
3. On the dashboard service, set:

   ```text
   RAILWAY_DOCKERFILE_PATH=/server/internal/railway/Dockerfile
   DASHBOARD_MANIFEST_SHA256=REVIEWED_64_CHARACTER_SHA256
   REDIS_URL=${{Redis.REDIS_URL}}
   REDIS_NAMESPACE=railway-dashboard-test
   ```

   Replace `Redis` if the database service has another name. Keep Redis private;
   do not enable its public TCP proxy. Obtain `DASHBOARD_MANIFEST_SHA256` from
   the reviewed snapshot publication record or signed release provenance, not
   by hashing the mutable URL during the same build.
4. Generate a Railway domain for the dashboard service and keep one replica.
   Record the host without `https://`, for example
   `cao-dashboard-test.up.railway.app`.

The Docker build context must remain the repository root. Do not set the
service root directory to `server/`.

## Create a GitHub OAuth app

Create a separate GitHub OAuth app for the test deployment:

```text
Homepage URL: https://YOUR_RAILWAY_HOST
Authorization callback URL: https://YOUR_RAILWAY_HOST/auth/callback
```

## Configure dashboard variables

Set these sealed variables on the dashboard service:

```text
CAO_PUBLIC_HOST=YOUR_RAILWAY_HOST
CAO_GITHUB_CLIENT_ID=...
CAO_GITHUB_CLIENT_SECRET=...
CAO_SESSION_SECRET=...
CAO_GITHUB_ALLOWED_ORGS=YOUR_GITHUB_ORGANIZATION
CAO_GITHUB_ADMIN_USERS=YOUR_GITHUB_LOGIN
CAO_GITHUB_WEBHOOK_SECRET=...
```

`CAO_SESSION_SECRET` and `CAO_GITHUB_WEBHOOK_SECRET` must each contain at least
32 random characters. Authorization is fail-closed: configure at least one
allowed organization with `CAO_GITHUB_ALLOWED_ORGS`, or use
`CAO_GITHUB_ALLOWED_TEAMS` with `ORG/TEAM-SLUG` entries.

The image derives `CAO_ALLOWED_HOSTS`, `CAO_GITHUB_REDIRECT_URL`, and the
loopback-only trusted proxy policy from `CAO_PUBLIC_HOST`. It loads
`.github/workflows/cao.railway.json`, which extends the rollout policy in
`cao.json` only with `control-plane.web.host`.

## Configure deployment health

Set the Railway healthcheck path to `/api/readiness` and use a timeout of at
least 300 seconds for the first deployment. Startup verifies and ingests the
baked snapshot before the listener becomes ready.

After Railway reports the deployment healthy:

```bash
curl --fail --silent --show-error https://YOUR_RAILWAY_HOST/api/health
curl --fail --silent --show-error https://YOUR_RAILWAY_HOST/api/readiness
```

Open the dashboard, sign in through GitHub, and confirm both that an authorized
account can load Overview and that an account outside the configured
organization or teams is denied.

This profile uses a snapshot captured during the image build and bound to the
reviewed `DASHBOARD_MANIFEST_SHA256` trust anchor. Redeploy with a newly reviewed
digest to pick up newer public data. Override `DASHBOARD_DATA_URL` only with a
reviewed HTTPS manifest that publishes the complete inventory, SQLite snapshot,
and referenced JSONL shards; the build fails on missing payloads or checksum
mismatches.
