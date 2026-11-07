// Phase 1 local profile summary for THE GREAT CIRCLE.
// The game (not built yet) writes launcher_snapshot.json next to entitlement.token.
// This module only reads. It never repairs the file and never uploads it.
//
// A packaged build does not read the file. The privacy line on sentientsolutions.dev
// has to be live before any release that does (spec §6). Unpackaged runs read only
// when SS_TGC_SNAPSHOT=1, or when SS_TGC_SNAPSHOT_DIR points at a fixture folder.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cfg = require('./config');

const SCHEMA_VERSION = 1;
const SNAPSHOT_FILE_NAME = 'launcher_snapshot.json';
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const STALE_AFTER_SEC = 30 * 24 * 60 * 60;
const HISTORY_CAP = 32;
const CHARACTER_CAP = 50;
const STRING_MAX = 64;
const WORLD_KEY_MAX = 64;
const WORLD_KEY_RE = /^[A-Za-z0-9_]+$/;
const MAP_IMAGE_MAX_PX = 4096;
const MAP_PNG_MAX_BYTES = 12 * 1024 * 1024;
const FOG_RESOLUTION_MAX = 256;

const MESSAGES = Object.freeze({
  missing: 'Play once to see your characters.',
  damaged: 'The profile summary file is damaged. Play once to see your characters.',
  unreadable: 'The profile summary could not be read.',
  unknownSchema: 'This profile was written by a newer game. Update the launcher.',
  oversize: 'The profile summary is too large to show (over 32 KB).',
  stale: 'This summary was written more than 30 days ago.',
  disabled: 'Profile summary is off in this build.',
  noMap: 'No map data yet.',
  pinOnlyFog: 'No discovered-area fog for this character.',
  pinOnlyDead: 'Graveyard characters show a pin only.',
  pinOnlyBounds: 'The map was recaptured, so fog is hidden. The pin is still shown.',
  emptyHistory: 'No history yet.',
  emptyRoster: 'No characters in this summary yet.',
});

function snapshotReadAllowed({ isPackaged, env } = {}) {
  // Release builds stay off even if a dev variable is set in the environment.
  if (isPackaged) return false;
  const source = env || {};
  if (source.SS_TGC_SNAPSHOT === '1') return true;
  return typeof source.SS_TGC_SNAPSHOT_DIR === 'string' && source.SS_TGC_SNAPSHOT_DIR.trim() !== '';
}

function isSafeWorldKey(key) {
  return typeof key === 'string'
    && key.length >= 1
    && key.length <= WORLD_KEY_MAX
    && WORLD_KEY_RE.test(key);
}

