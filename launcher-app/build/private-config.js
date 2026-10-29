// Build-time overlay for launcher-app/config.private.json.
// A non-empty ACCOUNT_SERVER_URL or BUG_REPORT_URL in the environment is
// written into the file electron-builder is about to pack, then the working
// tree is restored. The packed app reads that file at startup.
'use strict';

const fs = require('fs');
const path = require('path');
const { resolvePrivateUrls, PRIVATE_URL_KEYS } = require('../config');

const FILE_NAME = 'config.private.json';

let active = null;

function nonEmpty(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
}

function readState(file) {
  try {
    const buf = fs.readFileSync(file);
    let data = {};
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch (_) { /* invalid JSON: values are absent; keep the bytes to restore */ }
    return { existed: true, buf, data };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { existed: false, buf: null, data: {} };
    return { existed: true, buf: null, data: {}, unreadable: true };
  }
}

/**
 * Prepare config.private.json for packaging. Does not throw when the file
 * is missing. Returns { file, wrote, included, unreadable }.
 * Call restorePrivateConfig() after the packer has copied the file.
 */
function stagePrivateConfig(projectDir, env) {
  if (active) return active.result;
  const source = env || process.env;
  const file = path.join(projectDir, FILE_NAME);
  const current = readState(file);
  const next = { ...current.data };
  let wrote = false;
  if (!current.unreadable) {
    for (const key of PRIVATE_URL_KEYS) {
      const fromEnv = nonEmpty(source[key]);
      if (!fromEnv || fromEnv === nonEmpty(current.data[key])) continue;
      next[key] = fromEnv;
      wrote = true;
    }
  }
  if (wrote) fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  const resolved = resolvePrivateUrls({
    env: source,
    filePath: (current.existed || wrote) ? file : null,
  });
  const result = {
    file,
    wrote,
    included: PRIVATE_URL_KEYS.some((key) => !!resolved[key]),
    unreadable: !!current.unreadable,
  };
  active = { file, existed: current.existed, original: current.buf, wrote, result };
  return result;
}

/** Put the working tree back. Safe to call more than once. */
function restorePrivateConfig() {
  if (!active) return;
  const state = active;
  active = null;
  if (!state.wrote) return;
  if (!state.existed) {
    fs.rmSync(state.file, { force: true });
    return;
  }
  if (state.original != null) fs.writeFileSync(state.file, state.original);
}

module.exports = {
  stagePrivateConfig,
  restorePrivateConfig,
  FILE_NAME,
};
