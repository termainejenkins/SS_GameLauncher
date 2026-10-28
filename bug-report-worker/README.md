# Bug-report Worker

Private intake for the launcher's **Report a bug** form. The launcher zips logs and posts them to `POST /api/bug-report`. This Worker checks the upload, rate-limits it, stores it in a private R2 bucket, and posts a short note to Discord.

The Worker is deployed at `https://tgc-bug-report.sentientsolutions.workers.dev/api/bug-report`. `BUG_REPORT_URL` in `launcher-app/config.js` is that URL. If the constant is unset, the launcher sends nothing. The saved-project folder is confirmed (`TheGreatCircle_4_27`; a 5.8 build may rename it). TJ runs the steps below when the Discord channel is ready.

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
| `app` | no | Allowlisted name of another Sentient Solutions app. The only name today is `ReplyReader`, matched case-insensitively and stored as `ReplyReader`. Omit the field, or leave it blank, for a launcher report. Any other value is **400** `invalid_app`. Nothing is stored, and the rate counters do not move. |
| `appVersion` | no | Kept only when it looks like a version: `1.2.3`, an optional leading `v`, and an optional prerelease such as `-beta.1`. Anything else is ignored and stored as `null`. |
| `entitlementToken` | no | Signed entitlement token, when the launcher has one. If it verifies, is unexpired, and includes `developer`, the stored JSON gets `"developer": true` and the Discord note starts with `[DEV]`. A missing, bad, or expired token is ignored. The report is still accepted. The token is not stored or logged. |

A bad field value is a 4xx. An unknown extra field is ignored. A value of `app` that is not on the allowlist is rejected, not ignored. The body cap is 25 MB plus the 8 MB screenshot allowance plus 256 KB of multipart overhead. Over that, the response is **413**. Over the daily rate limit, the response is **429** with `Retry-After` (seconds until the next UTC day).

A valid report is stored at:

- `reports/<YYYY-MM-DD>/<id>.zip`
- `reports/<YYYY-MM-DD>/<id>.json` — category, game build, GPU, description, launcher version, `app` (`launcher` when the field was omitted), `appVersion` (or `null`), createdAt, report id, and `hasScreenshot`. `"developer": true` when the entitlement token verified as a developer. No IP, no install-id hash, and no entitlement token.
- `reports/<YYYY-MM-DD>/<id>.png` or `.jpg` when a screenshot was attached

The zip and the JSON object are written with R2 custom metadata `app`, `appVersion` (empty when none was accepted), and `category`. A listing can separate ReplyReader objects from launcher objects without reading the JSON. The key layout is unchanged.

A launcher report (no `app`) sends Discord the same note as before: category, game build, GPU, launcher version, the first 200 characters of the description, and the report id. A report with an allowlisted `app` sends `App: ReplyReader 0.8.0` (or `unknown` when `appVersion` was missing or ignored) and the category, and does not include the game-build, GPU, or launcher lines. `@everyone` and `@here` are broken up, and the webhook is called with `allowed_mentions: { parse: [] }`. If Discord errors, the R2 objects stay and the player still gets a success response.

## Rate limits (KV, not a Durable Object)

Counters live in the `RATE` KV namespace:

- 5 accepted reports per install-id hash per UTC day
- 20 accepted reports per IP hash per UTC day

The counters are not split by app. ReplyReader and the launcher share these caps. ReplyReader uses its own install id, so its reports do not spend a launcher install's allowance. They do count toward the shared per-IP cap.

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
3. The production `RATE` id in `wrangler.toml` is the live namespace (`bb566c4909254ceb831e235bf40476d9`). `preview_id` is still the all-zero placeholder until a preview namespace exists:
   ```sh
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
6. Point the launcher at the deployed Worker. This is already done: `BUG_REPORT_URL` in `launcher-app/config.js` is
   `https://tgc-bug-report.sentientsolutions.workers.dev/api/bug-report`

`wrangler secret put` publishes a new version. That is fine once the bindings above are real. This pull request does not run it.

Local tests do not need Wrangler or a Cloudflare login:

```sh
npm install
npm test
```

Tests use Vitest on Node with in-memory R2 and KV stand-ins. The Workers Vitest pool (workerd) is not required: the handler only uses Web APIs (`Request`, `FormData`, `crypto.subtle`) and the binding methods those fakes implement.

## Still TODO

- Create the private Discord channel and webhook.
- Create the R2 bucket and KV namespace, set `DISCORD_WEBHOOK_URL`, deploy.