/** Basename only. Returns null when the key must not become a filename. */
function mapPackageNames(worldKey) {
  if (!isSafeWorldKey(worldKey)) return null;
  return {
    png: `tgc_worldmap_${worldKey}.png`,
    json: `tgc_worldmap_${worldKey}.json`,
  };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function intOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function shortString(value, max = STRING_MAX) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function pickInt(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  return intOrNull(obj[key]);
}

function pickFinite(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  return finite(obj[key]);
}

/**
 * One transform for the pin and for fog cell centers.
 * Proven for the in-game widget (image right = world Y, image top = world +X).
 * A flipped export sets yAxis to worldXIsImageBottom / unrealUpIsImageBottom;
 * that flip stays in this function.
 * mapMeta: { boundsMin:[x,y], boundsMax:[x,y], imageW, imageH, yAxis? }
 * Returns pixel {u, v} or null when the bounds cannot be used.
 */
function worldToMapPixel(x, y, mapMeta) {
  if (!mapMeta || typeof mapMeta !== 'object') return null;
  const minX = finite(mapMeta.boundsMin && mapMeta.boundsMin[0]);
  const minY = finite(mapMeta.boundsMin && mapMeta.boundsMin[1]);
  const maxX = finite(mapMeta.boundsMax && mapMeta.boundsMax[0]);
  const maxY = finite(mapMeta.boundsMax && mapMeta.boundsMax[1]);
  const imageW = finite(mapMeta.imageW);
  const imageH = finite(mapMeta.imageH);
  const worldX = finite(x);
  const worldY = finite(y);
  if (minX === null || minY === null || maxX === null || maxY === null) return null;
  if (imageW === null || imageH === null || worldX === null || worldY === null) return null;
  if (!(maxY > minY) || !(maxX > minX) || !(imageW > 0) || !(imageH > 0)) return null;
  const u = (worldY - minY) / (maxY - minY) * imageW;
  let v = (maxX - worldX) / (maxX - minX) * imageH;
  const axis = typeof mapMeta.yAxis === 'string' && mapMeta.yAxis ? mapMeta.yAxis : 'worldXIsImageTop';
  if (axis === 'worldXIsImageBottom' || axis === 'unrealUpIsImageBottom') v = imageH - v;
  return { u, v };
}

/**
 * Fog bits: cell index i = X * resolution + Y, bit i is bytes[i/8] & (1 << (i%8)).
 * 1 = discovered. Returns { ok, cells:[{x, y}], count } or { ok:false }.
 */
function decodeFogBits(bitsB64, resolution) {
  const res = intOrNull(resolution);
  if (res === null || res < 1 || res > FOG_RESOLUTION_MAX) return { ok: false, reason: 'bad_resolution' };
  if (typeof bitsB64 !== 'string' || !bitsB64.trim()) return { ok: false, reason: 'bad_bits' };
  const expected = Math.ceil((res * res) / 8);
  let bytes;
  try {
    bytes = Buffer.from(bitsB64, 'base64');
  } catch (_) {
    return { ok: false, reason: 'bad_bits' };
  }
  if (bytes.length !== expected) return { ok: false, reason: 'bad_bits_length' };
  const cells = [];
  const total = res * res;
  for (let i = 0; i < total; i++) {
    const on = (bytes[i >> 3] & (1 << (i & 7))) !== 0;
    if (!on) continue;
    cells.push({ x: Math.floor(i / res), y: i % res });
  }
  return { ok: true, cells, count: cells.length };
}

/** Image-space rect of fog cell (X, Y). Uses worldToMapPixel for both corners. */
function fogCellRect(cellX, cellY, resolution, mapMeta) {
  const res = intOrNull(resolution);
  const xIndex = intOrNull(cellX);
  const yIndex = intOrNull(cellY);
  if (res === null || xIndex === null || yIndex === null || res < 1) return null;
  if (!mapMeta) return null;
  const minX = finite(mapMeta.boundsMin && mapMeta.boundsMin[0]);
  const minY = finite(mapMeta.boundsMin && mapMeta.boundsMin[1]);
  const maxX = finite(mapMeta.boundsMax && mapMeta.boundsMax[0]);
  const maxY = finite(mapMeta.boundsMax && mapMeta.boundsMax[1]);
  if (minX === null || minY === null || maxX === null || maxY === null) return null;
  const dx = (maxX - minX) / res;
  const dy = (maxY - minY) / res;
  const p0 = worldToMapPixel(minX + xIndex * dx, minY + yIndex * dy, mapMeta);
  const p1 = worldToMapPixel(minX + (xIndex + 1) * dx, minY + (yIndex + 1) * dy, mapMeta);
  if (!p0 || !p1) return null;
  const left = Math.min(p0.u, p1.u);
  const top = Math.min(p0.v, p1.v);
  return { x: left, y: top, w: Math.abs(p1.u - p0.u), h: Math.abs(p1.v - p0.v) };
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const unixTime = intOrNull(entry.unixTime);
    const type = shortString(entry.type);
    const value = intOrNull(entry.value);
    if (unixTime === null || !Number.isSafeInteger(unixTime)) continue;
    if (!type || value === null || value < -0x80000000 || value > 0x7fffffff) continue;
    entries.push({ unixTime, type, value });
  }
  if (entries.length > HISTORY_CAP) return entries.slice(entries.length - HISTORY_CAP);
  return entries;
}

function normalizeAchievements(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  for (const key of Object.keys(raw)) {
    const name = shortString(key);
    const count = intOrNull(raw[key]);
    if (!name || count === null || count < 0) continue;
    out.push({ name, count });
    if (out.length >= 40) break;
  }
  return out;
}

