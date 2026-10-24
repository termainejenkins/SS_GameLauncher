// Launcher configuration. Nothing in this file is secret.
'use strict';

module.exports = Object.freeze({
  // Live SS_AccountServer (Cloudflare Worker). Change here only.
  ACCOUNT_SERVER_URL: 'https://ss-account-server.sentientsolutions.workers.dev',

  // THE GREAT CIRCLE on Steam: full game, then the free demo. Linking tries them in this order,
  // so demo-only players can link too. Must match STEAM_APP_IDS in SS_AccountServer/wrangler.toml.
  STEAM_APP_ID: 1751950,
  STEAM_DEMO_APP_ID: 1865070,
  STEAM_APP_IDS: [1751950, 1865070],
  // Play falls back to this app when the launcher can't tell which one the player owns (Steam helper failed or
  // timed out). The demo while the full game is unreleased. FLIP to 1751950 (STEAM_APP_ID) at full launch.
  DEFAULT_LAUNCH_APP_ID: 1865070,
  // Must match STEAM_IDENTITY in SS_AccountServer/wrangler.toml.
  STEAM_IDENTITY: 'SS_AccountServer',

  // Ed25519 PUBLIC key from SS_AccountServer/public_key.txt (raw 32 bytes, hex). Safe to ship.
  ENTITLEMENT_PUBLIC_KEY_HEX: '91bd847131a2280632b310af9956bdd3e293c01179c86cace37d4460dcfc8525',

  // Where the game reads the signed token: %LOCALAPPDATA%\SentientSolutions\TGC\entitlement.token
  ENTITLEMENT_DIR_PARTS: ['SentientSolutions', 'TGC'],
  ENTITLEMENT_FILE_NAME: 'entitlement.token',

  // Link polling.
  LINK_POLL_INTERVAL_MS: 3000,
  LINK_TIMEOUT_MS: 5 * 60 * 1000,
  // Max time Play waits for a token refresh before launching anyway.
  PLAY_REFRESH_TIMEOUT_MS: 10000,

  // Local news/updates backend (backend/src/index.ts).
  BACKEND_URL: 'http://localhost:3000',

  // Confirmed on a 4.27 install. Logs: %LOCALAPPDATA%\TheGreatCircle_4_27\Saved\Logs
  // Crashes: %LOCALAPPDATA%\TheGreatCircle_4_27\Saved\Crashes (folders look like UECC-Windows-*).
  // This is not the entitlement directory (SentientSolutions\TGC). A 5.8 build may rename this folder.
  GAME_SAVED_PROJECT_DIR: 'TheGreatCircle_4_27',

  // TODO(TJ): Replace with the deployed Worker URL (https://<worker>/api/bug-report) before any report can be sent.
  // The .invalid host is a placeholder on purpose: the launcher refuses to upload until this is a real https URL.
  BUG_REPORT_URL: 'https://bug-report.example.invalid/api/bug-report',
});
