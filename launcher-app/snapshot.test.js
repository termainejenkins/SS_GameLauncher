// Snapshot parse, worldKey, map transform, and fog decode. No Electron.
//   node --test snapshot.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const snap = require('./snapshot');

const FIXTURE = path.join(__dirname, 'fixtures', 'tgc-snapshot');
const NOW = Math.floor(Date.UTC(2026, 10, 7, 12, 0, 0) / 1000);

function minimal(extra = {}) {
  return {
    schemaVersion: 1,
    savedAtUnix: NOW - 60,
    saveSlotIndex: 2,
    characters: [],
    ...extra,
  };
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-snap-'));
}

function alive(name, extra = {}) {
  return {
    characterId: `id-${name}`,
    speciesId: 'Lion',
    status: 'ALIVE',
    lastUpdatedUnix: NOW - 30,
    progression: { characterName: name, daysSurvived: 4, level: 2 },
    ...extra,
  };
}

test('L1 valid snapshot keeps lifetime stats, history, and drops cosmetics', () => {
  const parsed = snap.parseSnapshot(Buffer.from(JSON.stringify(minimal({
    account: {
      achievements: { Total_Lions_Hunted: 3 },
      loreDiscoveredCount: 12,
      loreTotalCount: 80,
      photoCount: 4,
      lifetimeSurvivalTime: 123456,
      lifetimeCharactersCreated: 3,
      lifetimeXP: 48200,
      longestSurvivalTimeDays: 41,
      mostPlayedSpecies: 'Lion',
      unlockedCosmetics: ['mane_gold'],
    },
    characters: [alive('Jasiri', {
      history: [{ unixTime: NOW - 10, type: 'LevelUp', value: 2 }],
      vitals: { thirst: 0.4, Thrist: 0.9, health: 0.5 },
    })],
  }))), NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state, 'ok');
  assert.equal(parsed.summary.account.lifetimeSurvivalTime, 123456);
  assert.equal(parsed.summary.account.lifetimeCharactersCreated, 3);
  assert.equal(parsed.summary.account.lifetimeXP, 48200);
  assert.equal(parsed.summary.account.longestSurvivalTimeDays, 41);
  assert.equal(parsed.summary.account.mostPlayedSpecies, 'Lion');
  assert.equal(parsed.summary.account.loreDiscoveredCount, 12);
  assert.equal(parsed.summary.account.photoCount, 4);
  assert.equal('unlockedCosmetics' in parsed.summary.account, false);
  assert.equal(JSON.stringify(parsed.summary).includes('mane_gold'), false);
  assert.equal(parsed.summary.characters[0].history.length, 1);
  assert.equal(parsed.summary.characters[0].vitals.thirst, 0.4);
  assert.equal(parsed.summary.characters[0].vitals.Thrist, undefined);
});

test('L1 missing history on an old save is an empty array', () => {
  const parsed = snap.parseSnapshot(Buffer.from(JSON.stringify(minimal({
    characters: [alive('Old')],
  }))), NOW);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.summary.characters[0].history, []);
});

test('L1 missing file', () => {
  const dir = tmpDir();
  const result = snap.readSnapshotFile(path.join(dir, 'launcher_snapshot.json'), { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'missing');
  assert.equal(result.message, snap.MESSAGES.missing);
  assert.equal(result.summary, null);
});

test('L1 partial JSON is damaged, not a throw', () => {
  const parsed = snap.parseSnapshot(Buffer.from('{"schemaVersion":1,"characters":['), NOW);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.state, 'corrupt');
  assert.match(parsed.message, /damaged/);
});

test('L1 unknown schemaVersion and schema_version', () => {
  for (const body of [
    { schemaVersion: 2, savedAtUnix: NOW, characters: [] },
    { schemaVersion: '1', savedAtUnix: NOW, characters: [] },
    { schema_version: 1, savedAtUnix: NOW, characters: [] },
    { savedAtUnix: NOW, characters: [] },
  ]) {
    const parsed = snap.parseSnapshot(Buffer.from(JSON.stringify(body)), NOW);
    assert.equal(parsed.state, 'unknown_schema', JSON.stringify(body));
    assert.match(parsed.message, /Update the launcher/);
  }
});

