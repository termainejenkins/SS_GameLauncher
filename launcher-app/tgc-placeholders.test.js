// Example tab content when the snapshot cannot be read.
//   node --test tgc-placeholders.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const examples = require('./tgc-placeholders');

const BANNED = [
  'jasiri',
  'lyanne',
  'kivuli',
  'amani',
  'waterhole',
  'kopje',
  'acacia',
  'safari',
  'tgc_world',
  'sentient',
  'headcount',
  '7656',
  'http://',
  'https://',
  'localhost',
  'steam',
];

test('example rows are labeled and carry no real snapshot content', () => {
  assert.equal(examples.BADGE, 'Example data, not final content');
  const snap = examples.exampleSnapshot();
  assert.equal(snap.example, true);
  assert.deepEqual(snap.alive.map((row) => row.name), ['Example Character 1', 'Example Character 2']);
  assert.equal(snap.graveyard[0].name, 'Example Character 3');
  assert.equal(snap.alive[0].location.region, 'Example Region');
  assert.equal(snap.personaName, null);
  assert.equal(snap.account, null);
  assert.equal(Object.prototype.hasOwnProperty.call(snap, 'steamId'), false);
  const lore = examples.exampleLore();
  assert.equal(lore.categories[0].entries[0].title, 'Example Lore Entry');
  assert.equal(lore.categories[0].entries.some((row) => row.locked && row.title === '???'), true);
  const photos = examples.exampleGallery();
  assert.equal(photos.length, 3);
  assert.match(photos[0].caption, /^Example photo /);
  const blob = JSON.stringify({ snap, lore, photos, badge: examples.BADGE }).toLowerCase();
  for (const word of BANNED) assert.equal(blob.includes(word), false, word);
});

test('a tab uses example rows only when its snapshot data is missing or unreadable', () => {
  assert.equal(examples.snapshotNeedsExample(null), true);
  assert.equal(examples.snapshotNeedsExample({ enabled: false, state: 'disabled' }), true);
  assert.equal(examples.snapshotNeedsExample({ enabled: true, state: 'missing' }), true);
  assert.equal(examples.snapshotNeedsExample({ enabled: true, state: 'unreadable' }), true);
  assert.equal(examples.snapshotNeedsExample({ enabled: true, state: 'ok', alive: [] }), false);
  assert.equal(examples.snapshotNeedsExample({ enabled: true, state: 'stale' }), false);

  assert.equal(examples.loreNeedsExample({ enabled: false, state: 'disabled', categories: [] }), true);
  assert.equal(examples.loreNeedsExample({ enabled: true, state: 'missing', categories: [] }), true);
  assert.equal(examples.loreNeedsExample({ enabled: true, state: 'ok', categories: [] }), true);
  assert.equal(examples.loreNeedsExample({
    enabled: true,
    state: 'ok',
    categories: [{ entries: [{ id: 'kept' }] }],
  }), false);

  assert.equal(examples.galleryNeedsExample(null, true), true);
  assert.equal(examples.galleryNeedsExample({ enabled: false, state: 'disabled', photos: [] }, false), true);
  assert.equal(examples.galleryNeedsExample({ enabled: true, state: 'missing', photos: [] }, false), true);
  assert.equal(examples.galleryNeedsExample({ enabled: true, state: 'ok', photos: [] }, false), false);
  assert.equal(examples.galleryNeedsExample({ enabled: true, state: 'none', photos: [] }, false), false);
});

test('the placeholder script is loaded with the page and listed for the package', () => {
  const pkg = require('./package.json');
  assert.equal(pkg.build.files.includes('tgc-placeholders.js'), true);
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const placeholders = html.indexOf('src="tgc-placeholders.js"');
  const renderer = html.indexOf('src="renderer.js"');
  assert.equal(placeholders > 0 && renderer > placeholders, true);
  const rendererSrc = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  assert.match(rendererSrc, /snapshotNeedsExample/);
  assert.match(rendererSrc, /loreNeedsExample/);
  assert.match(rendererSrc, /galleryNeedsExample/);
  assert.match(rendererSrc, /drawExampleMap/);
});
