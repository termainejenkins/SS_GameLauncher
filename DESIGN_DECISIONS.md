# Design Decisions: SS_GameLauncher

## Credits
Created by Termaine Jenkins (aka TJ, SENTIENT SOLUTIONS LLC)

---

### 2025-05-13: Initial Architecture
- **Decision:** Use a modular monolith structure with separate folders for backend (API server) and launcher-app (Electron desktop app).
- **Reason:** Easier to start, maintain, and refactor. Allows for future migration to microservices if needed.

### 2025-05-13: Keep Web Game Separate
- **Decision:** The web-based game will remain in its own folder/repo for now.
- **Reason:** Allows independent development and deployment. Integration will be via URL or API.

### 2025-05-13: Tech Stack Choices
- **Backend:** Node.js + Express + TypeScript
- **Launcher:** Electron (JavaScript)
- **Reason:** Popular, well-supported, and easy to maintain. TypeScript for type safety.

### 2026-10-24: Bug reports go to a private Worker, not the news API
- **Decision:** The launcher packs an allowlisted, scrubbed zip and POSTs it to a Cloudflare Worker. The Worker stores the zip in a private R2 bucket and notifies a private Discord channel. Rate limits use KV (5/day per install-id hash, 20/day per daily-salted IP hash).
- **Reason:** KV is enough for a low-volume form. A race can allow one extra report; a Durable Object would make the counter strict but adds a class, a migration, and a hop on every send. The raw IP is never stored: the KV key is a SHA-256 of a per-day salt and the IP. R2 has no public read. Reports expire after 90 days via an R2 lifecycle rule, with a daily cron as a backup. The install id stored on the PC is a random UUID; only its SHA-256 is sent, and it is not written into the report metadata.

### 2025-05-13: Unified Start Command
- **Decision:** Use `concurrently` and a root-level `npm start` script to run backend and launcher-app together.
- **Reason:** Simplifies development workflow and reduces setup friction for developers. 