// Launcher self-update (electron-updater, GitHub Releases) for the WEBSITE-INSTALLED build only.
// Plain Node at the top (updatePolicy) so scripts/selftest.js can test it without Electron.
//
// The Steam depot copy (WindowsNoEditor\Launcher\TGC_Launcher.exe, launchMode "exe") must NEVER update itself:
// Steam owns those files and would see them as corrupted. So self-update runs only when ALL of these hold:
//   - packaged build,
//   - launcher-config.json next to the exe exists and says launchMode "steam" (= launcher-config.web.json, NSIS build),
//   - resources\app-update.yml exists (electron-builder writes it only for the NSIS installer build),
//   - the exe is not inside a Steam library (steamapps) and Steam did not start this process.
// Unsigned builds: no publisherName / verifyUpdateCodeSignature (electron-updater skips the publisher check).
// Updates never block launch: everything is async, errors are only logged.
'use strict';
const fs = require('fs');
const path = require('path');

const FIRST_CHECK_DELAY_MS = 5 * 1000;
const RECHECK_MS = 4 * 60 * 60 * 1000;

/**
 * Decides whether this copy may update itself. Pure apart from two existsSync calls. Never throws.
 * @param {{isPackaged:boolean, launchCfg:{config:{launchMode:string}, found:boolean}, execPath:string,
 *          resourcesPath:string, launchedBySteam:boolean}} o
 * @returns {{enabled:boolean, reason:string}}
 */
function updatePolicy(o) {
  try {
    if (!o || !o.isPackaged) return { enabled: false, reason: 'not_packaged' };
    const lc = o.launchCfg || {};
    if (!lc.found) return { enabled: false, reason: 'no_launcher_config' }; // packaged default is "exe" (Steam layout)
    if (!lc.config || lc.config.launchMode !== 'steam') return { enabled: false, reason: 'steam_depot_copy' };
    if (/[\\/]steamapps[\\/]/i.test(String(o.execPath || ''))) return { enabled: false, reason: 'inside_steam_library' };
    if (o.launchedBySteam) return { enabled: false, reason: 'started_by_steam' };
    if (!o.resourcesPath || !fs.existsSync(path.join(o.resourcesPath, 'app-update.yml'))) return { enabled: false, reason: 'no_app_update_yml' };
    return { enabled: true, reason: 'web_install' };
  } catch (_) {
    return { enabled: false, reason: 'error' };
  }
}

/** Strips anything that looks like a credential before it reaches the log file. */
function scrub(s) {
  return String(s)
    .replace(/\bbearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/(authorization|bearer|token|password|passwd|secret|session)(["'\s:=]+)[^\s"',;&]+/gi, '$1$2[redacted]')
    .replace(/([?&][^=&\s]*(?:token|sig|signature|key|session)[^=&\s]*=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .slice(0, 2000);
}

/** Small append-only log in <userData>\logs\updater.log (rotated at 512 KB). */
function createLogger(logDir) {
  const file = path.join(logDir, 'updater.log');
  const write = (level, args) => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old'); } catch (_) { /* none yet */ }
      const msg = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${scrub(msg)}\n`);
    } catch (_) { /* logging must never throw */ }
  };
  return { file, info: (...a) => write('INFO', a), warn: (...a) => write('WARN', a), error: (...a) => write('ERROR', a), debug: () => {} };
}

/**
 * Starts the updater when the policy allows it. `send(status)` pushes status to the renderer.
 * Returns { policy, getStatus(), install() }. Never throws; never blocks.
 */
function startAutoUpdate({ app, policy, logDir, send, isBusy }) {
  const log = createLogger(logDir);
  let status = { state: policy.enabled ? 'idle' : 'disabled', reason: policy.reason, current: app.getVersion() };
  const set = (s) => { status = { ...status, ...s }; try { send(status); } catch (_) { /* window gone */ } };
  let autoUpdater = null;
  if (policy.enabled) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.logger = log;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true; // installs on the next normal quit if the user picks "Later"
      autoUpdater.allowPrerelease = false;
      autoUpdater.allowDowngrade = false;
      autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
      autoUpdater.on('update-not-available', () => set({ state: 'up_to_date' }));
      autoUpdater.on('update-available', (i) => set({ state: 'downloading', version: i && i.version, percent: 0 }));
      autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.floor((p && p.percent) || 0) }));
      autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', version: i && i.version }));
      autoUpdater.on('error', (e) => { log.error('update error', e); set({ state: 'error' }); });
      const check = () => { autoUpdater.checkForUpdates().catch((e) => { log.error('check failed', e); set({ state: 'error' }); }); };
      setTimeout(check, FIRST_CHECK_DELAY_MS).unref?.();
      setInterval(check, RECHECK_MS).unref?.();
      log.info(`updater on: v${app.getVersion()} (${policy.reason})`);
    } catch (e) {
      log.error('updater failed to start', e);
      autoUpdater = null;
      status = { ...status, state: 'error' };
    }
  }
  return {
    policy,
    getStatus: () => status,
    install: () => {
      if (!autoUpdater || status.state !== 'ready') return { ok: false, reason: 'not_ready' };
      if (isBusy && isBusy()) return { ok: false, reason: 'game_running' };
      log.info(`install requested: v${status.version}`);
      setImmediate(() => { try { autoUpdater.quitAndInstall(true, true); } catch (e) { log.error('quitAndInstall failed', e); } });
      return { ok: true };
    },
  };
}

module.exports = { updatePolicy, startAutoUpdate, createLogger, scrub };
