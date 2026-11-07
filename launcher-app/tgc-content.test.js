// Lore spoiler filter and photo index rules. No Electron.
//   node --test tgc-content.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const content = require('./tgc-content');

const FIXTURE = path.join(__dirname, 'fixtures', 'tgc-snapshot');
const JASIRI = '8E1F4A2C6B194D779A100C5E2F7B11A4';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-content-'));
}

function minimalSnapshot(character) {
  return {
    schemaVersion: 1,
    savedAtUnix: 1793988000,
    characters: [character],
    account: { loreUnlocked: ['waterhole', 'not_a_real_entry'] },
  };
}

test('locked lore hides text and unknown ids are ignored', () => {
  const parsed = content.parseLoreCatalog(JSON.stringify({
    version: 1,
    entries: [
      { id: 'waterhole', title: 'The south waterhole', category: 'Places', text: 'Open water under the acacia.' },
      { id: 'kopje', title: 'The north kopje', category: 'Places', text: 'Lions stand on the stones.' },
      { id: 'lion_pride', title: 'The pride', category: 'Creatures', text: 'Two adults.' },
    ],
  }));
  assert.equal(parsed.ok, true);
  const view = content.presentLore(parsed.entries, ['waterhole', 'not_a_real_entry', '../secret', 'kopje/../x']);
  assert.equal(view.unlocked, 1);
  assert.equal(view.total, 3);
  assert.deepEqual(view.ignored, ['not_a_real_entry']);
  const places = view.categories.find((row) => row.category === 'Places');
  const open = places.entries.find((row) => row.id === 'waterhole');
  const locked = places.entries.find((row) => row.id === 'kopje');
  assert.equal(open.locked, false);
  assert.equal(open.text, 'Open water under the acacia.');
  assert.equal(locked.locked, true);
  assert.equal(locked.title, '???');
  assert.equal(locked.category, 'Places');
  assert.equal(locked.text, null);
  assert.equal(locked.image, null);
  assert.equal(JSON.stringify(locked).includes('stones'), false);
});

test('photo names that are not plain files are dropped, and the read stops at 200', () => {
  const photos = [];
  for (let i = 0; i < 205; i++) photos.push({ file: `shot${i}.png`, unixTime: i, worldKey: 'TGC_World', x: 1, y: 2 });
  photos.unshift({ file: '../secret.png', unixTime: 1, worldKey: 'TGC/World', x: 0, y: 0 });
  photos.unshift({ file: '/tmp/abs.png', unixTime: 1 });
  photos.unshift({ file: 'shot.png.txt', unixTime: 1 });
  const parsed = content.parsePhotoIndex({ version: 1, photos });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.photos.length, 200);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.photos.some((row) => row.file.includes('..') || row.file.includes('/') || row.file.includes('\\')), false);
  const badOnly = content.parsePhotoIndex({
    version: 1,
    photos: [
      { file: '..\\secret.png' },
      { file: 'photos/secret.png' },
      { file: 'C:\\secret.png' },
    ],
  });
  assert.deepEqual(badOnly.photos, []);
});

test('missing photo files are skipped and nothing is written', () => {
  const dir = tmpDir();
  const id = 'Jasiri1';
  const folder = path.join(dir, 'photos', id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(dir, 'launcher_snapshot.json'), JSON.stringify(minimalSnapshot({
    characterId: id,
    status: 'ALIVE',
    photoCount: 2,
    photoIndexPath: `photos/${id}/index.json`,
    progression: { characterName: 'Jasiri' },
  })));
  fs.writeFileSync(path.join(folder, 'index.json'), JSON.stringify({
    version: 1,
    photos: [
      { file: 'here.png', unixTime: 10, caption: 'Here', worldKey: 'TGC_World', x: 1, y: 2 },
      { file: 'gone.png', unixTime: 11, caption: 'Gone', worldKey: 'TGC_World', x: 3, y: 4 },
      { file: '../secret.png', unixTime: 12, worldKey: 'TGC_World', x: 0, y: 0 },
    ],
  }));
  fs.writeFileSync(path.join(folder, 'here.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const outside = path.join(dir, 'secret.png');
  fs.writeFileSync(outside, Buffer.from('nope'));
  const writes = [];
  const fsImpl = {
    readFileSync: (...args) => fs.readFileSync(...args),
    statSync: (...args) => fs.statSync(...args),
    writeFileSync: (...args) => { writes.push(args[0]); },
  };
  const listed = content.loadPhotoIndex({
    isPackaged: false,
    env: { SS_TGC_SNAPSHOT_DIR: dir },
    fsImpl,
  }, id);
  assert.equal(listed.enabled, true);
  assert.equal(listed.photos.length, 1);
  assert.equal(listed.photos[0].file, 'here.png');
  assert.equal(writes.length, 0);
  const got = content.readPhotoFile({
    isPackaged: false,
    env: { SS_TGC_SNAPSHOT_DIR: dir },
    fsImpl,
  }, id, 'here.png');
  assert.equal(got.ok, true);
  assert.match(got.dataUrl, /^data:image\/png;base64,/);
  const escaped = content.readPhotoFile({
    isPackaged: false,
    env: { SS_TGC_SNAPSHOT_DIR: dir },
    fsImpl,
  }, id, '../secret.png');
  assert.equal(escaped.ok, false);
  assert.equal(writes.length, 0);
  fs.unlinkSync(outside);
});

test('a packaged build does not read the catalog or the photos', () => {
  const boom = {
    readFileSync() { throw new Error('read'); },
    statSync() { throw new Error('read'); },
  };
  const lore = content.loadLoreLibrary({ isPackaged: true, env: { SS_TGC_SNAPSHOT_DIR: FIXTURE }, fsImpl: boom });
  assert.equal(lore.enabled, false);
  const photos = content.loadPhotoIndex({ isPackaged: true, env: { SS_TGC_SNAPSHOT_DIR: FIXTURE }, fsImpl: boom }, JASIRI);
  assert.equal(photos.enabled, false);
});

test('fixture catalog unlocks four of ten and Jasiri has three photos', () => {
  const lore = content.loadLoreLibrary({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: FIXTURE } });
  assert.equal(lore.state, 'ok');
  assert.equal(lore.total, 10);
  assert.equal(lore.unlocked, 4);
  assert.deepEqual(lore.ignored, ['not_in_catalog']);
  assert.equal(lore.categories.length, 3);
  const locked = lore.categories.flatMap((row) => row.entries).filter((row) => row.locked);
  assert.equal(locked.length, 6);
  assert.equal(locked.every((row) => row.title === '???' && row.text === null), true);
  const photos = content.loadPhotoIndex({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: FIXTURE } }, JASIRI);
  assert.equal(photos.photos.length, 3);
  assert.equal(photos.photos[0].caption, 'Shade at the waterhole');
  assert.ok(photos.photos[0].pin);
  const image = content.readLoreImage({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: FIXTURE } }, 'waterhole');
  assert.equal(image.ok, true);
  const hidden = content.readLoreImage({ isPackaged: false, env: { SS_TGC_SNAPSHOT_DIR: FIXTURE } }, 'kopje');
  assert.equal(hidden.ok, false);
});
