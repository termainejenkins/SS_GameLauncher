// Opt-in bug report: collect, scrub, zip. Nothing here opens a network connection
// unless sendBugReport is called, and that refuses the placeholder BUG_REPORT_URL.
// Plain Node (no Electron) so node --test can run it.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// Keep these in sync with bug-report-worker/src/limits.js.
const ZIP_MAX_BYTES = 25 * 1024 * 1024;
const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
const LOG_PRETAIL_BYTES = 32 * 1024 * 1024;
const DESC_MIN = 20;
const DESC_MAX = 2000;
const CATEGORIES = Object.freeze(['crash', 'performance', 'gameplay', 'other']);
const BUG_REPORT_URL_PLACEHOLDER = 'https://bug-report.example.invalid/api/bug-report';
const TAIL_NOTE = '[earlier log removed to fit the 25 MB report cap]\n';
const MANIFEST_RESERVE = 8192;

const ENTRY_OK = [
  /^manifest\.json$/,
  /^system-info\.json$/,
  /^logs\/TGC[^/]*\.log$/i,
  /^crashes\/[A-Za-z0-9._-]+\/CrashContext\.runtime-xml$/i,
  /^crashes\/[A-Za-z0-9._-]+\/[^/]+\.log$/i,
  /^crashes\/[A-Za-z0-9._-]+\/[^/]+\.(?:dmp|mdmp)$/i,
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** User names to scrub: the Windows account and the profile-folder segment. Never written into the report. */
function userNamesFromEnv(env = process.env) {
  const names = [];
  if (env.USERNAME) names.push(env.USERNAME);
  if (env.USER) names.push(env.USER);
  for (const key of ['USERPROFILE', 'HOME']) {
    if (!env[key]) continue;
    const seg = String(env[key]).split(/[\\/]/).filter(Boolean).pop();
    if (seg) names.push(seg);
  }
  return names;
}

function uniqueNames(userNames) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(userNames) ? userNames : [userNames];
  for (const raw of list) {
    const name = String(raw || '').trim();
    if (name.length < 1 || name === '<user>') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

/**
 * Replace the Windows user name when it is a path segment.
 * Covers backslashes, forward slashes, mixed case, C:\Users\<name>\,
 * a %USERPROFILE%-expanded path, and JSON-escaped double backslashes.
 * Prose ("Alice crashed") is left alone: the name has to sit between separators.
 */
function scrubUserInPaths(text, userNames) {
  let out = String(text == null ? '' : text);
  for (const name of uniqueNames(userNames)) {
    const re = new RegExp(`(^|[\\\\/])${escapeRegExp(name)}(?=$|[\\\\/])`, 'gi');
    out = out.replace(re, (_m, sep) => `${sep}<user>`);
  }
  return out;
}

function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/https?:\/\/(?:[\w.-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[webhook]')
    .replace(/https?:\/\/hooks\.slack\.com\/\S+/gi, '[webhook]')
    .replace(/\b(token|password|passwd|secret|api[_-]?key)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b7656\d{13}\b/g, '[steam]');
}

function cleanUserText(text, userNames) {
  return redactSecrets(scrubUserInPaths(String(text == null ? '' : text).trim(), userNames));
}

function validateDescription(text, userNames) {
  const value = cleanUserText(text, userNames);
  if (value.length < DESC_MIN) {
    return { ok: false, code: 'invalid_description', error: `Description must be at least ${DESC_MIN} characters.` };
  }
  if (value.length > DESC_MAX) {
    return { ok: false, code: 'invalid_description', error: `Description must be at most ${DESC_MAX} characters.` };
  }
  return { ok: true, value };
}

function validateCategory(category) {
  const value = String(category || '').trim().toLowerCase();
  if (!CATEGORIES.includes(value)) {
    return { ok: false, code: 'invalid_category', error: 'Pick a category: crash, performance, gameplay, or other.' };
  }
  return { ok: true, value };
}

/** Allowlist for zip entry names. Rejects .ini, Config, tokens, traversal, and anything else. */
function isAllowedReportPath(name) {
  const norm = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.includes('..') || norm.includes(':') || norm.includes('//')) return false;
  if (/(^|\/)saved\/config(\/|$)/i.test(norm)) return false;
  if (/\.ini$/i.test(norm)) return false;
  if (/(token|password|passwd|webhook|clipboard|\.env|secret)/i.test(norm)) return false;
  return ENTRY_OK.some((re) => re.test(norm));
}

function isTextName(name) {
  // CrashContext.runtime-xml is text; the last dot is not ".xml".
  return /\.(log|xml|json|txt)$/i.test(name) || /\.runtime-xml$/i.test(name);
}

function sniffEncoding(head) {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf16le';
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf8-bom';
  return 'utf8';
}

function decodeWith(buf, encoding) {
  let b = buf;
  if (encoding === 'utf16le') {
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) b = b.subarray(2);
    if (b.length % 2 === 1) b = b.subarray(0, b.length - 1);
    return b.toString('utf16le');
  }
  if (encoding === 'utf8-bom') {
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
    return b.toString('utf8');
  }
  return b.toString('utf8');
}

function encodeText(text, encoding) {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

function scrubTextBuffer(buf, userNames, encoding) {
  const enc = encoding || sniffEncoding(buf);
  return encodeText(cleanUserText(decodeWith(buf, enc), userNames), enc);
}

function tailText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - TAIL_NOTE.length);
  if (budget <= 0) return TAIL_NOTE.slice(0, maxChars);
  let start = text.length - budget;
  const nl = text.indexOf('\n', start);
  if (nl !== -1 && nl < start + 2000 && nl < text.length - 1) start = nl + 1;
  let piece = text.slice(start);
  if (TAIL_NOTE.length + piece.length > maxChars) piece = piece.slice(piece.length - budget);
  return TAIL_NOTE + piece;
}