test('L1 oversize: 32 KB is the cap, 33 KB is refused before parse', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'launcher_snapshot.json');
  fs.writeFileSync(file, Buffer.alloc(33 * 1024, 0x7b));
  const big = snap.readSnapshotFile(file, { now: NOW });
  assert.equal(big.state, 'oversize');
  assert.match(big.message, /32 KB/);

  fs.writeFileSync(file, Buffer.alloc(snap.MAX_SNAPSHOT_BYTES + 1, 0x78));
  assert.equal(snap.readSnapshotFile(file, { now: NOW }).state, 'oversize');

  const exact = Buffer.alloc(snap.MAX_SNAPSHOT_BYTES, 0x20);
  Buffer.from('{"schemaVersion":1}').copy(exact);
  assert.equal(snap.parseSnapshot(exact, NOW).state === 'oversize', false);
});

test('L1 stale file still parses and says so', () => {
  const old = NOW - snap.STALE_AFTER_SEC - 5;
  const parsed = snap.parseSnapshot(Buffer.from(JSON.stringify(minimal({
    savedAtUnix: old,
    characters: [alive('Jasiri')],
  }))), NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state, 'stale');
  assert.match(parsed.message, /30 days/);
  assert.equal(parsed.summary.characters[0].name, 'Jasiri');

  const fresh = snap.parseSnapshot(Buffer.from(JSON.stringify(minimal({
    savedAtUnix: NOW - snap.STALE_AFTER_SEC,
  }))), NOW);
  assert.equal(fresh.state, 'ok');
});

test('worldKey allows letters, digits, underscore, 1 to 64, and nothing else', () => {
  assert.equal(snap.isSafeWorldKey('TGC_World'), true);
  assert.equal(snap.isSafeWorldKey('a'), true);
  assert.equal(snap.isSafeWorldKey('A'.repeat(64)), true);
  const bad = [
    '',
    ' ',
    'TGC World',
    'TGC-World',
    '../TGC',
    'TGC/World',
    'TGC\\World',
    '..',
    '.',
    'a'.repeat(65),
    'TGC..World',
    '/etc/passwd',
    'TGC_World.json',
  ];
  for (const key of bad) {
    assert.equal(snap.isSafeWorldKey(key), false, key);
    assert.equal(snap.mapPackageNames(key), null, key);
  }
  assert.deepEqual(snap.mapPackageNames('TGC_World'), {
    png: 'tgc_worldmap_TGC_World.png',
    json: 'tgc_worldmap_TGC_World.json',
  });
});

test('a bad worldKey never becomes a path', () => {
  const dir = tmpDir();
  const calls = [];
  const fsImpl = {
    statSync: fs.statSync,
    readFileSync: (file, enc) => {
      calls.push(String(file));
      return fs.readFileSync(file, enc);
    },
  };
  writeJson(dir, 'launcher_snapshot.json', minimal({
    characters: [alive('Sneaky', {
      location: { worldKey: '../secrets', x: 1, y: 2, updatedUnix: NOW },
    })],
  }));
  const outside = path.join(dir, '..', 'secrets.json');
  fs.writeFileSync(outside, '{}');
  const view = snap.loadLauncherSnapshot({
    isPackaged: false,
    env: { SS_TGC_SNAPSHOT_DIR: dir },
    now: NOW,
    fsImpl,
  });
  assert.equal(view.enabled, true);
  assert.equal(view.alive[0].map.mode, 'bad_key');
  assert.equal(view.alive[0].map.message, snap.MESSAGES.noMap);
  assert.equal(view.alive[0].map.pin, null);
  for (const file of calls) {
    assert.equal(file.startsWith(dir + path.sep) || file === path.join(dir, 'launcher_snapshot.json'), true, file);
    assert.equal(file.includes(`${path.sep}..${path.sep}`), false, file);
  }
  fs.unlinkSync(outside);
});