// Writer emits these strings only. Counts stay in the chip ("buffs:2"); flags have no number.
const STATUS_EFFECT_FLAGS = Object.freeze(['boneBreak', 'fertile', 'pregnant']);
const STATUS_EFFECT_COUNT = /^(buffs|debuffs|disease|burn):([1-9][0-9]*)$/;

/** One chip, exactly as written, or null when it is not one of the fixed labels. */
function statusEffectLabel(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (STATUS_EFFECT_FLAGS.includes(text)) return text;
  if (STATUS_EFFECT_COUNT.test(text)) return text;
  return null;
}

/**
 * Fixed labels from either the writer's string list or the StatusEffects struct.
 * Counts are emitted only when > 0. Flags only when true. Unknown strings are dropped.
 * A kept string is not renamed.
 */
function normalizeStatusEffects(raw) {
  if (Array.isArray(raw)) {
    const out = [];
    for (const item of raw) {
      const label = statusEffectLabel(item);
      if (!label) continue;
      out.push(label);
      if (out.length >= 7) break;
    }
    return out;
  }
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  const counts = [
    ['buffs', raw.ActiveBuffs],
    ['debuffs', raw.ActiveDeffs],
    ['disease', raw.Diseases],
    ['burn', raw.Burn],
  ];
  for (const [name, value] of counts) {
    const n = intOrNull(value);
    if (n !== null && n > 0) out.push(`${name}:${n}`);
  }
  if (raw.BoneBreak === true) out.push('boneBreak');
  if (raw.Fertility === true) out.push('fertile');
  if (raw.Pregnant === true) out.push('pregnant');
  return out;
}

/**
 * Name shown on the Account section.
 * Snapshot account.personaName, then a steamworks.js persona if one was passed, then the Steam ID.
 * An empty personaName does not count.
 */
function displayPersona({ personaName, steamPersona, steamId } = {}) {
  const fromSave = shortString(personaName);
  if (fromSave) return { name: fromSave, source: 'snapshot' };
  const fromSteam = shortString(steamPersona);
  if (fromSteam) return { name: fromSteam, source: 'steamworks' };
  const id = shortString(steamId, 32);
  if (id) return { name: id, source: 'steamid' };
  return { name: null, source: null };
}

/**
 * steamworks.js localplayer.getName(), if that call already works.
 * Does not call init(). A throw (Steam not up in this process) returns null.
 */
function readSteamPersonaName(steamworks) {
  try {
    const getName = steamworks && steamworks.localplayer && steamworks.localplayer.getName;
    if (typeof getName !== 'function') return null;
    return shortString(getName());
  } catch (_) {
    return null;
  }
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const account = {
    achievements: normalizeAchievements(raw.achievements),
    loreDiscoveredCount: nonNegInt(raw.loreDiscoveredCount),
    loreTotalCount: nonNegInt(raw.loreTotalCount),
    photoCount: nonNegInt(raw.photoCount),
    lifetimeSurvivalTime: nonNegInt(raw.lifetimeSurvivalTime),
    lifetimeCharactersCreated: nonNegInt(raw.lifetimeCharactersCreated),
    lifetimeXP: nonNegInt(raw.lifetimeXP),
    longestSurvivalTimeDays: nonNegInt(raw.longestSurvivalTimeDays),
    mostPlayedSpecies: mostPlayed(raw.mostPlayedSpecies),
    // Empty string means Steam was down at write time. Display falls through.
    personaName: shortString(raw.personaName) || null,
  };
  return account;
}

function nonNegInt(value) {
  const n = intOrNull(value);
  if (n === null || n < 0) return null;
  return n;
}

function mostPlayed(value) {
  if (typeof value === 'string') return shortString(value);
  const n = intOrNull(value);
  if (n === null || n < 0 || n > 255) return null;
  return n;
}

