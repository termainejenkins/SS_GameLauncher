// Writes launcher-app/fixtures/tgc-snapshot/ (snapshot JSON, map JSON, a simple PNG).
//   node scripts/make-snapshot-fixture.js
// Dev-only. The launcher reads this folder when SS_TGC_SNAPSHOT_DIR points at it.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'fixtures', 'tgc-snapshot');
const WORLD = 'TGC_World';
const RES = 64;
const IMAGE = 1024;
const BOUNDS = 200000;
const BOUNDS_SIG = 123456789;
// 2026-11-06 18:00 UTC. Fresh against a November 2026 clock; stale after 30 days.
const SAVED_AT = Math.floor(Date.UTC(2026, 10, 6, 18, 0, 0) / 1000);
const JASIRI_ID = '8E1F4A2C6B194D779A100C5E2F7B11A4';

// Jasiri stands here. The PNG draws a crosshair at the same pixel the launcher formula produces.
const JASIRI = { x: 123400, y: -55600 };
const KIVULI = { x: -40000, y: 80000 };
const LYANNE = { x: 50000, y: 20000 };

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = row + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

function clamp(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

// Same formula as snapshot.worldToMapPixel, spelled out so the crosshair is not imported from it.
function pinPixel(x, y) {
  const u = (y - (-BOUNDS)) / (BOUNDS - (-BOUNDS)) * IMAGE;
  const v = (BOUNDS - x) / (BOUNDS - (-BOUNDS)) * IMAGE;
  return { u, v };
}

function savannaPixel(pin) {
  return (x, y) => {
    const t = y / (IMAGE - 1);
    const dune = Math.sin(x * 0.015 + y * 0.008) * 14;
    let r = 214 - t * 96 + dune;
    let g = 176 - t * 52 + dune * 0.55;
    let b = 86 - t * 28 + dune * 0.2;
    const riverY = 620 + Math.sin(x / 70) * 36;
    if (Math.abs(y - riverY) < 16) {
      r = 74;
      g = 118;
      b = 112;
    }
    const dx = x - pin.u;
    const dy = y - pin.v;
    const dist = Math.hypot(dx, dy);
    // High-contrast marker at Jasiri's pixel so a launcher pin can be checked against it.
    const onCross = (Math.abs(dy) < 1.6 && Math.abs(dx) < 26) || (Math.abs(dx) < 1.6 && Math.abs(dy) < 26);
    const onRing = dist > 13 && dist < 16.5;
    if (onCross || onRing) {
      r = 255;
      g = 255;
      b = 255;
    }
    return [clamp(r), clamp(g), clamp(b), 255];
  };
}

function disk(cx, cy, radius) {
  const cells = [];
  const r2 = radius * radius;
  for (let x = 0; x < RES; x++) {
    for (let y = 0; y < RES; y++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) cells.push([x, y]);
    }
  }
  return cells;
}

function cellIndex(x, y) {
  const span = (BOUNDS - (-BOUNDS)) / RES;
  return {
    x: Math.floor((x - (-BOUNDS)) / span),
    y: Math.floor((y - (-BOUNDS)) / span),
  };
}

function packBits(cells) {
  const bytes = Buffer.alloc(Math.ceil((RES * RES) / 8));
  for (const [x, y] of cells) {
    const i = x * RES + y;
    bytes[i >> 3] |= 1 << (i & 7);
  }
  return { b64: bytes.toString('base64'), count: cells.length };
}

function history(rows) {
  return rows.map(([unixTime, type, value]) => ({ unixTime, type, value }));
}

function loreEntries() {
  const places = [
    ['waterhole', 'The south waterhole', 'The acacia shade holds the last open water this side of the ridge.', 'lore/waterhole.png'],
    ['kopje', 'The north kopje', 'A stone stack the lions use when the grass is high.', null],
    ['river', 'The dry river', 'It runs only after the long rain.', null],
    ['ridge', 'East ridge', 'Zebra cross here at dusk.', null],
  ];
  const creatures = [
    ['lion_pride', 'Jasiri\'s pride', 'Two adults and a half-grown cub hunt the waterhole.', null],
    ['zebra_herd', 'The zebra', 'They drink in a line and leave when the grass moves.', null],
    ['buffalo', 'The buffalo', 'A small herd keeps to the far bank.', null],
  ];
  const stories = [
    ['acacia', 'Under the acacia', 'The first mark on the tree is older than this season.', null],
    ['dusk_hunt', 'Dusk hunt', 'One hunt, just after the light dropped.', null],
    ['first_circle', 'The first circle', 'The old name for the land inside the ridge.', null],
  ];
  const rows = [];
  for (const [id, title, text, image] of places) rows.push({ id, title, category: 'Places', text, ...(image ? { image } : {}) });
  for (const [id, title, text] of creatures) rows.push({ id, title, category: 'Creatures', text });
  for (const [id, title, text] of stories) rows.push({ id, title, category: 'Stories', text });
  return rows;
}

