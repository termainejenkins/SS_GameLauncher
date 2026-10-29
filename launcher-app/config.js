// Launcher configuration. Nothing in this file is a secret.
//
// ACCOUNT_SERVER_URL and BUG_REPORT_URL are not committed. They are read when
// this module loads from config.private.json (gitignored) and from the
// environment variables of the same names. A non-empty environment variable
// wins. A missing, empty, or unreadable file leaves the value as '' — the
// same as unset. Bug reports are not sent in that case. Account-server calls
// fail the way they do when the server cannot be reached.
//
// A release build must supply the values. electron-builder packs
// config.private.json when that file is present. build/beforePack.js writes
// any environment variables into the copy that gets packed, then restores the
// working tree. Players only see this after a launcher release.
'use strict';

const fs = require('fs');
const path = require('path');

const PRIVATE_CONFIG_NAME = 'config.private.json';
const PRIVATE_URL_KEYS = Object.freeze(['ACCOUNT_SERVER_URL', 'BUG_REPORT_URL']);

function nonEmpty(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
}

function readPrivateFile(filePath, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_) {
    return {};
  }
}

/**
 * Resolve the two launcher URLs. `env` defaults to process.env. Pass
 * `filePath: null` to skip the file. A missing file does not throw.
 * A non-empty environment variable wins over the file.
 */
function resolvePrivateUrls(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const fsImpl = opts.fs || fs;
  const filePath = Object.prototype.hasOwnProperty.call(opts, 'filePath')
    ? opts.filePath
    : path.join(__dirname, PRIVATE_CONFIG_NAME);
  const fromFile = filePath ? readPrivateFile(filePath, fsImpl) : {};
  const out = {};
  for (const key of PRIVATE_URL_KEYS) {
    out[key] = nonEmpty(env[key]) || nonEmpty(fromFile[key]);
  }
  return out;
}

const privateUrls = resolvePrivateUrls({ env: process.env });

module.exports = Object.freeze({
  // Live SS_AccountServer (Cloudflare Worker), from the private file or env.
  ...privateUrls,

  PRIVATE_URL_KEYS,
  resolvePrivateUrls,

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
});