test('map transform matches the proven u/v formula', () => {
  const meta = {
    boundsMin: [-200000, -200000],
    boundsMax: [200000, 200000],
    imageW: 1024,
    imageH: 1024,
    yAxis: 'worldXIsImageTop',
  };
  const pin = snap.worldToMapPixel(123400, -55600, meta);
  const u = ( -55600 - (-200000) ) / (200000 - (-200000)) * 1024;
  const v = (200000 - 123400) / (200000 - (-200000)) * 1024;
  assert.ok(Math.abs(u - 369.664) < 1e-9);
  assert.ok(Math.abs(v - 196.096) < 1e-9);
  assert.ok(Math.abs(pin.u - u) < 1e-9);
  assert.ok(Math.abs(pin.v - v) < 1e-9);

  const flipped = snap.worldToMapPixel(123400, -55600, { ...meta, yAxis: 'worldXIsImageBottom' });
  assert.ok(Math.abs(flipped.u - u) < 1e-9);
  assert.ok(Math.abs(flipped.v - (1024 - v)) < 1e-9);
  const alias = snap.worldToMapPixel(123400, -55600, { ...meta, yAxis: 'unrealUpIsImageTop' });
  assert.deepEqual(alias, pin);
  assert.equal(snap.worldToMapPixel(1, 2, { ...meta, boundsMax: [-200000, -200000] }), null);
});

test('fog decode uses i = X * resolution + Y', () => {
  const resolution = 8;
  const bytes = Buffer.alloc(resolution * resolution / 8);
  const x = 3;
  const y = 5;
  const i = x * resolution + y;
  bytes[i >> 3] |= 1 << (i & 7);
  const decoded = snap.decodeFogBits(bytes.toString('base64'), resolution);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.count, 1);
  assert.deepEqual(decoded.cells, [{ x, y }]);

  const meta = {
    boundsMin: [0, 0],
    boundsMax: [80, 80],
    imageW: 80,
    imageH: 80,
    yAxis: 'worldXIsImageTop',
  };
  const rect = snap.fogCellRect(x, y, resolution, meta);
  const center = snap.worldToMapPixel((x + 0.5) * 10, (y + 0.5) * 10, meta);
  assert.ok(center.u >= rect.x && center.u <= rect.x + rect.w);
  assert.ok(center.v >= rect.y && center.v <= rect.y + rect.h);
  assert.equal(snap.decodeFogBits(Buffer.alloc(4).toString('base64'), 8).ok, false);
  assert.equal(snap.decodeFogBits(bytes.toString('base64'), 0).ok, false);
});