function writeLoreAndPhotos(pin) {
  const loreDir = path.join(OUT, 'lore');
  fs.mkdirSync(loreDir, { recursive: true });
  fs.writeFileSync(path.join(loreDir, 'waterhole.png'), encodePng(64, 40, () => [90, 140, 150, 255]));
  fs.writeFileSync(path.join(OUT, 'lore_catalog.json'), `${JSON.stringify({ version: 1, entries: loreEntries() }, null, 2)}\n`);

  const photoDir = path.join(OUT, 'photos', JASIRI_ID);
  fs.mkdirSync(photoDir, { recursive: true });
  const shots = [
    ['1793987990_1.png', 1793987990, 'Shade at the waterhole', JASIRI.x, JASIRI.y, [196, 154, 74, 255], 'dusk'],
    ['1793900000_1.png', 1793900000, 'The east ridge', KIVULI.x, KIVULI.y, [120, 140, 70, 255], null],
    ['1793800000_1.png', 1793800000, 'Tracks in the dust', LYANNE.x, LYANNE.y, [160, 120, 70, 255], null],
  ];
  const photos = shots.map(([file, unixTime, caption, x, y, color, timeOfDay]) => {
    fs.writeFileSync(path.join(photoDir, file), encodePng(80, 48, (px) => (Math.abs(px - 40) < 2 ? [255, 255, 255, 255] : color)));
    const row = { file, unixTime, caption, worldKey: WORLD, x, y };
    if (timeOfDay) row.timeOfDay = timeOfDay;
    return row;
  });
  fs.writeFileSync(path.join(photoDir, 'index.json'), `${JSON.stringify({ version: 1, photos }, null, 2)}\n`);
  return { photoPin: pin };
}

