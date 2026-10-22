// Starts the game exe from the Steam install folder (Steam launches THIS launcher, the launcher starts the game).
// Plain Node (no Electron imports) so scripts/selftest.js can test it.
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const CONFIG_FILE_NAME = 'launcher-config.json';

// Defaults when launcher-config.json is missing or a value is invalid.
const DEFAULTS = Object.freeze({
  // "exe"   = start the game from the install folder (shipping / Steam).
  // "steam" = open steam://run/<appid> (old behaviour; dev only, refused when Steam started us: it would loop).
  launchMode: 'exe',
  // Game folder, relative to the folder TGC_Launcher.exe is in. Depot layout: <game root>\Launcher\TGC_Launcher.exe
  gameRoot: '..',
  // First one that exists wins. Relative to gameRoot; may not leave it.
  gameExe: [
    'TheGreatCircle_4_27.exe',
    'TheGreatCircle.exe',
    'TheGreatCircle_4_27/Binaries/Win64/TheGreatCircle_4_27-Win64-Shipping.exe',
  ],
  extraArgs: [], // always passed to the game, before forwarded args
  forwardArgs: true, // pass the launcher's own command-line args (Steam launch options) on to the game
  // After Play: "close-and-wait" closes the window and waits (no UI, small memory) until the game exits, then quits,
  // so Steam keeps showing "Running" and counting playtime. "quit" | "minimize" | "stay" also work.
  afterLaunch: 'close-and-wait',
  // If the game exits with an error within this time, the launcher stays open and shows the error.
  startupCheckMs: 4000,
});

const AFTER_LAUNCH = ['close-and-wait', 'quit', 'minimize', 'stay'];

function isStrArray(a) {
  return Array.isArray(a) && a.every((s) => typeof s === 'string' && s.length > 0 && s.length < 500);
}

/** Reads <dir>\launcher-config.json and merges it over the defaults. Never throws. */
function loadLaunchConfig(dir, defaults = DEFAULTS) {
  const file = path.join(dir, CONFIG_FILE_NAME);
  const out = { ...defaults };
  const warnings = [];
  let raw = null;
  try {
    if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    warnings.push(`${CONFIG_FILE_NAME} is not valid JSON; using defaults`);
  }
  if (raw && typeof raw === 'object') {
    if (raw.launchMode === 'exe' || raw.launchMode === 'steam') out.launchMode = raw.launchMode;
    else if ('launchMode' in raw) warnings.push('launchMode ignored');
    if (typeof raw.gameRoot === 'string' && raw.gameRoot.trim()) out.gameRoot = raw.gameRoot.trim();
    if (typeof raw.gameExe === 'string' && raw.gameExe.trim()) out.gameExe = [raw.gameExe.trim()];
    else if (isStrArray(raw.gameExe) && raw.gameExe.length) out.gameExe = raw.gameExe;
    if (isStrArray(raw.extraArgs) || (Array.isArray(raw.extraArgs) && !raw.extraArgs.length)) out.extraArgs = raw.extraArgs;
    if (typeof raw.forwardArgs === 'boolean') out.forwardArgs = raw.forwardArgs;
    if (AFTER_LAUNCH.includes(raw.afterLaunch)) out.afterLaunch = raw.afterLaunch;
    else if ('afterLaunch' in raw) warnings.push('afterLaunch ignored');
    if (Number.isFinite(raw.startupCheckMs) && raw.startupCheckMs >= 0 && raw.startupCheckMs <= 30000) out.startupCheckMs = raw.startupCheckMs;
  }
  return { config: out, file, found: !!raw, warnings };
}

/** Finds the game exe. Candidates must be .exe files inside the game root. */
function resolveGameExe(config, launcherDir) {
  const root = path.resolve(launcherDir, config.gameRoot);
  const tried = [];
  for (const rel of config.gameExe) {
    const exe = path.resolve(root, rel);
    const inside = path.relative(root, exe);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !/\.exe$/i.test(exe)) continue;
    tried.push(exe);
    try {
      if (fs.statSync(exe).isFile()) return { ok: true, exe, root, tried };
    } catch (_) { /* not there */ }
  }
  return { ok: false, root, tried };
}

/**
 * Args to forward to the game: everything after the exe (and after the app path in dev runs),
 * minus Chromium/Electron "--switches" and our own. Unreal args use a single dash (-windowed, -ResX=1920).
 */
function forwardedArgs(argv, isPackaged) {
  const rest = argv.slice(isPackaged ? 1 : 2);
  return rest.filter((a) => typeof a === 'string' && a.length > 0 && !a.startsWith('--'));
}

/** True when Steam started this process (Steam puts these in the environment of what it launches). */
function launchedBySteam(env = process.env) {
  return !!(env.SteamAppId || env.SteamGameId || env.SteamClientLaunch);
}

/**
 * Spawns the game detached, with the launcher's environment (so SteamAppId from Steam is inherited and
 * the game's SteamAPI_Init works without steam_appid.txt). Resolves after startupCheckMs:
 *   { ok: true, child }                         still running (or exited 0, e.g. it relaunched through Steam)
 *   { ok: false, code, message }                failed to start or exited with an error right away
 */
function startGame(exe, args, { startupCheckMs = DEFAULTS.startupCheckMs, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore', env, windowsHide: false });
    } catch (e) {
      resolve({ ok: false, code: 'spawn_failed', message: `Could not start the game: ${e.message}` });
      return;
    }
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.once('error', (e) => finish({ ok: false, code: 'spawn_failed', message: `Could not start the game: ${e.code || e.message}` }));
    child.once('exit', (code) => {
      if (code === 0) finish({ ok: true, child, exitedEarly: true });
      else finish({ ok: false, code: 'game_exited', exitCode: code, message: `The game closed right after starting (exit code ${code}).` });
    });
    const timer = setTimeout(() => finish({ ok: true, child }), startupCheckMs);
  });
}

function missingGameMessage(resolved) {
  return 'THE GREAT CIRCLE was not found next to the launcher. In Steam, right-click THE GREAT CIRCLE, ' +
    'choose Properties > Installed Files > Verify integrity of game files, then try again.' +
    (resolved && resolved.tried && resolved.tried.length ? ` (Looked for: ${resolved.tried.map((p) => path.basename(p)).join(', ')} in ${resolved.root})` : '');
}

/**
 * steam:// links the page may open (launcher:open-external): only the store page of our own apps and
 * "open Steam". Never steam://run or anything else.
 */
function isAllowedSteamLink(url, appIds = []) {
  const m = /^steam:\/\/(?:store\/(\d+)|open\/main)\/?$/.exec(String(url || ''));
  if (!m) return false;
  return m[1] === undefined || appIds.map(Number).includes(Number(m[1]));
}

module.exports = { isAllowedSteamLink, CONFIG_FILE_NAME, DEFAULTS, AFTER_LAUNCH, loadLaunchConfig, resolveGameExe, forwardedArgs, launchedBySteam, startGame, missingGameMessage };