test('boundsSig mismatch and dead characters keep the pin and drop fog', () => {
  const dir = tmpDir();
  const map = {
    schemaVersion: 1,
    worldKey: 'TGC_World',
    boundsMin: [-200000, -200000],
    boundsMax: [200000, 200000],
    boundsSig: 5,
    imageW: 64,
    imageH: 64,
    yAxis: 'worldXIsImageTop',
  };
  writeJson(dir, 'tgc_worldmap_TGC_World.json', map);
  fs.writeFileSync(path.join(dir, 'tgc_worldmap_TGC_World.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const bits = Buffer.alloc(8);
  bits[0] = 1;
  const discovery = {
    worldKey: 'TGC_World',
    resolution: 8,
    boundsSig: 5,
    bitsB64: bits.toString('base64'),
    discoveredCount: 1,
    updatedUnix: NOW,
  };
  writeJson(dir, 'launcher_snapshot.json', minimal({
    characters: [
      alive('Jasiri', {
        location: { worldKey: 'TGC_World', x: 0, y: 0, updatedUnix: NOW },
        mapDiscovery: [{ ...discovery, boundsSig: 999 }],
      }),
      alive('Lyanne', {
        status: 'DEAD',
        location: { worldKey: 'TGC_World', x: 1000, y: 1000, updatedUnix: NOW },
        mapDiscovery: [discovery],
        history: [{ unixTime: NOW - 5, type: 'Died', value: 3 }],
        progression: { characterName: 'Lyanne', daysSurvived: 3, level: 1 },
      }),
    ],
  }));
  const view = snap.loadLauncherSnapshot({
    isPackaged: false,
    env: { SS_TGC_SNAPSHOT_DIR: dir },
    now: NOW,
  });
  assert.equal(view.alive.length, 1);
  assert.equal(view.alive[0].map.mode, 'pin');
  assert.equal(view.alive[0].map.fog, null);
  assert.equal(view.alive[0].map.message, snap.MESSAGES.pinOnlyBounds);
  assert.ok(view.alive[0].map.pin);
  assert.equal(view.graveyard.length, 1);
  assert.equal(view.graveyard[0].map.mode, 'pin');
  assert.equal(view.graveyard[0].map.fog, null);
  assert.equal(view.graveyard[0].map.message, snap.MESSAGES.pinOnlyDead);
  assert.equal(view.graveyard[0].history[0].type, 'Died');
  assert.equal(view.graveyard[0].daysSurvived, 3);
});

test('history keeps the newest 32 and skips broken entries', () => {
  const rows = [];
  for (let n = 0; n < 40; n++) rows.push({ unixTime: 1_700_000_000 + n, type: 'Hunt', value: n });
  rows.splice(3, 0, { unixTime: 'nope', type: 'Hunt', value: 1 });
  rows.push({ unixTime: NOW, type: '', value: 1 });
  const parsed = snap.parseSnapshot(Buffer.from(JSON.stringify(minimal({
    characters: [alive('Jasiri', { history: rows })],
  }))), NOW);
  const history = parsed.summary.characters[0].history;
  assert.equal(history.length, 32);
  assert.equal(history[0].value, 8);
  assert.equal(history[31].value, 39);
});

test('release builds do not read the snapshot', () => {
  const boom = {
    statSync() { throw new Error('read'); },
    readFileSync() { throw new Error('read'); },
  };
  const view = snap.loadLauncherSnapshot({
    isPackaged: true,
    env: { SS_TGC_SNAPSHOT: '1', SS_TGC_SNAPSHOT_DIR: '/tmp/fixtures' },
    fsImpl: boom,
    now: NOW,
  });
  assert.equal(view.enabled, false);
  assert.equal(view.state, 'disabled');
  assert.equal(snap.snapshotReadAllowed({ isPackaged: false, env: {} }), false);
  assert.equal(snap.snapshotReadAllowed({ isPackaged: false, env: { SS_TGC_SNAPSHOT: '1' } }), true);
  assert.equal(snap.snapshotReadAllowed({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: '   ' } }), false);
});

test('SS_TGC_SNAPSHOT_DIR is the only folder read when it is set', () => {
  const dir = tmpDir();
  const other = tmpDir();
  writeJson(dir, 'launcher_snapshot.json', minimal({
    characters: [alive('FromFixture')],
  }));
  const entitlement = path.join(other, 'SentientSolutions', 'TGC');
  fs.mkdirSync(entitlement, { recursive: true });
  writeJson(entitlement, 'launcher_snapshot.json', minimal({
    characters: [alive('FromAppData')],
  }));
  const view = snap.loadLauncherSnapshot({
    isPackaged: false,
    env: { SS_TGC_SNAPSHOT_DIR: dir, LOCALAPPDATA: other, SS_TGC_SNAPSHOT: '1' },
    now: NOW,
  });
  assert.equal(view.alive.length, 1);
  assert.equal(view.alive[0].name, 'FromFixture');
});

test('fixture: two alive, one graveyard, pin and fog from the fake map', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'launcher_snapshot.json'), 'utf8'));
  assert.equal(fs.statSync(path.join(FIXTURE, 'launcher_snapshot.json')).size < snap.MAX_SNAPSHOT_BYTES, true);
  assert.equal(raw.account.unlockedCosmetics, undefined);
  const view = snap.loadLauncherSnapshot({
    isPackaged: false,
    env: { SS_TGC_SNAPSHOT_DIR: FIXTURE },
    now: NOW,
  });
  assert.equal(view.state, 'ok');
  assert.equal(view.alive.length >= 2, true);
  assert.equal(view.graveyard.length, 1);
  const jasiri = view.alive.find((c) => c.name === 'Jasiri');
  const kivuli = view.alive.find((c) => c.name === 'Kivuli');
  assert.ok(jasiri);
  assert.ok(kivuli);
  assert.equal(kivuli.history.length, 0);
  assert.ok(jasiri.history.length > 0);
  assert.equal(jasiri.speciesByte, 41);
  assert.equal(jasiri.map.mode, 'fog');
  assert.equal(jasiri.map.fog.bitCount, jasiri.map.discoveredCount);
  assert.ok(jasiri.map.exploredPercent > 0);
  const expected = snap.worldToMapPixel(123400, -55600, {
    boundsMin: [-200000, -200000],
    boundsMax: [200000, 200000],
    imageW: 1024,
    imageH: 1024,
    yAxis: 'worldXIsImageTop',
  });
  assert.ok(Math.abs(jasiri.map.pin.u - expected.u) < 1e-6);
  assert.ok(Math.abs(jasiri.map.pin.v - expected.v) < 1e-6);
  assert.equal(view.maps.TGC_World.imageW, 1024);
  assert.match(view.maps.TGC_World.imageDataUrl, /^data:image\/png;base64,/);
  assert.equal(view.graveyard[0].name, 'Lyanne');
  assert.equal(view.graveyard[0].map.mode, 'pin');
  assert.equal(view.graveyard[0].map.fog, null);
  assert.equal(view.graveyard[0].history.some((h) => h.type === 'Died'), true);
  assert.equal(view.account.lifetimeCharactersCreated, 3);
  const png = fs.readFileSync(path.join(FIXTURE, 'tgc_worldmap_TGC_World.png'));
  assert.equal(png[0], 0x89);
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
});