function tailLogBuffer(buf, maxBytes, encoding) {
  const enc = encoding || 'utf8';
  const bytesPerChar = enc === 'utf16le' ? 2 : 1;
  const maxChars = Math.max(32, Math.floor(maxBytes / bytesPerChar));
  return encodeText(tailText(decodeWith(buf, enc), maxChars), enc);
}

function validateScreenshot(data, filename) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
    return { ok: false, code: 'invalid_screenshot', error: 'Screenshot must be a PNG or JPG.' };
  }
  if (buf.length > SCREENSHOT_MAX_BYTES) {
    return { ok: false, code: 'screenshot_too_large', error: 'Screenshot must be 8 MB or smaller.' };
  }
  if (buf.length < 8) return { ok: false, code: 'invalid_screenshot', error: 'Screenshot file is empty or not an image.' };
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === '.png' && !png) return { ok: false, code: 'invalid_screenshot', error: 'That file is not a PNG.' };
  if ((ext === '.jpg' || ext === '.jpeg') && !jpg) return { ok: false, code: 'invalid_screenshot', error: 'That file is not a JPEG.' };
  return {
    ok: true,
    filename: ext === '.png' ? 'screenshot.png' : 'screenshot.jpg',
    contentType: ext === '.png' ? 'image/png' : 'image/jpeg',
  };
}

function isBugReportConfigured(url) {
  if (!url || url === BUG_REPORT_URL_PLACEHOLDER) return false;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.hostname === 'example.invalid' || u.hostname.endsWith('.invalid')) return false;
  return true;
}

function hashInstallId(installId) {
  return crypto.createHash('sha256').update(String(installId), 'utf8').digest('hex');
}

function loadOrCreateInstallId(file, fsImpl = fs) {
  try {
    const cur = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (cur && typeof cur.installId === 'string' && UUID_RE.test(cur.installId)) return cur.installId;
  } catch (_) { /* create one */ }
  const installId = crypto.randomUUID();
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify({ installId }), { mode: 0o600 });
  try { fsImpl.chmodSync(tmp, 0o600); } catch (_) { /* best effort on Windows */ }
  fsImpl.renameSync(tmp, file);
  return installId;
}

function buildSystemInfo({ launcherVersion, gameBuild, gameBranch, osVersion, cpu, ramBytes, gpu }) {
  return {
    launcherVersion: launcherVersion || null,
    gameBuild: gameBuild || null,
    gameBranch: gameBranch || null,
    osVersion: osVersion || null,
    cpu: cpu || null,
    gpu: (gpu && gpu.name) || null,
    driverVersion: (gpu && gpu.driverVersion) || null,
    ramBytes: Number.isFinite(ramBytes) ? ramBytes : null,
    vramBytes: (gpu && Number.isFinite(gpu.vramBytes)) ? gpu.vramBytes : null,
  };
}