function normalizeLocation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const worldKey = typeof raw.worldKey === 'string' ? raw.worldKey : '';
  const rejected = worldKey !== '' && !isSafeWorldKey(worldKey);
  return {
    worldKey: isSafeWorldKey(worldKey) ? worldKey : null,
    worldKeyRejected: rejected,
    region: shortString(raw.region),
    sector: shortString(raw.sector),
    place: shortString(raw.place),
    mapName: shortString(raw.mapName),
    x: finite(raw.x),
    y: finite(raw.y),
    updatedUnix: intOrNull(raw.updatedUnix),
  };
}

function normalizeDiscovery(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isSafeWorldKey(entry.worldKey)) continue;
    const resolution = intOrNull(entry.resolution);
    const boundsSig = intOrNull(entry.boundsSig);
    if (resolution === null || resolution < 1 || resolution > FOG_RESOLUTION_MAX) continue;
    if (boundsSig === null) continue;
    if (typeof entry.bitsB64 !== 'string' || entry.bitsB64.length > 20000) continue;
    const discoveredCount = nonNegInt(entry.discoveredCount);
    out.push({
      worldKey: entry.worldKey,
      resolution,
      boundsSig,
      bitsB64: entry.bitsB64.trim(),
      discoveredCount,
      updatedUnix: intOrNull(entry.updatedUnix),
    });
  }
  return out;
}

function normalizeVitals(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const floats = ['health', 'sleep', 'stamina', 'oxygen', 'hp', 'thirst', 'hunger', 'digestion', 'fat', 'milk'];
  const ints = ['calories', 'weight', 'bodyTemp'];
  const out = {};
  for (const key of floats) {
    const n = pickFinite(raw, key);
    if (n !== null) out[key] = n;
  }
  for (const key of ints) {
    const n = pickInt(raw, key);
    if (n !== null) out[key] = n;
  }
  return out;
}

function normalizeBase(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of ['hp', 'armor', 'weight', 'attack', 'defense', 'speed', 'intelligence']) {
    const n = pickInt(raw, key);
    if (n !== null) out[key] = n;
  }
  return out;
}

function normalizeCharacter(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const characterId = shortString(raw.characterId, 64);
  if (!characterId) return null;
  if (raw.status !== 'ALIVE' && raw.status !== 'DEAD') return null;
  const progression = raw.progression && typeof raw.progression === 'object' ? raw.progression : {};
  const name = shortString(progression.characterName) || 'Unnamed';
  // Status on the snapshot is the writer's ALIVE/DEAD string (from the Status byte). Not the raw byte.
  let inventory = null;
  if (raw.inventorySummary && typeof raw.inventorySummary === 'object') {
    const items = nonNegInt(raw.inventorySummary.items);
    const maxSlots = nonNegInt(raw.inventorySummary.maxSlots);
    if (items !== null || maxSlots !== null) inventory = { items, maxSlots };
  }
  const speciesByte = intOrNull(raw.speciesByte);
  return {
    characterId,
    speciesId: shortString(raw.speciesId) || null,
    speciesByte: speciesByte !== null && speciesByte >= 0 && speciesByte <= 255 ? speciesByte : null,
    status: raw.status,
    name,
    level: nonNegInt(progression.level),
    daysSurvived: nonNegInt(progression.daysSurvived),
    lastUpdatedUnix: intOrNull(raw.lastUpdatedUnix),
    createdUnix: intOrNull(raw.createdUnix),
    location: normalizeLocation(raw.location),
    vitals: normalizeVitals(raw.vitals),
    base: normalizeBase(raw.base),
    statusEffects: normalizeStatusEffects(raw.statusEffects),
    inventory,
    history: normalizeHistory(raw.history),
    // Dead characters never carry fog into the view. Alive-only keeps the 32 KB cap meaningful.
    mapDiscovery: raw.status === 'ALIVE' ? normalizeDiscovery(raw.mapDiscovery) : [],
  };
}

function sortCharacters(list) {
  return list.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ALIVE' ? -1 : 1;
    return (b.lastUpdatedUnix || 0) - (a.lastUpdatedUnix || 0);
  }).slice(0, CHARACTER_CAP);
}

/**
 * Parse a snapshot buffer. Does not touch the disk.
 * States: ok, stale, corrupt, unknown_schema, oversize.
 * stale still includes the summary.
 */
