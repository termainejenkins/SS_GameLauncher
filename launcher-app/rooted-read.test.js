// Path containment and bounded reads. Symlink cases skip when the OS refuses links.
//   node --test rooted-read.test.js
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { readRootedFile } = require('./rooted-read');
const snap = require('./snapshot');
const content = require('./tgc-content');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-root-'));
}

function tryLink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOTSUP' || err.code === 'EINVAL')) return false;
    throw err;
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);

test('an oversize snapshot is refused by the helper path as well as the direct read', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'launcher_snapshot.json'), Buffer.alloc(snap.MAX_SNAPSHOT_BYTES + 50, 0x20));
  fs.writeFileSync(path.join(dir, 'lore_catalog.json'), JSON.stringify({
    version: 1,
    entries: [{ id: 'waterhole', title: 'Secret title', category: 'Places', text: 'Secret text' }],
  }));
  const direct = await snap.readSnapshotFile(path.join(dir, 'launcher_snapshot.json'), { rootDir: dir, now: 1 });
  assert.equal(direct.state, 'oversize');
  const lore = await content.loadLoreLibrary({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: dir } });
  assert.equal(lore.enabled, true);
  assert.equal(lore.unlocked, 0);
  assert.equal(lore.categories[0].entries[0].title, '???');
  assert.equal(lore.categories[0].entries[0].text, null);
  fs.mkdirSync(path.join(dir, 'photos', 'Jasiri1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'photos', 'Jasiri1', 'index.json'), JSON.stringify({
    version: 1,
    photos: [{ file: 'shot.png', unixTime: 1, worldKey: 'TGC_World', x: 1, y: 2, caption: 'hidden' }],
  }));
  fs.writeFileSync(path.join(dir, 'photos', 'Jasiri1', 'shot.png'), PNG);
  const photos = await content.loadPhotoIndex({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: dir } }, 'Jasiri1');
  assert.deepEqual(photos.photos, []);
  assert.equal(JSON.stringify(photos).includes('hidden'), false);
});

test('a non-regular snapshot file is rejected without hanging', async (t) => {
  if (process.platform === 'win32') {
    t.skip('this OS cannot create a FIFO');
    return;
  }
  const dir = tmpDir();
  const fifo = path.join(dir, 'launcher_snapshot.json');
  try {
    if (typeof fs.mkfifoSync === 'function') fs.mkfifoSync(fifo);
    else execFileSync('mkfifo', [fifo]);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOTSUP' || err.code === 'ENOENT')) {
      t.skip('this OS refused to create a FIFO');
      return;
    }
    throw err;
  }
  const result = await Promise.race([
    snap.readSnapshotFile(fifo, { rootDir: dir, now: 1 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 2000)),
  ]);
  assert.equal(result.state, 'unreadable');
});

test('a symlink to a file outside the data dir is not read', async (t) => {
  const dir = tmpDir();
  const outside = path.join(os.tmpdir(), `tgc-outside-${process.pid}.png`);
  fs.writeFileSync(outside, Buffer.concat([PNG, Buffer.from('outside')]));
  const link = path.join(dir, 'shot.png');
  if (!tryLink(outside, link, process.platform === 'win32' ? 'file' : undefined)) {
    t.skip('this OS refused to create a symlink');
    fs.unlinkSync(outside);
    return;
  }
  const read = await readRootedFile(dir, link, { maxBytes: 1024 });
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'symlink');
  fs.unlinkSync(outside);
});

test('a symlinked photo directory cannot escape the data dir', async (t) => {
  const dir = tmpDir();
  const outside = tmpDir();
  const id = 'Jasiri1';
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'launcher_snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    savedAtUnix: 100,
    characters: [{
      characterId: id,
      status: 'ALIVE',
      photoCount: 1,
      photoIndexPath: `photos/${id}/index.json`,
      progression: { characterName: 'Jasiri' },
    }],
  }));
  const photosLink = path.join(dir, 'photos');
  fs.mkdirSync(photosLink);
  const idLink = path.join(photosLink, id);
  const type = process.platform === 'win32' ? 'junction' : undefined;
  if (!tryLink(outside, idLink, type)) {
    t.skip('this OS refused to create a directory link');
    return;
  }
  fs.writeFileSync(path.join(outside, 'index.json'), JSON.stringify({
    version: 1,
    photos: [{ file: 'secret.png', unixTime: 1, worldKey: 'TGC_World', x: 1, y: 2, caption: 'escaped' }],
  }));
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  const listed = await content.loadPhotoIndex({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: dir } }, id);
  assert.equal(listed.photos.length, 0);
  assert.equal(JSON.stringify(listed).includes('escaped'), false);
});