function osSummary(osMod = os) {
  const version = typeof osMod.version === 'function' ? osMod.version() : '';
  return [osMod.platform(), osMod.release(), osMod.arch(), version].filter(Boolean).join(' ');
}

function cpuSummary(osMod = os) {
  const cpus = typeof osMod.cpus === 'function' ? osMod.cpus() : [];
  if (!cpus || !cpus.length) return null;
  return `${cpus[0].model} (${cpus.length} cores)`;
}

function scrubSystemInfo(info, userNames) {
  const names = new Set(uniqueNames(userNames).map((n) => n.toLowerCase()));
  const parsed = JSON.parse(scrubUserInPaths(JSON.stringify(info), userNames));
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && names.has(v.toLowerCase())) parsed[k] = '<user>';
  }
  return parsed;
}

function oneLine(value, userNames) {
  if (value == null) return null;
  const t = cleanUserText(String(value), userNames).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return t || null;
}

function readGameIdentity(configText, logText) {
  let gameBuild = null;
  let gameBranch = null;
  if (configText) {
    try {
      const j = JSON.parse(String(configText).replace(/^\uFEFF/, ''));
      if (typeof j.gameBuild === 'string' && j.gameBuild.trim()) gameBuild = j.gameBuild.trim().slice(0, 200);
      if (typeof j.gameBranch === 'string' && j.gameBranch.trim()) gameBranch = j.gameBranch.trim().slice(0, 200);
    } catch (_) { /* config is optional */ }
  }
  if (!gameBuild && logText) {
    const m = String(logText).match(/LogInit:\s*Build:\s*([^\r\n]+)/i);
    if (m) gameBuild = m[1].trim().slice(0, 200);
  }
  return { gameBuild, gameBranch };
}