function parseSnapshot(buffer, nowSec) {
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  if (buffer == null) return fail('corrupt', MESSAGES.damaged);
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  if (buf.length > MAX_SNAPSHOT_BYTES) return fail('oversize', MESSAGES.oversize);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return fail('corrupt', MESSAGES.damaged);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('corrupt', MESSAGES.damaged);
  // Only schemaVersion is accepted. schema_version alone is an unknown schema.
  if (data.schemaVersion !== SCHEMA_VERSION) return fail('unknown_schema', MESSAGES.unknownSchema);
  if (!Number.isInteger(data.savedAtUnix)) return fail('corrupt', MESSAGES.damaged);
  if (!Array.isArray(data.characters)) return fail('corrupt', MESSAGES.damaged);

  const characters = [];
  for (const raw of data.characters) {
    const character = normalizeCharacter(raw);
    if (character) characters.push(character);
  }
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    savedAtUnix: data.savedAtUnix,
    saveSlotIndex: nonNegInt(data.saveSlotIndex),
    steamId: shortString(data.steamId, 32),
    game: normalizeGame(data.game),
    account: normalizeAccount(data.account),
    characters: sortCharacters(characters),
  };
  // File staleness is the writer's clock (savedAtUnix), not a character's lastUpdatedUnix.
  const age = now - data.savedAtUnix;
  if (age > STALE_AFTER_SEC) {
    return { ok: true, state: 'stale', message: MESSAGES.stale, summary };
  }
  return { ok: true, state: 'ok', message: '', summary };
}

function normalizeGame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const build = shortString(raw.build);
  const branch = shortString(raw.branch);
  const engine = shortString(raw.engine);
  if (!build && !branch && !engine) return null;
  return { build, branch, engine };
}

function fail(state, message) {
  return { ok: false, state, message, summary: null };
}

function readSnapshotFile(filePath, { now, fsImpl = fs } = {}) {
  let st;
  try {
    st = fsImpl.statSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fail('missing', MESSAGES.missing);
    return fail('unreadable', MESSAGES.unreadable);
  }
  if (!st.isFile()) return fail('corrupt', MESSAGES.damaged);
  if (st.size > MAX_SNAPSHOT_BYTES) return fail('oversize', MESSAGES.oversize);
  let buf;
  try {
    buf = fsImpl.readFileSync(filePath);
  } catch (_) {
    return fail('unreadable', MESSAGES.unreadable);
  }
  if (buf.length > MAX_SNAPSHOT_BYTES) return fail('oversize', MESSAGES.oversize);
  return parseSnapshot(buf, now);
}

