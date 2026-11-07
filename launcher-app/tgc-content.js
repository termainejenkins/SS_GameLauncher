// Lore catalog and photo index for THE GREAT CIRCLE. Read-only.
// Proposed file shapes, not the game writer. Parsing stays here.
// Images are not read by the list functions. Callers ask for one file at a time.
// The data directory is the same folder as launcher_snapshot.json (resolveDataDir).
'use strict';

const crypto = require('crypto');
const path = require('path');
const { readRootedFile } = require('./rooted-read');

const LORE_CATALOG_FILE = 'lore_catalog.json';
const PHOTO_CAP = 200;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const LORE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const LORE_CATALOG_MAX_BYTES = 256 * 1024;
const PHOTO_INDEX_MAX_BYTES = 256 * 1024;
const LORE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLAIN_PNG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png$/i;

function snap() {
  return require('./snapshot');
}

function isPlainPngName(file) {
  if (typeof file !== 'string') return false;
  if (file !== path.basename(file)) return false;
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return false;
  if (path.isAbsolute(file)) return false;
  return PLAIN_PNG_RE.test(file);
}

function isSafeLoreId(id) {
  return typeof id === 'string' && LORE_ID_RE.test(id);
}

/** Relative PNG under the catalog directory: safe segments only, no .. */
function isSafeRelativePng(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 180) return false;
  if (path.isAbsolute(rel) || rel.includes('\\') || rel.includes('..')) return false;
  const parts = rel.split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) return false;
  const last = parts[parts.length - 1];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(last)) return false;
  return parts.slice(0, -1).every((part) => /^[A-Za-z0-9_-]{1,64}$/.test(part));
}

function shortText(value, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function parseLoreCatalog(raw) {
  let data;
  try {
    data = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  } catch (_) {
    return { ok: false, state: 'corrupt', entries: [] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, state: 'corrupt', entries: [] };
  if (data.version != null && data.version !== 1) return { ok: false, state: 'unknown', entries: [] };
  if (!Array.isArray(data.entries)) return { ok: false, state: 'corrupt', entries: [] };
  const entries = [];
  const seen = new Set();
  for (const row of data.entries) {
    if (!row || typeof row !== 'object') continue;
    if (!isSafeLoreId(row.id) || seen.has(row.id)) continue;
    const title = shortText(row.title, 80);
    const category = shortText(row.category, 40);
    const text = shortText(row.text, 4000);
    if (!title || !category || !text) continue;
    seen.add(row.id);
    const image = isSafeRelativePng(row.image) ? row.image : null;
    entries.push({ id: row.id, title, category, text, image });
    if (entries.length >= 500) break;
  }
  return { ok: true, state: 'ok', entries };
}

/**
 * Full text and image only for ids that are both in the catalog and in loreUnlocked.
 * Unknown unlock ids are ignored. Locked rows keep the category and replace the title with ???.
 */
function presentLore(entries, unlockedIds) {
  const unlocked = new Set(Array.isArray(unlockedIds) ? unlockedIds.filter(isSafeLoreId) : []);
  const known = new Set(entries.map((entry) => entry.id));
  const ignored = [];
  for (const id of unlocked) {
    if (!known.has(id)) ignored.push(id);
  }
  const byCategory = new Map();
  let unlockedCount = 0;
  for (const entry of entries) {
    const open = unlocked.has(entry.id);
    if (open) unlockedCount += 1;
    const row = open
      ? { id: entry.id, locked: false, title: entry.title, category: entry.category, text: entry.text, image: entry.image }
      : { id: entry.id, locked: true, title: '???', category: entry.category, text: null, image: null };
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category).push(row);
  }
  return {
    unlocked: unlockedCount,
    total: entries.length,
    ignored,
    categories: [...byCategory.entries()].map(([category, rows]) => ({ category, entries: rows })),
  };
}

function parsePhotoIndex(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, state: 'corrupt', photos: [], truncated: false };
  if (data.version != null && data.version !== 1) return { ok: false, state: 'unknown', photos: [], truncated: false };
  if (!Array.isArray(data.photos)) return { ok: false, state: 'corrupt', photos: [], truncated: false };
  const photos = [];
  let truncated = false;
  for (const raw of data.photos) {
    if (!raw || typeof raw !== 'object') continue;
    if (!isPlainPngName(raw.file)) continue;
    if (photos.length >= PHOTO_CAP) {
      truncated = true;
      break;
    }
    const worldKey = typeof raw.worldKey === 'string' ? raw.worldKey : '';
    const keyOk = worldKey ? snap().isSafeWorldKey(worldKey) : false;
    const x = typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : null;
    const y = typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : null;
    photos.push({
      file: raw.file,
      unixTime: Number.isInteger(raw.unixTime) ? raw.unixTime : null,
      caption: shortText(raw.caption, 120),
      worldKey: keyOk ? worldKey : null,
      x,
      y,
      subjectId: isSafeLoreId(raw.subjectId) ? raw.subjectId : null,
      weather: shortText(raw.weather, 40),
      timeOfDay: shortText(raw.timeOfDay, 40),
    });
  }
  return { ok: true, state: 'ok', photos, truncated };
}