test('main process reads on demand and refreshes when the window focuses or the game exits', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  assert.match(main, /loadLauncherSnapshot\(\{[\s\S]*?isPackaged: app\.isPackaged/);
  assert.match(main, /ipcMain\.handle\('snapshot:read'/);
  assert.match(main, /mainWindow\.on\('focus', \(\) => pushSnapshot\(\)\)/);
  assert.match(main, /gameChild = null;\s*pushSnapshot\(\)/);
  assert.match(preload, /getSnapshot: \(\) => ipcRenderer\.invoke\('snapshot:read'\)/);
  assert.match(html, /id="tgc-account"/);
  assert.match(html, /id="tgc-map"/);
  assert.match(html, /id="nav-characters"/);
  assert.match(html, />Graveyard</);
  assert.match(renderer, /getElementById\('tgc-history'\)/);
  assert.match(renderer, /function drawMap/);
  assert.equal(html.includes('unlockedCosmetics'), false);
});

test('unnamed character, bad status, and a non-object file do not throw', () => {
  const parsed = snap.parseSnapshot(Buffer.from(JSON.stringify(minimal({
    characters: [
      { characterId: 'a', status: 'ASLEEP', progression: { characterName: 'Nope' } },
      { characterId: 'b', status: 'ALIVE' },
      { status: 'ALIVE', progression: { characterName: 'NoId' } },
    ],
  }))), NOW);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.characters.length, 1);
  assert.equal(parsed.summary.characters[0].name, 'Unnamed');
  assert.equal(snap.parseSnapshot(Buffer.from('null'), NOW).state, 'corrupt');
  assert.equal(snap.parseSnapshot(Buffer.from('[]'), NOW).state, 'corrupt');
});