test('a symlinked lore image and map png are rejected', async (t) => {
  const dir = tmpDir();
  const outside = path.join(os.tmpdir(), `tgc-lore-out-${process.pid}.png`);
  fs.writeFileSync(outside, PNG);
  fs.mkdirSync(path.join(dir, 'lore'));
  const loreLink = path.join(dir, 'lore', 'waterhole.png');
  const mapLink = path.join(dir, 'tgc_worldmap_TGC_World.png');
  const fileType = process.platform === 'win32' ? 'file' : undefined;
  if (!tryLink(outside, loreLink, fileType) || !tryLink(outside, mapLink, fileType)) {
    t.skip('this OS refused to create a symlink');
    fs.unlinkSync(outside);
    return;
  }
  fs.writeFileSync(path.join(dir, 'lore_catalog.json'), JSON.stringify({
    version: 1,
    entries: [{ id: 'waterhole', title: 'Hole', category: 'Places', text: 'Text', image: 'lore/waterhole.png' }],
  }));
  fs.writeFileSync(path.join(dir, 'launcher_snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    savedAtUnix: 100,
    account: { loreUnlocked: ['waterhole'] },
    characters: [],
  }));
  fs.writeFileSync(path.join(dir, 'tgc_worldmap_TGC_World.json'), JSON.stringify({
    schemaVersion: 1,
    worldKey: 'TGC_World',
    boundsMin: [0, 0],
    boundsMax: [10, 10],
    boundsSig: 1,
    imageW: 8,
    imageH: 8,
    yAxis: 'worldXIsImageTop',
  }));
  const image = await content.readLoreImage({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: dir } }, 'waterhole');
  assert.equal(image.ok, false);
  const map = await snap.readMapImage(dir, 'TGC_World');
  assert.equal(map.ok, false);
  fs.unlinkSync(outside);
});

test('an oversize lore catalog and photo index are refused before use', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'launcher_snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    savedAtUnix: 100,
    account: { loreUnlocked: ['waterhole'] },
    characters: [{
      characterId: 'Jasiri1',
      status: 'ALIVE',
      photoCount: 1,
      photoIndexPath: 'photos/Jasiri1/index.json',
      progression: { characterName: 'Jasiri' },
    }],
  }));
  fs.writeFileSync(path.join(dir, 'lore_catalog.json'), Buffer.alloc(300 * 1024, 0x61));
  const lore = await content.loadLoreLibrary({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: dir } });
  assert.equal(lore.state, 'oversize');
  fs.mkdirSync(path.join(dir, 'photos', 'Jasiri1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'photos', 'Jasiri1', 'index.json'), Buffer.alloc(300 * 1024, 0x62));
  const photos = await content.loadPhotoIndex({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: dir } }, 'Jasiri1');
  assert.equal(photos.state, 'oversize');
  assert.deepEqual(photos.photos, []);
});

test('an oversize map json and map png are refused', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tgc_worldmap_TGC_World.json'), Buffer.alloc(snap.MAP_JSON_MAX_BYTES + 10, 0x7b));
  fs.writeFileSync(path.join(dir, 'tgc_worldmap_TGC_World.png'), PNG);
  const meta = await snap.loadMapMeta(dir, 'TGC_World');
  assert.equal(meta.ok, false);
  fs.writeFileSync(path.join(dir, 'tgc_worldmap_TGC_World.json'), JSON.stringify({
    schemaVersion: 1,
    worldKey: 'TGC_World',
    boundsMin: [0, 0],
    boundsMax: [10, 10],
    boundsSig: 1,
    imageW: 8,
    imageH: 8,
  }));
  fs.writeFileSync(path.join(dir, 'tgc_worldmap_TGC_World.png'), Buffer.alloc(snap.MAP_PNG_MAX_BYTES + 10, 0));
  const image = await snap.readMapImage(dir, 'TGC_World');
  assert.equal(image.ok, false);
  assert.equal(image.reason, 'oversize');
});

test('a file that grows past the cap is not returned as a short prefix', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'abcd');
  const real = fs.promises;
  const fsp = {
    realpath: (p) => real.realpath(p),
    lstat: (p, opts) => real.lstat(p, opts),
    open: async (p, flags) => {
      const fh = await real.open(p, flags);
      const origStat = fh.stat.bind(fh);
      fh.stat = async (opts) => {
        const st = await origStat(opts);
        fs.appendFileSync(p, '0123456789ABCDEF');
        return st;
      };
      return fh;
    },
  };
  const read = await readRootedFile(dir, file, { maxBytes: 8, fsImpl: { promises: fsp } });
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'oversize');
  assert.equal(read.data, undefined);
});

test('a handle whose device and inode no longer match the path is rejected', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'note.txt');
  fs.writeFileSync(file, 'hello');
  const real = fs.promises;
  const fsp = {
    realpath: (p) => real.realpath(p),
    lstat: async (p, opts) => {
      const st = await real.lstat(p, opts);
      if (!(opts && opts.bigint)) return st;
      return new Proxy(st, {
        get(target, prop, receiver) {
          if (prop === 'ino') return target.ino + 1n;
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    open: (p, flags) => real.open(p, flags),
  };
  const read = await readRootedFile(dir, file, { maxBytes: 100, fsImpl: { promises: fsp } });
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'symlink');
  assert.equal(read.data, undefined);
});
