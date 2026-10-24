# Bug-report Worker

Private intake for the launcher's **Report a bug** form. The launcher zips logs and posts them to `POST /api/bug-report`. This Worker checks the upload, rate-limits it, stores it in a private R2 bucket, and posts a short note to Discord.

Nothing in this folder is deployed by the pull request. TJ runs the steps below when the Discord channel and the log folder name are confirmed.

## What it accepts

`POST /api/bug-report`, `multipart/form-data`:

| Field | Required | Rule |
| --- | --- | --- |
| `category` | yes | `crash`, `performance`, `gameplay`, or `other` |
| `description` | yes | 20–2000 characters after trim |
| `installId` | yes | 64-character lowercase SHA-256 hex (a hash of a random install id, not a Steam id) |
| `zip` | yes | ZIP file, magic bytes `PK\x03\x04`, at most 25 MB |
| `screenshot` | no | PNG or JPG, at most 8 MB |
| `launcherVersion`, `gameBuild`, `gpu` | no | Stored and shown in Discord, clipped to 200 characters |

Anything else is a 4xx. The body cap is 25 MB plus the 8 MB screenshot allowance plus 256 KB of multipart overhead. Over that, the response is **413**. Over the daily rate limit, the response is **429** with `Retry-After` (seconds until the next UTC day).

A valid report is stored at:

- `reports/<YYYY-MM-DD>/<id>.zip`
- `reports/<YYYY-MM-DD>/<id>.json` — category, game build, GPU, description, launcher version, createdAt, report id, and `hasScreenshot`. No IP and no install-id hash.
- `reports/<YYYY-MM-DD>/<id>.png` or `.jpg` when a screenshot was attached

Discord gets category, game build, GPU, launcher version, the first 200 characters of the description, and the report id. `@everyone` and `@here` are broken up, and the webhook is called with `allowed_mentions: { parse: [] }`. If Discord errors, the R2 objects stay and the player still gets a success response.

## Rate limits (KV, not a Durable Object)

Counters live in the `RATE` KV namespace:

- 5 accepted reports per install-id hash per UTC day
- 20 accepted reports per IP hash per UTC day

KV is a good fit here. Bug reports are rare, and the failure mode of KV's last-write-wins race is one extra report if two requests pass the check together. A Durable Object would serialize that, at the cost of a class, a migration, and a round trip for every report. That extra strictness does not change the outcome for this form.

The IP is never written to KV, R2, or the logs. The counter key is `ip:<sha256>:<YYYY-MM-DD>`. The hash input is a salt created for that UTC day (stored under `salt:<YYYY-MM-DD>`) plus the IP. The salt changes every day, so yesterday's hash cannot be matched to today's. Optional: `wrangler secret put RATE_LIMIT_SALT` mixes in a pepper that is not in KV, so a copy of the namespace alone cannot be matched back to an address. The Worker runs without that secret.

Invalid uploads are rejected before the counter moves, so a bad request does not use up someone's daily allowance.

## Retention (90 days)

Two mechanisms, on purpose:

1. **R2 lifecycle** (this is the one that still works if the cron is down). `r2-lifecycle.json` deletes objects under `reports/` 90 days after they were written (`maxAge` is 7,776,000 seconds). Apply it after the bucket exists (see below). Do **not** add an R2 bucket lock on `reports/`: a lock stops deletion, including lifecycle deletion.
2. **Cron** at 04:15 UTC. The scheduled handler deletes `reports/<date>/` prefixes that are 91 to 210 days old. It is what the tests exercise. It does not walk the whole bucket. Anything older than the 120-day lookback is left for the lifecycle rule.

The bucket has no public read. Do not turn on r2.dev and do not attach a public custom domain. Only this Worker, through the `BUGS` binding, should read the objects.

## Deploy (TJ, later)

From `bug-report-worker/`, with Wrangler 4 logged into the Sentient Solutions account (`npx wrangler@4 login`). Do not paste the webhook into the shell history; `secret put` prompts for it.

1. Create the private bucket:
   ```sh
   npx wrangler@4 r2 bucket create tgc-bug-reports
   ```
   Leave r2.dev and public access off.
2. Apply the 90-day lifecycle. Either:
   ```sh
   npx wrangler@4 r2 bucket lifecycle add tgc-bug-reports expire-bug-reports-90d reports/ --expire-days 90
   ```
   or, if you prefer the JSON file (same rule, age in seconds):
   ```sh
   npx wrangler@4 r2 bucket lifecycle set tgc-bug-reports --file r2-lifecycle.json
   ```
3. Create the KV namespace and paste the id into `wrangler.toml` (replace the all-zero `id` and `preview_id`):
   ```sh
   npx wrangler@4 kv namespace create RATE
   npx wrangler@4 kv namespace create RATE --preview
   ```
4. Set the Discord webhook. The value stays in the Worker secret store, not in git:
   ```sh
   npx wrangler@4 secret put DISCORD_WEBHOOK_URL
   ```
   Optional pepper for IP hashing:
   ```sh
   npx wrangler@4 secret put RATE_LIMIT_SALT
   ```
5. Deploy:
   ```sh
   npx wrangler@4 deploy
   ```
6. Copy the workers.dev URL into `launcher-app/config.js` as `BUG_REPORT_URL`, including the path:
   `https://tgc-bug-report.<account>.workers.dev/api/bug-report`

`wrangler secret put` publishes a new version. That is fine once the bindings above are real. This pull request does not run it.

Local tests do not need Wrangler or a Cloudflare login:

```sh
npm install
npm test
```

Tests use Vitest on Node with in-memory R2 and KV stand-ins. The Workers Vitest pool (workerd) is not required: the handler only uses Web APIs (`Request`, `FormData`, `crypto.subtle`) and the binding methods those fakes implement.

## Still TODO

- Confirm `GAME_SAVED_PROJECT_DIR` on TJ's PC (launcher config, not this Worker).
- Create the private Discord channel and webhook.
- Create the R2 bucket and KV namespace, set `DISCORD_WEBHOOK_URL`, deploy.
- Put the deployed URL in the launcher's `BUG_REPORT_URL`. Until then the launcher refuses to send.
