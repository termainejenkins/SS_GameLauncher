# Report a bug

Opt-in only. The launcher shows a preview of the files and their size, and nothing is uploaded until the player presses **Send**.

## What the player sees

Sidebar item **Report a bug**:

- Description, required, 20–2000 characters
- Category: crash, performance, gameplay, or other
- Optional screenshot (PNG or JPG, 8 MB)
- **Attach logs** (on by default) and **Attach system info** (on by default)
- One line of consent: what is sent, and that it is used only to fix bugs
- A file list and the total upload size before Send

Success and failure show on the form, including the "too many reports today" case (HTTP 429).

## What is collected

System info, when the box is checked: launcher version, game build and branch if the launcher knows them, OS version, CPU, GPU, driver version, RAM, and VRAM when Electron reports it. No username, no machine name, no IP.

Logs, when the box is checked, come from the confirmed folder `%LOCALAPPDATA%\TheGreatCircle_4_27\` (`GAME_SAVED_PROJECT_DIR`). A 5.8 build may rename that folder; it is the only config value to change. This is not the entitlement folder `SentientSolutions\TGC`.

- Newest `*.log` in `Saved\Logs\`, by modification time. `cef3.log` and any other `cef*` log are skipped, so the file is `TheGreatCircle_4_27.log` or a newer timestamped `TheGreatCircle_4_27-backup-*.log`.
- The newest `UECC-Windows-*` folder under `Saved\Crashes\` — only `CrashContext.runtime-xml`, the crash `.log`, and the minidump.

The zip is capped at 25 MB. If the log is larger, the newest part is kept and the rest is dropped. Minidumps that still do not fit are left out. `.ini` files, `Saved\Config`, tokens, passwords, webhook URLs, the clipboard, and anything outside that allowlist are not packed.

The Windows user name is replaced with `<user>` in paths inside text files, in system info, and in the description (backslashes, forward slashes, mixed case, `C:\Users\<name>\`, a `%USERPROFILE%` path, and JSON `\\` escapes). SteamID64 values in those text files are replaced with `[steam]`.

The install id is a random UUID in the launcher's settings file. Only its SHA-256 hash is uploaded, and only as the rate-limit key. It is not written into the R2 metadata.

If this PC has an entitlement token, Send also posts that signed token as `entitlementToken`. Branch passwords are not sent. The Worker checks the signature and expiry. A valid token whose entitlements include `developer` tags the stored JSON with `"developer": true` and prefixes the Discord note with `[DEV]`. A missing, bad, or expired token does not reject the report and does not tag it. The token is not written to R2 or the logs.

The Worker is deployed at `https://tgc-bug-report.sentientsolutions.workers.dev/api/bug-report`. `BUG_REPORT_URL` in `launcher-app/config.js` is that URL. If the constant is unset, Send refuses to open a connection and nothing is uploaded.

## Where it lands

The Worker (`bug-report-worker/`) stores the zip at `reports/<YYYY-MM-DD>/<id>.zip` plus `<id>.json` in a private R2 bucket, then posts a short note to Discord (category, game build, GPU, first 200 characters of the description, report id). A verified developer token adds `"developer": true` on the JSON and `[DEV]` on the Discord note. A Discord failure does not delete the stored report. `@everyone` and `@here` cannot ping the channel.

Rate limit: 5 reports per install-id hash per UTC day, and 20 per daily-salted IP hash. The raw IP is not stored or logged. See the Worker README for why this uses KV rather than a Durable Object.

Reports are kept 90 days (R2 lifecycle rule, with a daily cron as a backup). The bucket is not publicly readable.

## Deploy steps for TJ (later — not part of this change)

Do this from `bug-report-worker/` after `npx wrangler@4 login`. Do not put the webhook on the command line; `secret put` asks for it.

1. Create a private R2 bucket. Leave r2.dev and any public domain off.
   ```sh
   npx wrangler@4 r2 bucket create tgc-bug-reports
   ```
2. Expire objects under `reports/` after 90 days. Do not add a bucket lock on that prefix (a lock would block deletion).
   ```sh
   npx wrangler@4 r2 bucket lifecycle add tgc-bug-reports expire-bug-reports-90d reports/ --expire-days 90
   ```
3. The production `RATE` id in `bug-report-worker/wrangler.toml` is the live namespace. `preview_id` is still the all-zero placeholder until a preview namespace exists:
   ```sh
   npx wrangler@4 kv namespace create RATE --preview
   ```
4. Create a private Discord channel and webhook, then store the URL as a Worker secret:
   ```sh
   npx wrangler@4 secret put DISCORD_WEBHOOK_URL
   ```
5. Deploy:
   ```sh
   npx wrangler@4 deploy
   ```
6. Point the launcher at the Worker. This is already done: `BUG_REPORT_URL` in `launcher-app/config.js` is `https://tgc-bug-report.sentientsolutions.workers.dev/api/bug-report`.

Optional: `npx wrangler@4 secret put RATE_LIMIT_SALT` adds a pepper so a copy of the KV namespace cannot be matched back to an IP. The Worker runs without it.

More detail (what each field is, the cron lookback, how to run tests) is in [bug-report-worker/README.md](../bug-report-worker/README.md).

## Tests

```sh
npm test
```

That runs `node --test bug-report.test.js` in `launcher-app/` and Vitest in `bug-report-worker/`.

## Still TODO

- Create the private Discord channel and webhook, then `wrangler secret put DISCORD_WEBHOOK_URL`.
- Create the R2 bucket, apply the lifecycle rule, and deploy. The production `RATE` id is the live namespace; `preview_id` is still the all-zero placeholder. Do not enable public read on the bucket.
- Optional: add `gameBuild` and `gameBranch` to `launcher-config.json` beside the game. If they are absent, the launcher uses a `LogInit: Build:` line from the game log when it can see that file.
- Ship a launcher build only with TJ's OK. This change does not bump the version, tag a release, or delete old releases.

## Assumptions

- Screenshot cap is 8 MB, sent as its own multipart part so the 25 MB cap stays on the log zip.
- The zip is built with Node's `zlib` (no new package). `yauzl` in the launcher only reads zips.
- VRAM is filled when Electron's GPU info includes it. There is no WMI / PowerShell call.
- Game build comes from `launcher-config.json` (`gameBuild`, `gameBranch`) or from `LogInit: Build:` in the log. The launcher does not guess a Steam beta branch.
- Upload runs in the Electron main process. The page never sees log paths or the raw install UUID.
- The install-id hash is only the rate-limit key. It is not stored next to the zip.
- There is no CI workflow in this repo. `npm test` is the check.