async function readCappedJson(rootDir, file, maxBytes) {
  const read = await readRootedFile(rootDir, file, { maxBytes });
  if (!read.ok) return read;
  try {
    return { ok: true, data: JSON.parse(read.data.toString('utf8').replace(/^\uFEFF/, '')), size: read.size };
  } catch (_) {
    return { ok: false, reason: 'corrupt' };
  }
}

async function snapshotSummary(dir) {
  const parsed = await snap().readSnapshotFile(path.join(dir, snap().SNAPSHOT_FILE_NAME), { rootDir: dir, now: Math.floor(Date.now() / 1000) });
  return parsed.ok ? parsed.summary : null;
}

async function loadLoreLibrary(opts = {}) {
  const gate = snap().resolveDataDir(opts);
  if (!gate.enabled) return { enabled: false, state: 'disabled', unlocked: 0, total: 0, categories: [], ignored: [] };
  const read = await readCappedJson(gate.dir, path.join(gate.dir, LORE_CATALOG_FILE), LORE_CATALOG_MAX_BYTES);
  if (!read.ok) {
    const state = read.reason === 'missing' ? 'missing' : (read.reason === 'oversize' ? 'oversize' : 'unreadable');
    return { enabled: true, state, unlocked: 0, total: 0, categories: [], ignored: [] };
  }
  const parsed = parseLoreCatalog(JSON.stringify(read.data));
  if (!parsed.ok) return { enabled: true, state: parsed.state, unlocked: 0, total: 0, categories: [], ignored: [] };
  const summary = await snapshotSummary(gate.dir);
  const unlockedIds = summary && summary.account ? summary.account.loreUnlocked : [];
  return { enabled: true, state: 'ok', ...presentLore(parsed.entries, unlockedIds) };
}

async function readLoreImage(opts, id) {
  if (!isSafeLoreId(id)) return { ok: false, reason: 'bad_id' };
  const gate = snap().resolveDataDir(opts);
  if (!gate.enabled) return { ok: false, reason: 'disabled' };
  const read = await readCappedJson(gate.dir, path.join(gate.dir, LORE_CATALOG_FILE), LORE_CATALOG_MAX_BYTES);
  if (!read.ok) return { ok: false, reason: read.reason };
  const parsed = parseLoreCatalog(JSON.stringify(read.data));
  if (!parsed.ok) return { ok: false, reason: parsed.state };
  const summary = await snapshotSummary(gate.dir);
  const unlocked = new Set(summary && summary.account ? summary.account.loreUnlocked : []);
  const entry = parsed.entries.find((row) => row.id === id);
  if (!entry || !unlocked.has(id) || !entry.image) return { ok: false, reason: 'locked' };
  const file = path.resolve(gate.dir, entry.image);
  const png = await readRootedFile(gate.dir, file, { maxBytes: LORE_IMAGE_MAX_BYTES });
  if (!png.ok || png.data.length < 8 || png.data[0] !== 0x89 || png.data.toString('ascii', 1, 4) !== 'PNG') {
    return { ok: false, reason: png.ok ? 'bad_package' : png.reason };
  }
  return { ok: true, dataUrl: `data:image/png;base64,${png.data.toString('base64')}` };
}