function insideDirectory(dir, file) {
  const root = path.resolve(dir);
  const resolved = path.resolve(file);
  const rel = path.relative(root, resolved);
  return rel === path.basename(resolved) && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function loadMapPackage(dir, worldKey, fsImpl = fs) {
  const names = mapPackageNames(worldKey);
  if (!names) return { ok: false, reason: 'bad_world_key' };
  const jsonPath = path.join(dir, names.json);
  const pngPath = path.join(dir, names.png);
  if (!insideDirectory(dir, jsonPath) || !insideDirectory(dir, pngPath)) {
    return { ok: false, reason: 'bad_world_key' };
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(jsonPath, 'utf8');
  } catch (_) {
    return { ok: false, reason: 'no_package' };
  }
  let data;
  try {
    data = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  } catch (_) {
    return { ok: false, reason: 'bad_package' };
  }
  if (!data || data.schemaVersion !== 1 || data.worldKey !== worldKey) return { ok: false, reason: 'bad_package' };
  const boundsMin = pair(data.boundsMin);
  const boundsMax = pair(data.boundsMax);
  const imageW = intOrNull(data.imageW);
  const imageH = intOrNull(data.imageH);
  const boundsSig = intOrNull(data.boundsSig);
  if (!boundsMin || !boundsMax || imageW === null || imageH === null || boundsSig === null) {
    return { ok: false, reason: 'bad_package' };
  }
  if (imageW < 1 || imageH < 1 || imageW > MAP_IMAGE_MAX_PX || imageH > MAP_IMAGE_MAX_PX) {
    return { ok: false, reason: 'bad_package' };
  }
  if (!(boundsMax[0] > boundsMin[0]) || !(boundsMax[1] > boundsMin[1])) return { ok: false, reason: 'bad_package' };
  let png;
  try {
    png = fsImpl.readFileSync(pngPath);
  } catch (_) {
    return { ok: false, reason: 'no_package' };
  }
  if (!Buffer.isBuffer(png) || png.length < 8 || png.length > MAP_PNG_MAX_BYTES) return { ok: false, reason: 'bad_package' };
  if (png[0] !== 0x89 || png.toString('ascii', 1, 4) !== 'PNG') return { ok: false, reason: 'bad_package' };
  const yAxis = typeof data.yAxis === 'string' ? data.yAxis : 'worldXIsImageTop';
  return {
    ok: true,
    worldKey,
    boundsMin,
    boundsMax,
    boundsSig,
    imageW,
    imageH,
    yAxis,
    imageDataUrl: `data:image/png;base64,${png.toString('base64')}`,
  };
}

function pair(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = finite(value[0]);
  const y = finite(value[1]);
  if (x === null || y === null) return null;
  return [x, y];
}

function discoveryFor(character, worldKey) {
  if (!character || character.status !== 'ALIVE' || !worldKey) return null;
  for (const entry of character.mapDiscovery) {
    if (entry.worldKey === worldKey) return entry;
  }
  return null;
}

function characterMap(character, mapPackage) {
  const loc = character.location;
  const empty = {
    mode: 'none',
    message: '',
    pin: null,
    fog: null,
    exploredPercent: null,
    discoveredCount: null,
    resolution: null,
    worldKey: null,
  };
  if (!loc) return empty;
  // An unsafe worldKey is already dropped. Never build a filename from it.
  if (!loc.worldKey) {
    if (!loc.worldKeyRejected && loc.x === null && loc.y === null) return empty;
    return { ...empty, mode: 'bad_key', message: MESSAGES.noMap };
  }
  if (!mapPackage || !mapPackage.ok) {
    return { ...empty, mode: 'no_package', message: MESSAGES.noMap, worldKey: loc.worldKey };
  }
  const pin = loc.x !== null && loc.y !== null
    ? worldToMapPixel(loc.x, loc.y, mapPackage)
    : null;
  if (!pin) return { ...empty, mode: 'no_package', message: MESSAGES.noMap, worldKey: loc.worldKey };

  if (character.status !== 'ALIVE') {
    return {
      ...empty,
      mode: 'pin',
      message: MESSAGES.pinOnlyDead,
      pin,
      worldKey: loc.worldKey,
    };
  }
  const fogRecord = discoveryFor(character, loc.worldKey);
  if (!fogRecord) {
    return { ...empty, mode: 'pin', message: MESSAGES.pinOnlyFog, pin, worldKey: loc.worldKey };
  }
  if (fogRecord.boundsSig !== mapPackage.boundsSig) {
    return { ...empty, mode: 'pin', message: MESSAGES.pinOnlyBounds, pin, worldKey: loc.worldKey };
  }
  const decoded = decodeFogBits(fogRecord.bitsB64, fogRecord.resolution);
  if (!decoded.ok) {
    return { ...empty, mode: 'pin', message: MESSAGES.pinOnlyFog, pin, worldKey: loc.worldKey };
  }
  const rects = [];
  for (const cell of decoded.cells) {
    const rect = fogCellRect(cell.x, cell.y, fogRecord.resolution, mapPackage);
    if (rect) rects.push(rect);
  }
  const count = fogRecord.discoveredCount !== null ? fogRecord.discoveredCount : decoded.count;
  const denom = fogRecord.resolution * fogRecord.resolution;
  return {
    mode: 'fog',
    message: '',
    pin,
    fog: { resolution: fogRecord.resolution, rects, bitCount: decoded.count },
    exploredPercent: denom ? (count / denom) * 100 : null,
    discoveredCount: count,
    resolution: fogRecord.resolution,
    worldKey: loc.worldKey,
  };
}

function presentCharacter(character, mapPackage) {
  return {
    characterId: character.characterId,
    speciesId: character.speciesId,
    speciesByte: character.speciesByte,
    status: character.status,
    name: character.name,
    level: character.level,
    daysSurvived: character.daysSurvived,
    lastUpdatedUnix: character.lastUpdatedUnix,
    createdUnix: character.createdUnix,
    location: character.location,
    vitals: character.vitals,
    base: character.base,
    statusEffects: character.statusEffects,
    inventory: character.inventory,
    history: character.history,
    map: characterMap(character, mapPackage),
  };
}

function disabledView() {
  return {
    enabled: false,
    state: 'disabled',
    message: MESSAGES.disabled,
    savedAtUnix: null,
    saveSlotIndex: null,
    steamId: null,
    game: null,
    personaName: null,
    personaSource: null,
    account: null,
    alive: [],
    graveyard: [],
    maps: {},
  };
}

function localAppDataFrom(env) {
  if (env && typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()) return env.LOCALAPPDATA;
  return path.join(os.homedir(), 'AppData', 'Local');
}

/**
 * Read the snapshot the launcher should show.
 * opts.isPackaged + opts.env decide the gate. opts.fsImpl is for tests.
 * opts.now is unix seconds.
 */
function loadLauncherSnapshot(opts = {}) {
  const env = opts.env || process.env;
  if (!snapshotReadAllowed({ isPackaged: !!opts.isPackaged, env })) return disabledView();
  const fsImpl = opts.fsImpl || fs;
  const now = Number.isFinite(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
  const override = typeof env.SS_TGC_SNAPSHOT_DIR === 'string' ? env.SS_TGC_SNAPSHOT_DIR.trim() : '';
  const dir = override || path.join(localAppDataFrom(env), ...cfg.ENTITLEMENT_DIR_PARTS);
  const parsed = readSnapshotFile(path.join(dir, SNAPSHOT_FILE_NAME), { now, fsImpl });
  if (!parsed.ok) {
    return {
      ...disabledView(),
      enabled: true,
      state: parsed.state,
      message: parsed.message,
    };
  }
  const maps = {};
  const packages = {};
  for (const character of parsed.summary.characters) {
    const key = character.location && character.location.worldKey;
    if (!key || packages[key]) continue;
    packages[key] = loadMapPackage(dir, key, fsImpl);
    if (packages[key].ok) {
      maps[key] = {
        imageDataUrl: packages[key].imageDataUrl,
        imageW: packages[key].imageW,
        imageH: packages[key].imageH,
      };
    }
  }
  const alive = [];
  const graveyard = [];
  for (const character of parsed.summary.characters) {
    const key = character.location && character.location.worldKey;
    const card = presentCharacter(character, key ? packages[key] : null);
    if (character.status === 'ALIVE') alive.push(card);
    else graveyard.push(card);
  }
  const shown = displayPersona({
    personaName: parsed.summary.account && parsed.summary.account.personaName,
    steamPersona: opts.steamPersona != null ? opts.steamPersona : opts.personaName,
    steamId: parsed.summary.steamId,
  });
  return {
    enabled: true,
    state: parsed.state,
    message: parsed.message,
    savedAtUnix: parsed.summary.savedAtUnix,
    saveSlotIndex: parsed.summary.saveSlotIndex,
    steamId: parsed.summary.steamId,
    game: parsed.summary.game,
    personaName: shown.name,
    personaSource: shown.source,
    account: parsed.summary.account,
    alive,
    graveyard,
    maps,
  };
}

module.exports = {
  SCHEMA_VERSION,
  SNAPSHOT_FILE_NAME,
  MAX_SNAPSHOT_BYTES,
  STALE_AFTER_SEC,
  HISTORY_CAP,
  CHARACTER_CAP,
  WORLD_KEY_RE,
  MESSAGES,
  snapshotReadAllowed,
  isSafeWorldKey,
  mapPackageNames,
  worldToMapPixel,
  decodeFogBits,
  fogCellRect,
  parseSnapshot,
  readSnapshotFile,
  loadMapPackage,
  loadLauncherSnapshot,
  normalizeStatusEffects,
  displayPersona,
  readSteamPersonaName,
};
