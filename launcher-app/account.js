// Discord account linking (main process only).
// Flow: Steam ticket -> POST /steam/verify -> session (stored with safeStorage)
//       -> browser /link/start?session=... -> poll GET /entitlements -> verify Ed25519 token
//       -> write %LOCALAPPDATA%\SentientSolutions\TGC\entitlement.token for the game.
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cfg = require('./config');

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOT_OWNED_MESSAGE = "This Steam account doesn't own THE GREAT CIRCLE or its demo.";

/** Windows: is steam.exe running? Used only to word the error when no app could init. */
function isSteamProcessRunning() {
  if (process.platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    require('child_process').execFile('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      resolve(!err && /steam\.exe/i.test(String(out)));
    });
  });
}

// ---------------- token verification (pure; unit-tested in scripts/selftest.js) ----------------

function publicKeyFromHex(hex) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('public key must be 32 bytes');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/**
 * Token format (SS_AccountServer/src/crypto.ts):
 *   base64url(JSON payload) "." base64url(Ed25519 signature over the ASCII of the first part)
 * Returns { ok, payload?, reason? }.
 */
function verifyEntitlementToken(token, publicKeyHex = cfg.ENTITLEMENT_PUBLIC_KEY_HEX, expectSteamId = null) {
  if (typeof token !== 'string' || token.length > 16384) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, Buffer.from(parts[0], 'ascii'), publicKeyFromHex(publicKeyHex), Buffer.from(parts[1], 'base64url'));
  } catch (_) {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.entitlements)) return { ok: false, reason: 'bad_payload' };
  if (typeof payload.exp !== 'number' || payload.exp < nowS()) return { ok: false, reason: 'expired', payload };
  if (expectSteamId && String(payload.steamid) !== String(expectSteamId)) return { ok: false, reason: 'steamid_mismatch', payload };
  return { ok: true, payload };
}

/** Supporter tier from a verified payload (additive v1 fields; older tokens have none). */
const TIER_NAMES = ['None', 'Copper', 'Bronze', 'Silver', 'Gold', 'Platinum'];
function tierFromPayload(payload) {
  const t = Number(payload && payload.tier);
  if (!Number.isInteger(t) || t < 0 || t > 5) return { tier: 0, tierName: 'None' };
  const name = typeof payload.tier_name === 'string' && TIER_NAMES.includes(payload.tier_name) ? payload.tier_name : TIER_NAMES[t];
  return { tier: t, tierName: name };
}

// ---------------- entitlement file for the game ----------------

function entitlementFilePath() {
  const base = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  return path.join(base, ...cfg.ENTITLEMENT_DIR_PARTS, cfg.ENTITLEMENT_FILE_NAME);
}

function writeEntitlementFile(token) {
  const file = entitlementFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, token, { encoding: 'ascii' });
  fs.renameSync(tmp, file);
  return file;
}

function readEntitlementFile() {
  try {
    return fs.readFileSync(entitlementFilePath(), 'ascii').trim();
  } catch (_) {
    return null;
  }
}

function removeEntitlementFile() {
  try { fs.unlinkSync(entitlementFilePath()); } catch (_) { /* not there */ }
}

/**
 * Pure: what Play should do after a Steam ownership probe (tryApps('probe')).
 *   owns full game or demo -> { appId }
 *   steam_not_owned        -> { appId: null, code: 'not_owned' }          (Play must not open steam://run)
 *   steam_not_running      -> { appId: null, code: 'steam_not_running' }  (ask the player to start Steam)
 *   anything else (helper missing, timeout, ...) -> we can't tell, so fall back to DEFAULT_LAUNCH_APP_ID.
 */
function launchDecisionFromProbe(p, defaultAppId = cfg.DEFAULT_LAUNCH_APP_ID) {
  if (p && p.ok && cfg.STEAM_APP_IDS.includes(Number(p.appid))) return { appId: Number(p.appid), code: null };
  const code = (p && p.code) || 'probe_failed';
  if (code === 'steam_not_owned') return { appId: null, code: 'not_owned' };
  if (code === 'steam_not_running') return { appId: null, code: 'steam_not_running' };
  return { appId: defaultAppId, code };
}

// ---------------- account manager ----------------