async function photoPin(dir, photo) {
  if (!photo.worldKey || photo.x === null || photo.y === null) return null;
  const names = snap().mapPackageNames(photo.worldKey);
  if (!names) return null;
  const read = await readCappedJson(dir, path.join(dir, names.json), snap().MAP_JSON_MAX_BYTES);
  if (!read.ok || !read.data || !Array.isArray(read.data.boundsMin) || !Array.isArray(read.data.boundsMax)) return null;
  return snap().worldToMapPixel(photo.x, photo.y, {
    boundsMin: read.data.boundsMin,
    boundsMax: read.data.boundsMax,
    imageW: read.data.imageW,
    imageH: read.data.imageH,
    yAxis: read.data.yAxis,
  });
}

const photoIndexCache = new Map();

async function loadPhotoIndex(opts, characterId) {
  const empty = { enabled: true, state: 'none', photos: [], truncated: false, photoCount: null };
  const gate = snap().resolveDataDir(opts);
  if (!gate.enabled) return { ...empty, enabled: false, state: 'disabled' };
  const summary = await snapshotSummary(gate.dir);
  const character = summary && summary.characters.find((row) => row.characterId === characterId);
  if (!character || !character.photoIndexPath) return { ...empty, photoCount: character ? character.photoCount : null };
  const indexPath = path.resolve(gate.dir, character.photoIndexPath);
  const read = await readCappedJson(gate.dir, indexPath, PHOTO_INDEX_MAX_BYTES);
  if (!read.ok) {
    const state = read.reason === 'missing' ? 'missing' : (read.reason === 'oversize' ? 'oversize' : 'unreadable');
    return { ...empty, state, photoCount: character.photoCount };
  }
  const cacheKey = `${gate.dir}\0${characterId}\0${crypto.createHash('sha256').update(JSON.stringify(read.data)).digest('hex')}`;
  const hit = photoIndexCache.get(cacheKey);
  if (hit) return hit;
  const parsed = parsePhotoIndex(read.data);
  if (!parsed.ok) return { ...empty, state: parsed.state, photoCount: character.photoCount };
  const photos = [];
  const folder = path.dirname(indexPath);
  for (const photo of parsed.photos) {
    const file = path.join(folder, photo.file);
    const stat = await readRootedFile(gate.dir, file, { maxBytes: PHOTO_MAX_BYTES, statOnly: true });
    if (!stat.ok) continue;
    photos.push({ ...photo, pin: await photoPin(gate.dir, photo) });
  }
  const value = {
    enabled: true,
    state: 'ok',
    photos,
    truncated: parsed.truncated,
    photoCount: character.photoCount,
  };
  photoIndexCache.set(cacheKey, value);
  return value;
}

async function readPhotoFile(opts, characterId, file) {
  if (!isPlainPngName(file)) return { ok: false, reason: 'bad_file' };
  const listed = await loadPhotoIndex(opts, characterId);
  if (!listed.enabled) return { ok: false, reason: 'disabled' };
  const photo = (listed.photos || []).find((row) => row.file === file);
  if (!photo) return { ok: false, reason: 'missing' };
  const gate = snap().resolveDataDir(opts);
  const summary = await snapshotSummary(gate.dir);
  const character = summary && summary.characters.find((row) => row.characterId === characterId);
  if (!character || !character.photoIndexPath) return { ok: false, reason: 'missing' };
  const pngPath = path.join(path.dirname(path.resolve(gate.dir, character.photoIndexPath)), file);
  const png = await readRootedFile(gate.dir, pngPath, { maxBytes: PHOTO_MAX_BYTES });
  if (!png.ok || png.data.length < 8 || png.data[0] !== 0x89 || png.data.toString('ascii', 1, 4) !== 'PNG') {
    return { ok: false, reason: png.ok ? 'bad_package' : png.reason };
  }
  return { ok: true, dataUrl: `data:image/png;base64,${png.data.toString('base64')}` };
}

module.exports = {
  LORE_CATALOG_FILE,
  PHOTO_CAP,
  PHOTO_MAX_BYTES,
  isPlainPngName,
  isSafeLoreId,
  isSafeRelativePng,
  parseLoreCatalog,
  presentLore,
  parsePhotoIndex,
  loadLoreLibrary,
  readLoreImage,
  loadPhotoIndex,
  readPhotoFile,
};