function listDir(dir, fsImpl) {
  try { return fsImpl.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function findGameLog(logsDir, fsImpl) {
  const exact = path.join(logsDir, 'TGC.log');
  try {
    if (fsImpl.statSync(exact).isFile()) return exact;
  } catch (_) { /* fall through */ }
  let best = null;
  let bestM = -1;
  for (const d of listDir(logsDir, fsImpl)) {
    if (!d.isFile() || !/^TGC.*\.log$/i.test(d.name)) continue;
    const full = path.join(logsDir, d.name);
    let st;
    try { st = fsImpl.statSync(full); } catch (_) { continue; }
    if (st.mtimeMs >= bestM) { bestM = st.mtimeMs; best = full; }
  }
  return best;
}

function newestCrashDir(crashesDir, fsImpl) {
  let best = null;
  let bestM = -1;
  for (const d of listDir(crashesDir, fsImpl)) {
    if (!d.isDirectory()) continue;
    const full = path.join(crashesDir, d.name);
    let st;
    try { st = fsImpl.statSync(full); } catch (_) { continue; }
    if (st.mtimeMs >= bestM) { bestM = st.mtimeMs; best = full; }
  }
  return best;
}

function sanitizeFolder(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return s || 'crash';
}

function readHead(filePath, maxBytes, fsImpl) {
  const st = fsImpl.statSync(filePath);
  const len = Math.min(st.size, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = fsImpl.openSync(filePath, 'r');
  try {
    let off = 0;
    while (off < len) {
      const n = fsImpl.readSync(fd, buf, off, len - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { buf: off === len ? buf : buf.subarray(0, off), size: st.size };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function readLogTail(filePath, maxBytes, fsImpl) {
  const st = fsImpl.statSync(filePath);
  const headLen = Math.min(4, st.size);
  const head = Buffer.alloc(headLen);
  const len = Math.min(st.size, maxBytes);
  let start = st.size - len;
  const fd = fsImpl.openSync(filePath, 'r');
  try {
    if (headLen) fsImpl.readSync(fd, head, 0, headLen, 0);
    const encoding = sniffEncoding(head);
    if (encoding === 'utf16le' && start % 2 === 1) start += 1;
    const take = st.size - start;
    const buf = Buffer.alloc(take);
    let off = 0;
    while (off < take) {
      const n = fsImpl.readSync(fd, buf, off, take - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return { buf: off === take ? buf : buf.subarray(0, off), encoding, truncated: st.size > maxBytes, size: st.size };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function safeDisplayName(name) {
  const base = path.basename(String(name || ''));
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(base)) return 'a file';
  return base;
}

function collectCrashEntries(crashDir, fsImpl, userNames) {
  const folder = sanitizeFolder(path.basename(crashDir));
  const entries = [];
  const omitted = [];
  for (const d of listDir(crashDir, fsImpl)) {
    if (!d.isFile()) continue;
    const rel = `crashes/${folder}/${d.name}`;
    if (!isAllowedReportPath(rel)) {
      omitted.push({ name: safeDisplayName(d.name), reason: 'not an allowed crash file' });
      continue;
    }
    const full = path.join(crashDir, d.name);
    let st;
    try { st = fsImpl.statSync(full); } catch (_) { continue; }
    if (st.size > ZIP_MAX_BYTES) {
      omitted.push({ name: safeDisplayName(d.name), reason: 'larger than the 25 MB cap' });
      continue;
    }
    let data = fsImpl.readFileSync(full);
    const text = isTextName(d.name);
    if (text) data = scrubTextBuffer(data, userNames);
    entries.push({
      name: rel,
      data,
      encoding: text ? sniffEncoding(data) : null,
      compressible: text,
      taillable: text,
      required: false,
    });
  }
  return { entries, omitted };
}

// --- zip (store, deflate for smaller text). No extra dependency. ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const year = Math.max(1980, d.getFullYear());
  const datev = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: datev };
}

function buildZip(entries, date) {
  const { time, date: dosDate } = dosDateTime(date);
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(raw);
    let method = 0;
    let payload = raw;
    if (entry.compressible !== false && raw.length > 0 && raw.length <= 8 * 1024 * 1024) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    parts.push(local, payload);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

function readZipEntries(buf) {
  const entries = [];
  let p = 0;
  while (p + 30 <= buf.length) {
    const sig = buf.readUInt32LE(p);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(p + 8);
    const comp = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const dataStart = p + 30 + nameLen + extra;
    const payload = buf.subarray(dataStart, dataStart + comp);
    const raw = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    entries.push({ name, data: raw });
    p = dataStart + comp;
  }
  return entries;
}

function shrinkEntries(list, maxBytes) {
  const dropped = [];
  let tailed = false;
  let guard = 0;
  const zipOf = () => buildZip(list);
  let zip = zipOf();
  while (zip.length > maxBytes && guard++ < 32) {
    const log = list.find((e) => e.taillable && e.data.length > 128);
    if (!log) break;
    const ratio = maxBytes / zip.length;
    let next = Math.floor(log.data.length * Math.min(ratio, 0.85));
    if (next >= log.data.length) next = Math.floor(log.data.length * 0.7);
    next = Math.max(64, next);
    const before = log.data.length;
    log.data = tailLogBuffer(log.data, next, log.encoding || 'utf8');
    if (log.data.length >= before) {
      log.data = tailLogBuffer(log.data, Math.max(64, Math.floor(before / 2)), log.encoding || 'utf8');
    }
    if (log.data.length >= before) break;
    log.tailed = true;
    tailed = true;
    zip = zipOf();
  }
  while (zip.length > maxBytes) {
    const idx = list.findIndex((e) => !e.required && /\.(dmp|mdmp)$/i.test(e.name));
    if (idx === -1) break;
    dropped.push(list[idx].name);
    list.splice(idx, 1);
    zip = zipOf();
  }
  return { zip, tailed, dropped };
}

function packReport(fileEntries, notes, omitted, maxBytes) {
  const list = fileEntries
    .filter((e) => isAllowedReportPath(e.name))
    .map((e) => ({
      name: e.name,
      data: Buffer.isBuffer(e.data) ? Buffer.from(e.data) : Buffer.from(e.data),
      encoding: e.encoding || null,
      compressible: e.compressible !== false,
      taillable: !!e.taillable,
      required: !!e.required,
    }));
  const budget = Math.max(1024, maxBytes - MANIFEST_RESERVE);
  let shrunk = shrinkEntries(list, budget);
  if (shrunk.zip.length > budget && shrunk.zip.length > maxBytes) {
    const err = new Error('over_cap');
    err.code = 'over_cap';
    throw err;
  }
  const finalNotes = notes.slice();
  if (shrunk.tailed) finalNotes.push('The log was shortened so the zip stays within 25 MB.');
  if (shrunk.dropped.length) finalNotes.push(`Left out to fit the 25 MB cap: ${shrunk.dropped.map(safeDisplayName).join(', ')}.`);
  const manifest = {
    files: list.map((e) => e.name),
    omitted,
    notes: finalNotes,
  };
  const manifestEntry = {
    name: 'manifest.json',
    data: Buffer.from(JSON.stringify(manifest), 'utf8'),
    compressible: true,
    taillable: false,
    required: true,
  };
  let packed = [manifestEntry, ...list];
  let zip = buildZip(packed);
  if (zip.length > maxBytes) {
    shrunk = shrinkEntries(list, Math.max(1024, maxBytes - manifestEntry.data.length - 512));
    manifest.files = list.map((e) => e.name);
    manifest.notes = finalNotes;
    manifestEntry.data = Buffer.from(JSON.stringify(manifest), 'utf8');
    packed = [manifestEntry, ...list];
    zip = buildZip(packed);
  }
  if (zip.length > maxBytes) {
    const err = new Error('over_cap');
    err.code = 'over_cap';
    throw err;
  }
  return { zip, entries: packed, notes: finalNotes, tailed: shrunk.tailed, dropped: shrunk.dropped };
}

function prepareBugReport(options = {}) {
  const fsImpl = options.fs || fs;
  const userNames = options.userNames || [];
  const maxZipBytes = Number.isFinite(options.maxZipBytes) ? options.maxZipBytes : ZIP_MAX_BYTES;
  const forSend = !!options.forSend;
  const attachLogs = options.attachLogs !== false;
  const attachSystemInfo = options.attachSystemInfo !== false;
  const desc = validateDescription(options.description || '', userNames);
  const cat = validateCategory(options.category || '');
  if (forSend && !desc.ok) return { ok: false, code: desc.code, error: desc.error };
  if (forSend && !cat.ok) return { ok: false, code: cat.code, error: cat.error };

  const notes = [];
  const omitted = [];
  const fileEntries = [];
  let gameBuild = options.gameBuild || null;
  let gameBranch = options.gameBranch || null;
  let gpuName = options.gpu && options.gpu.name ? options.gpu.name : null;

  if (attachSystemInfo && options.configPath) {
    let configText = '';
    try { configText = fsImpl.readFileSync(options.configPath, 'utf8'); } catch (_) { configText = ''; }
    const fromCfg = readGameIdentity(configText, '');
    if (!gameBuild && fromCfg.gameBuild) gameBuild = fromCfg.gameBuild;
    if (!gameBranch && fromCfg.gameBranch) gameBranch = fromCfg.gameBranch;
  }

  const projectDir = options.projectDir;
  const localAppData = options.localAppData;
  const savedRoot = (localAppData && projectDir) ? path.join(localAppData, projectDir, 'Saved') : '';

  if ((attachLogs || attachSystemInfo) && savedRoot) {
    const logPath = findGameLog(path.join(savedRoot, 'Logs'), fsImpl);
    if (logPath) {
      try {
        const head = readHead(logPath, 128 * 1024, fsImpl);
        const encoding = sniffEncoding(head.buf);
        const headText = cleanUserText(decodeWith(head.buf, encoding), userNames);
        const fromLog = readGameIdentity('', headText);
        if (!gameBuild && fromLog.gameBuild) gameBuild = fromLog.gameBuild;
      } catch (_) { /* header is optional */ }
    }
    if (attachLogs) {
      if (!logPath) {
        notes.push(`No TGC.log under %LOCALAPPDATA%\\${projectDir}\\Saved\\Logs. Confirm GAME_SAVED_PROJECT_DIR.`);
      } else {
        try {
          const read = readLogTail(logPath, Math.min(LOG_PRETAIL_BYTES, maxZipBytes), fsImpl);
          let text = cleanUserText(decodeWith(read.buf, read.encoding), userNames);
          if (read.truncated) {
            text = TAIL_NOTE + text;
            notes.push('TGC.log was shortened to its newest part before packing.');
          }
          const base = path.basename(logPath);
          const rel = `logs/${base}`;
          if (isAllowedReportPath(rel)) {
            fileEntries.push({
              name: rel,
              data: encodeText(text, read.encoding),
              encoding: read.encoding,
              compressible: true,
              taillable: true,
              required: false,
            });
          }
        } catch (_) {
          notes.push('The game log could not be read.');
        }
      }
      const crashDir = newestCrashDir(path.join(savedRoot, 'Crashes'), fsImpl);
      if (crashDir) {
        try {
          const crash = collectCrashEntries(crashDir, fsImpl, userNames);
          fileEntries.push(...crash.entries);
          omitted.push(...crash.omitted);
          if (!crash.entries.length) notes.push('The newest crash folder had no files we are allowed to attach.');
        } catch (_) {
          notes.push('The crash folder could not be read.');
        }
      }
    }
  } else if (attachLogs && !savedRoot) {
    notes.push('Game logs are read from %LOCALAPPDATA% on Windows. None were attached here.');
  }

  gameBuild = oneLine(gameBuild, userNames);
  gameBranch = oneLine(gameBranch, userNames);
  gpuName = oneLine(gpuName, userNames);

  if (attachSystemInfo) {
    const osMod = options.os || os;
    const info = scrubSystemInfo(buildSystemInfo({
      launcherVersion: options.launcherVersion,
      gameBuild,
      gameBranch,
      osVersion: options.osVersion || osSummary(osMod),
      cpu: options.cpu || cpuSummary(osMod),
      ramBytes: Number.isFinite(options.ramBytes) ? options.ramBytes : osMod.totalmem(),
      gpu: options.gpu ? { name: gpuName, driverVersion: oneLine(options.gpu.driverVersion, userNames), vramBytes: options.gpu.vramBytes } : null,
    }), userNames);
    fileEntries.push({
      name: 'system-info.json',
      data: Buffer.from(`${JSON.stringify(info, null, 2)}\n`, 'utf8'),
      encoding: 'utf8',
      compressible: true,
      taillable: false,
      required: true,
    });
  }

  let screenshot = null;
  if (options.screenshot && options.screenshot.data) {
    const check = validateScreenshot(options.screenshot.data, options.screenshot.filename || 'screenshot.png');
    if (!check.ok) {
      if (forSend) return { ok: false, code: check.code, error: check.error };
      notes.push(check.error);
    } else {
      const data = Buffer.isBuffer(options.screenshot.data) ? options.screenshot.data : Buffer.from(options.screenshot.data);
      screenshot = { filename: check.filename, contentType: check.contentType, data, bytes: data.length };
    }
  }

  let packed;
  try {
    packed = packReport(fileEntries, notes, omitted, maxZipBytes);
  } catch (e) {
    if (e && e.code === 'over_cap') {
      return { ok: false, code: 'over_cap', error: 'The report is over 25 MB even after shortening logs.' };
    }
    throw e;
  }

  const zipEntries = packed.entries
    .filter((e) => e.name !== 'manifest.json')
    .map((e) => ({ name: e.name, bytes: e.data.length }));
  const totalBytes = packed.zip.length + (screenshot ? screenshot.bytes : 0);
  const preview = {
    ok: true,
    zipEntries,
    zipBytes: packed.zip.length,
    screenshot: screenshot ? { name: screenshot.filename, bytes: screenshot.bytes } : null,
    totalBytes,
    notes: packed.notes,
    configured: isBugReportConfigured(options.uploadUrl),
    descriptionOk: desc.ok,
    descriptionError: desc.ok ? null : desc.error,
    category: cat.ok ? cat.value : null,
  };
  if (!forSend) return preview;
  return {
    ...preview,
    zip: packed.zip,
    screenshotFile: screenshot,
    description: desc.value,
    category: cat.value,
    gameBuild: attachSystemInfo ? gameBuild : null,
    gpu: attachSystemInfo ? gpuName : null,
  };
}

function buildMultipartBody({ fields, files, boundary }) {
  const b = boundary || `----TgcBugReport${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    chunks.push(Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ));
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ));
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`, 'utf8'));
  return { boundary: b, body: Buffer.concat(chunks) };
}

function formatRetry(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function interpretUploadResponse(status, headers, text) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  let body = null;
  try { body = JSON.parse(text || ''); } catch (_) { body = null; }
  if (status === 429) {
    const retry = parseInt(h['retry-after'], 10);
    const retryAfter = Number.isFinite(retry) ? retry : null;
    const message = retryAfter
      ? `Too many bug reports today (limit reached). Please try again in ${formatRetry(retryAfter)}.`
      : 'Too many bug reports today (limit reached). Please try again tomorrow.';
    return { ok: false, status, code: 'rate_limited', retryAfter, message };
  }
  if (status >= 200 && status < 300) {
    return { ok: true, status, id: body && body.id, message: 'Bug report sent. Thank you.' };
  }
  if (status === 413) {
    return { ok: false, status, code: 'too_large', message: 'The report is too large. Try again without the screenshot, or with logs turned off.' };
  }
  const serverMsg = body && (body.message || body.error);
  const message = serverMsg
    ? `The server rejected the report: ${String(serverMsg).slice(0, 240)}`
    : `The server rejected the report (${status}).`;
  return { ok: false, status, code: 'rejected', message };
}

function postBuffer(url, { headers, body, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { reject(new Error('bad_url')); return; }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
      reject(new Error('refused'));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n <= 8192) chunks.push(c);
      });
      res.on('end', () => {
        const h = {};
        for (const [k, v] of Object.entries(res.headers)) h[String(k).toLowerCase()] = v;
        resolve({ status: res.statusCode, headers: h, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function sendBugReport(options = {}) {
  const prepared = prepareBugReport({ ...options, forSend: true });
  if (!prepared.ok) return { ok: false, code: prepared.code || 'invalid', message: prepared.error };
  const url = options.uploadUrl;
  if (!isBugReportConfigured(url)) {
    return {
      ok: false,
      code: 'not_configured',
      message: 'Bug reports are not switched on yet. BUG_REPORT_URL is still the placeholder, so nothing was sent.',
    };
  }
  if (!options.settingsPath) {
    return { ok: false, code: 'invalid', message: 'Bug report settings path is missing. Nothing was sent.' };
  }
  const installId = loadOrCreateInstallId(options.settingsPath, options.fs || fs);
  const installHash = hashInstallId(installId);
  const fields = {
    category: prepared.category,
    description: prepared.description,
    installId: installHash,
    launcherVersion: options.launcherVersion || '',
    gameBuild: prepared.gameBuild || '',
    gpu: prepared.gpu || '',
  };
  const files = [{ field: 'zip', filename: 'report.zip', contentType: 'application/zip', data: prepared.zip }];
  if (prepared.screenshotFile) {
    files.push({
      field: 'screenshot',
      filename: prepared.screenshotFile.filename,
      contentType: prepared.screenshotFile.contentType,
      data: prepared.screenshotFile.data,
    });
  }
  const { boundary, body } = buildMultipartBody({ fields, files });
  const post = options.postImpl || postBuffer;
  let res;
  try {
    res = await post(url, {
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      },
      body,
    });
  } catch (_) {
    return { ok: false, code: 'network', message: 'Could not reach the bug report server. Check your connection and try again. Nothing else was sent.' };
  }
  const interpreted = interpretUploadResponse(res.status, res.headers, res.text);
  // Never return the raw install id. The hash is already inside the body that was posted.
  return interpreted;
}

module.exports = {
  ZIP_MAX_BYTES,
  SCREENSHOT_MAX_BYTES,
  DESC_MIN,
  DESC_MAX,
  CATEGORIES,
  BUG_REPORT_URL_PLACEHOLDER,
  userNamesFromEnv,
  scrubUserInPaths,
  redactSecrets,
  cleanUserText,
  validateDescription,
  validateCategory,
  isAllowedReportPath,
  validateScreenshot,
  isBugReportConfigured,
  hashInstallId,
  loadOrCreateInstallId,
  buildSystemInfo,
  scrubSystemInfo,
  readGameIdentity,
  buildZip,
  readZipEntries,
  prepareBugReport,
  buildMultipartBody,
  interpretUploadResponse,
  sendBugReport,
};