// isSteamRunning is injectable for scripts/selftest.js only; the launcher always uses the tasklist check.
function createAccountManager({ app, safeStorage, shell, utilityProcess, isSteamRunning = isSteamProcessRunning }) {
  const sessionFile = () => path.join(app.getPath('userData'), 'account_session.bin');
  let memSession = null; // fallback when OS encryption isn't available (session then lasts until the launcher closes)
  let linkAbort = null;
  const activeWorkers = new Set(); // Steam helper processes still running (see waitForSteamWorkers)

  function saveSession(s) {
    memSession = s;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(sessionFile(), safeStorage.encryptString(JSON.stringify(s)));
      }
    } catch (_) { /* memory only */ }
  }

  function loadSession() {
    let s = memSession;
    if (!s) {
      try {
        if (safeStorage.isEncryptionAvailable() && fs.existsSync(sessionFile())) {
          s = JSON.parse(safeStorage.decryptString(fs.readFileSync(sessionFile())));
        }
      } catch (_) { s = null; }
    }
    if (s && typeof s.session === 'string' && Number(s.expires_at) - 60 > nowS()) return s;
    return null;
  }

  function clearSession() {
    memSession = null;
    try { fs.unlinkSync(sessionFile()); } catch (_) { /* not there */ }
  }

  // Display-only cache so the offline/cached status can still show the Discord username.
  const profileFile = () => path.join(app.getPath('userData'), 'discord_profile.json');
  function saveProfile(discordId, discordUsername) {
    if (!discordId || !discordUsername) return;
    try { fs.writeFileSync(profileFile(), JSON.stringify({ discordId: String(discordId), discordUsername: String(discordUsername) })); } catch (_) { /* ignore */ }
  }
  function cachedUsername(discordId) {
    try {
      const p = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
      return p.discordId === String(discordId) ? p.discordUsername : null;
    } catch (_) {
      return null;
    }
  }

  const appFile = () => path.join(app.getPath('userData'), 'steam_app.json'); // not secret: which app this account owns

  function rememberApp(appid) {
    try { fs.writeFileSync(appFile(), JSON.stringify({ appid: Number(appid) })); } catch (_) { /* ignore */ }
  }

  function knownApp() {
    try {
      const a = Number(JSON.parse(fs.readFileSync(appFile(), 'utf8')).appid);
      return cfg.STEAM_APP_IDS.includes(a) ? a : null;
    } catch (_) {
      return null;
    }
  }

  /** One out-of-process Steam worker run for one app id. Resolves only after the worker has exited. */
  function runWorker(appid, mode = 'verify', timeoutMs = 25000) {
    return new Promise((resolve) => {
      let child;
      try {
        child = utilityProcess.fork(path.join(__dirname, 'steam-ticket-worker.js'), [String(appid), mode], {
          cwd: __dirname,
          serviceName: 'SS Steam ticket',
          stdio: 'ignore',
        });
      } catch (e) {
        resolve({ ok: false, appid, code: 'steam_worker_failed', message: 'Could not start the Steam helper.' });
        return;
      }
      activeWorkers.add(child);
      child.on('exit', () => activeWorkers.delete(child));
      let result = null;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result || { ok: false, appid, code: 'steam_worker_exit', message: 'Steam helper exited without an answer.' });
      };
      const timer = setTimeout(() => {
        result = result || { ok: false, appid, code: 'steam_timeout', message: 'Steam did not answer in time.' };
        try { child.kill(); } catch (_) { /* ignore */ }
        setTimeout(settle, 1000);
      }, timeoutMs);
      child.on('message', (m) => { result = m; });
      child.on('exit', settle); // wait for exit so Steam no longer sees the app as running
    });
  }

  /**
   * Before starting the game: let any Steam helper finish (or stop it after timeoutMs), so only the game
   * holds the Steam API for this app. Resolves true when none are left.
   */
  async function waitForSteamWorkers(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (activeWorkers.size && Date.now() < deadline) await sleep(100);
    if (!activeWorkers.size) return true;
    for (const c of activeWorkers) { try { c.kill(); } catch (_) { /* ignore */ } }
    const killDeadline = Date.now() + 2000;
    while (activeWorkers.size && Date.now() < killDeadline) await sleep(100);
    return activeWorkers.size === 0;
  }

  /** Try each app (full game, then demo) until Steam inits; returns the first result that isn't an init failure. */
  async function tryApps(mode) {
    const order = [...new Set([knownApp(), ...cfg.STEAM_APP_IDS].filter(Boolean))];
    let last = null;
    for (const appid of order) {
      const r = await runWorker(appid, mode);
      if (r.ok) {
        rememberApp(appid);
        return { ...r, appid };
      }
      last = r;
      if (r.code !== 'steam_init_failed' && r.code !== 'steam_wrong_app') return r; // real error (server, ticket, ...)
    }
    if (!(await isSteamRunning())) {
      return { ok: false, code: 'steam_not_running', message: 'Steam is not running. Start Steam, sign in, and try again.' };
    }
    return { ok: false, code: 'steam_not_owned', message: NOT_OWNED_MESSAGE, detail: last && last.message };
  }

  /** Get a fresh session via the Steam worker (full game first, then demo). */
  function steamSession() {
    return tryApps('verify');
  }

  async function ensureSession({ allowSteam }) {
    const s = loadSession();
    if (s) return { ok: true, ...s };
    if (!allowSteam) return { ok: false, code: 'no_session' };
    const r = await steamSession();
    if (!r.ok) return r;
    const sess = { session: r.session, steamid: r.steamid, expires_at: r.expires_at, appid: r.appid };
    saveSession(sess);
    return { ok: true, ...sess };
  }

  async function fetchEntitlements(session) {
    const res = await fetch(`${cfg.ACCOUNT_SERVER_URL}/entitlements`, {
      headers: { authorization: `Bearer ${session}` },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  function statusFromToken(token, source, extra = {}) {
    const v = verifyEntitlementToken(token);
    if (!v.ok) return { linked: false, source, reason: `token_${v.reason}`, ...extra };
    if (!extra.discordUsername) extra = { ...extra, discordUsername: cachedUsername(v.payload.discord_id) };
    return {
      linked: true,
      source,
      steamid: v.payload.steamid,
      steamApp: v.payload.steam_app || null,
      ownsFullGame: typeof v.payload.owns_full_game === 'boolean' ? v.payload.owns_full_game : null,
      discordId: v.payload.discord_id,
      discordUsername: extra.discordUsername || null,
      entitlements: v.payload.entitlements,
      ...tierFromPayload(v.payload),
      expiresAt: v.payload.exp,
      tokenFile: entitlementFilePath(),
      ...extra,
    };
  }

  /** Ask the server once with a session; applies the result to the local token file. */
  async function syncWithServer(sess) {
    const r = await fetchEntitlements(sess.session);
    if (r.status === 401) {
      clearSession();
      return { linked: false, source: 'server', reason: 'session_expired' };
    }
    if (r.status === 404) {
      removeEntitlementFile(); // server says not linked: drop stale perks
      return { linked: false, source: 'server', steamid: sess.steamid, reason: r.body.reason || 'not_linked' };
    }
    if (r.status !== 200 || !r.body.linked || typeof r.body.token !== 'string') {
      return { linked: false, source: 'server', reason: r.body.error || `http_${r.status}`, error: true };
    }
    const v = verifyEntitlementToken(r.body.token, cfg.ENTITLEMENT_PUBLIC_KEY_HEX, sess.steamid || null);
    if (!v.ok) return { linked: false, source: 'server', reason: `token_${v.reason}`, error: true };
    writeEntitlementFile(r.body.token);
    if (typeof r.body.discord_username === 'string') saveProfile(v.payload.discord_id, r.body.discord_username);
    return statusFromToken(r.body.token, 'server', {
      inGuild: !!r.body.in_guild,
      // Server doesn't return the username yet; shown if it ever does.
      discordUsername: typeof r.body.discord_username === 'string' ? r.body.discord_username : null,
    });
  }

  /** Status for the UI. Never starts Steam: uses a stored session, else the cached token (offline). */
  async function getStatus() {
    const sess = loadSession();
    if (sess) {
      try {
        const st = await syncWithServer(sess);
        if (!st.error) return st;
      } catch (_) { /* offline: fall through to cache */ }
    }
    const cached = readEntitlementFile();
    if (cached) return statusFromToken(cached, 'cache');
    return { linked: false, source: 'none', reason: 'not_linked' };
  }

  /** Full link flow. onProgress(stage, info) is sent to the renderer. */
  async function linkDiscord(onProgress) {
    if (linkAbort) linkAbort.abort();
    const ctl = new AbortController();
    linkAbort = ctl;
    try {
      onProgress('steam');
      // Always start from a fresh Steam login so the session matches who is signed in to Steam now.
      clearSession();
      const sess = await ensureSession({ allowSteam: true });
      if (!sess.ok) return { linked: false, reason: sess.code, message: sess.message, error: true };

      let before = null;
      try {
        const r0 = await fetchEntitlements(sess.session);
        if (r0.status === 200 && r0.body.payload) before = r0.body.payload.discord_id || null;
      } catch (_) { /* ignore */ }

      onProgress('browser');
      await shell.openExternal(`${cfg.ACCOUNT_SERVER_URL}/link/start?session=${encodeURIComponent(sess.session)}`);

      onProgress('waiting', { relink: !!before });
      const deadline = Date.now() + cfg.LINK_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(cfg.LINK_POLL_INTERVAL_MS);
        if (ctl.signal.aborted) return await getStatus();
        let st;
        try {
          st = await syncWithServer(sess);
        } catch (_) {
          continue; // transient network error: keep polling
        }
        if (st.reason === 'session_expired') return { ...st, error: true };
        // First link: done as soon as linked. Relink: done when the Discord account changes
        // (same account relinked -> user presses "I'm done", which cancels and refreshes).
        if (st.linked && (!before || st.discordId !== before)) return st;
      }
      return { ...(await getStatus()), reason: 'link_timeout', timedOut: true };
    } finally {
      if (linkAbort === ctl) linkAbort = null;
    }
  }

  function cancelLink() {
    if (linkAbort) linkAbort.abort();
  }

  /**
   * What Play should launch: what Steam last proved this account owns (full game or demo).
   * Returns { appId, code }. appId null means don't open steam://run (code says why, see launchDecisionFromProbe).
   */
  async function resolveLaunchApp(sess, status) {
    const fromStatus = status && Number(status.steamApp);
    const a = (sess && Number(sess.appid)) || (cfg.STEAM_APP_IDS.includes(fromStatus) ? fromStatus : null) || knownApp();
    if (a) return { appId: a, code: null };
    const p = await tryApps('probe'); // first Play ever on this PC: ask Steam which one is owned
    return launchDecisionFromProbe(p);
  }

  /**
   * Called before Play. Best effort, bounded by PLAY_REFRESH_TIMEOUT_MS; never blocks launching.
   * Only fetches a Steam session if this player has linked before (token file or session exists).
   * Returns the entitlement status plus launchAppId (1751950, or 1865070 for demo-only accounts).
   * launchAppId is null with launchCode 'not_owned' / 'steam_not_running' when Play should not open Steam.
   * resolveApp:false skips working out launchAppId (exe launch mode: the install folder decides what runs).
   */
  async function refreshBeforePlay({ resolveApp = true } = {}) {
    let sess = null;
    const work = (async () => {
      sess = loadSession();
      if (!sess) {
        if (!readEntitlementFile()) return { linked: false, reason: 'not_linked', skipped: true };
        const s = await ensureSession({ allowSteam: true });
        if (!s.ok) return { linked: false, reason: s.code, error: true };
        sess = s;
      }
      return await syncWithServer(sess);
    })();
    const timeout = sleep(cfg.PLAY_REFRESH_TIMEOUT_MS).then(() => ({ reason: 'refresh_timeout', error: true }));
    let status;
    try {
      status = await Promise.race([work, timeout]);
    } catch (_) {
      status = { reason: 'refresh_failed', error: true };
    }
    if (!status.linked && !status.skipped) {
      const cached = readEntitlementFile();
      if (cached) status = { ...statusFromToken(cached, 'cache'), refreshError: status.reason };
    }
    if (!resolveApp) return { ...status, launchAppId: null, launchCode: null };
    const d = await resolveLaunchApp(sess, status);
    return { ...status, launchAppId: d.appId, launchCode: d.code };
  }

  /**
   * Steam beta branch passwords this player's Discord tier grants (GET /branches).
   * Uses the stored session only; never starts Steam and never links. Passwords are returned to the
   * caller and NOT written to disk, the session file, the token file, or any log.
   */
  async function fetchBranches() {
    const sess = loadSession();
    if (!sess) return { ok: false, reason: 'no_session', branches: [] };
    let res;
    try {
      res = await fetch(`${cfg.ACCOUNT_SERVER_URL}/branches`, {
        headers: { authorization: `Bearer ${sess.session}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
    } catch (_) {
      return { ok: false, reason: 'server_unreachable', branches: [] };
    }
    if (res.status === 401) { clearSession(); return { ok: false, reason: 'session_expired', branches: [] }; }
    if (res.status === 404) return { ok: false, reason: 'not_linked', branches: [] };
    if (res.status !== 200) return { ok: false, reason: `http_${res.status}`, branches: [] };
    const body = await res.json().catch(() => null);
    const list = body && Array.isArray(body.branches) ? body.branches : [];
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const branches = list
      .map((b) => ({ branch: str(b && b.branch, 64), label: str(b && b.label, 80), password: str(b && b.password, 128) }))
      .filter((b) => b.branch && b.password);
    return { ok: true, tier: Number(body && body.tier) || 0, tierName: str(body && body.tier_name, 16), branches };
  }

  return { getStatus, linkDiscord, cancelLink, refreshBeforePlay, waitForSteamWorkers, fetchBranches };
}

module.exports = {
  createAccountManager,
  verifyEntitlementToken,
  tierFromPayload,
  entitlementFilePath,
  launchDecisionFromProbe,
};