function main() {
  const jasiriCell = cellIndex(JASIRI.x, JASIRI.y);
  const kivuliCell = cellIndex(KIVULI.x, KIVULI.y);
  const jasiriFog = packBits(disk(jasiriCell.x, jasiriCell.y, 12));
  const kivuliFog = packBits(disk(kivuliCell.x, kivuliCell.y, 6));
  const pin = pinPixel(JASIRI.x, JASIRI.y);

  const snapshot = {
    schemaVersion: 1,
    game: { build: '0.4.27-demo', branch: 'default', engine: '4.27.2' },
    savedAtUnix: SAVED_AT,
    saveSlotIndex: 2,
    steamId: '76561198000000000',
    account: {
      personaName: 'Amani',
      loreUnlocked: ['waterhole', 'lion_pride', 'acacia', 'dusk_hunt', 'not_in_catalog'],
      achievements: { Total_Lions_Hunted: 3, First_Drink: 1 },
      loreDiscoveredCount: 12,
      loreTotalCount: 80,
      photoCount: 4,
      lifetimeSurvivalTime: 123456,
      lifetimeCharactersCreated: 3,
      lifetimeXP: 48200,
      longestSurvivalTimeDays: 41,
      mostPlayedSpecies: 'Lion',
    },
    characters: [
      {
        characterId: JASIRI_ID,
        speciesId: 'Lion',
        speciesByte: 41,
        status: 'ALIVE',
        lastUpdatedUnix: SAVED_AT - 10,
        createdUnix: SAVED_AT - 14 * 86400,
        progression: { characterName: 'Jasiri', daysSurvived: 14, level: 6 },
        location: {
          worldKey: WORLD,
          region: 'TGC_SafariRegion_v1',
          sector: 'SouthWaterhole',
          place: 'Acacia shade',
          x: JASIRI.x,
          y: JASIRI.y,
          updatedUnix: SAVED_AT - 10,
        },
        vitals: { health: 0.82, stamina: 0.6, hunger: 0.3, thirst: 0.4, oxygen: 1, weight: 190, bodyTemp: 38 },
        base: { attack: 40, defense: 22, armor: 5, speed: 600 },
        statusEffects: ['buffs:2', 'boneBreak'],
        photoCount: 3,
        photoIndexPath: `photos/${JASIRI_ID}/index.json`,
        inventorySummary: { items: 3, maxSlots: 10 },
        history: history([
          [SAVED_AT - 86400 * 3, 'Hunt', 1],
          [SAVED_AT - 86400 * 2, 'LevelUp', 5],
          [SAVED_AT - 86400, 'RegionEntered', 1],
          [SAVED_AT - 3600, 'LevelUp', 6],
        ]),
        mapDiscovery: [{
          worldKey: WORLD,
          resolution: RES,
          boundsSig: BOUNDS_SIG,
          bitsB64: jasiriFog.b64,
          discoveredCount: jasiriFog.count,
          updatedUnix: SAVED_AT - 10,
        }],
      },
      {
        characterId: '1B6C9D302E444F188A7755D0C3A91E02',
        speciesId: 'Zebra',
        speciesByte: 2,
        status: 'ALIVE',
        lastUpdatedUnix: SAVED_AT - 80,
        createdUnix: SAVED_AT - 9 * 86400,
        progression: { characterName: 'Kivuli', daysSurvived: 9, level: 3 },
        location: {
          worldKey: WORLD,
          region: 'TGC_SafariRegion_v1',
          sector: 'EastRidge',
          x: KIVULI.x,
          y: KIVULI.y,
          updatedUnix: SAVED_AT - 80,
        },
        vitals: { health: 1, stamina: 0.9, hunger: 0.2, thirst: 0.25, oxygen: 1, weight: 320, bodyTemp: 38 },
        base: { attack: 18, defense: 16, armor: 2, speed: 720 },
        statusEffects: ['debuffs:1', 'fertile'],
        inventorySummary: { items: 1, maxSlots: 8 },
        history: [],
        mapDiscovery: [{
          worldKey: WORLD,
          resolution: RES,
          boundsSig: BOUNDS_SIG,
          bitsB64: kivuliFog.b64,
          discoveredCount: kivuliFog.count,
          updatedUnix: SAVED_AT - 80,
        }],
      },
      {
        characterId: '77AA01C59D2B4E60B3146F8E0A2D44C8',
        speciesId: 'Lion',
        speciesByte: 41,
        status: 'DEAD',
        lastUpdatedUnix: SAVED_AT - 5 * 86400,
        createdUnix: SAVED_AT - 8 * 86400,
        progression: { characterName: 'Lyanne', daysSurvived: 3, level: 2 },
        location: {
          worldKey: WORLD,
          region: 'TGC_SafariRegion_v1',
          sector: 'NorthKopje',
          x: LYANNE.x,
          y: LYANNE.y,
          updatedUnix: SAVED_AT - 5 * 86400,
        },
        vitals: { health: 0, stamina: 0, hunger: 1, thirst: 1, oxygen: 0, weight: 160, bodyTemp: 30 },
        base: { attack: 28, defense: 14, armor: 3, speed: 640 },
        statusEffects: ['burn:3', 'pregnant'],
        inventorySummary: { items: 0, maxSlots: 10 },
        history: history([
          [SAVED_AT - 8 * 86400, 'Created', 0],
          [SAVED_AT - 6 * 86400, 'LevelUp', 2],
          [SAVED_AT - 5 * 86400, 'Died', 3],
        ]),
      },
    ],
  };

  const mapJson = {
    schemaVersion: 1,
    worldKey: WORLD,
    boundsMin: [-BOUNDS, -BOUNDS],
    boundsMax: [BOUNDS, BOUNDS],
    boundsSig: BOUNDS_SIG,
    imageW: IMAGE,
    imageH: IMAGE,
    capturedUnix: SAVED_AT - 86400,
    yAxis: 'worldXIsImageTop',
  };

  fs.mkdirSync(OUT, { recursive: true });
  const png = encodePng(IMAGE, IMAGE, savannaPixel(pin));
  fs.writeFileSync(path.join(OUT, 'launcher_snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, `tgc_worldmap_${WORLD}.json`), `${JSON.stringify(mapJson, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, `tgc_worldmap_${WORLD}.png`), png);
  writeLoreAndPhotos(pin);
  const snapBytes = fs.statSync(path.join(OUT, 'launcher_snapshot.json')).size;
  console.log(JSON.stringify({
    out: OUT,
    snapshotBytes: snapBytes,
    pngBytes: png.length,
    jasiriCell,
    kivuliCell,
    jasiriPin: pin,
    jasiriDiscovered: jasiriFog.count,
    kivuliDiscovered: kivuliFog.count,
  }, null, 2));
}

main();
