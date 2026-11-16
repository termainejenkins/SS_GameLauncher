// Example rows for the TGC tabs when the local snapshot cannot be shown.
// Public stand-in copy only. Not the fixture, and not a profile.
'use strict';

(function (root) {
  const BADGE = 'Example data, not final content';

  function snapshotNeedsExample(view) {
    if (!view || view.enabled === false) return true;
    return view.state !== 'ok' && view.state !== 'stale';
  }

  function loreNeedsExample(view) {
    if (!view || view.enabled === false) return true;
    if (view.state !== 'ok') return true;
    const count = (view.categories || []).reduce((total, group) => {
      return total + ((group && group.entries && group.entries.length) || 0);
    }, 0);
    return count === 0;
  }

  function galleryNeedsExample(listed, snapshotIsExample) {
    if (snapshotIsExample) return true;
    if (!listed || listed.enabled === false) return true;
    if (listed.state === 'ok' || listed.state === 'none') return false;
    return true;
  }

  function exampleCharacter(n, status) {
    const alive = status !== 'DEAD';
    return {
      characterId: `example-${n}`,
      speciesId: 'Example species',
      speciesByte: null,
      status: alive ? 'ALIVE' : 'DEAD',
      name: `Example Character ${n}`,
      level: alive ? 1 : null,
      daysSurvived: n,
      lastUpdatedUnix: null,
      createdUnix: null,
      location: alive ? { region: 'Example Region', worldKey: null } : null,
      vitals: alive ? { health: 0.75, stamina: 0.5, hunger: 0.25, thirst: 0.4 } : {},
      base: alive ? { attack: 10, defense: 8, speed: 5 } : {},
      statusEffects: [],
      inventory: alive ? { items: 1, maxSlots: 4 } : null,
      history: alive ? [{ unixTime: null, type: 'Example event', value: 1 }] : [],
      photoCount: null,
      photoIndexPath: null,
      map: null,
    };
  }

  function exampleSnapshot() {
    return {
      enabled: true,
      state: 'ok',
      example: true,
      message: '',
      savedAtUnix: null,
      saveSlotIndex: null,
      game: null,
      personaName: null,
      personaSource: null,
      lastCharacterId: 'example-1',
      account: null,
      alive: [exampleCharacter(1, 'ALIVE'), exampleCharacter(2, 'ALIVE')],
      graveyard: [exampleCharacter(3, 'DEAD')],
      maps: {},
    };
  }

  function exampleLore() {
    return {
      enabled: true,
      state: 'ok',
      example: true,
      unlocked: 2,
      total: 3,
      ignored: [],
      categories: [
        {
          category: 'Example category',
          entries: [
            {
              id: 'example-lore-1',
              locked: false,
              title: 'Example Lore Entry',
              category: 'Example category',
              text: 'Example text for a lore entry. This is not final content.',
              image: null,
            },
            {
              id: 'example-lore-2',
              locked: false,
              title: 'Example Lore Entry 2',
              category: 'Example category',
              text: 'A second example entry. This is not final content.',
              image: null,
            },
            {
              id: 'example-lore-3',
              locked: true,
              title: '???',
              category: 'Example category',
              text: null,
              image: null,
            },
          ],
        },
      ],
    };
  }

  function exampleGallery() {
    return [
      { caption: 'Example photo 1' },
      { caption: 'Example photo 2' },
      { caption: 'Example photo 3' },
    ];
  }

  const api = {
    BADGE,
    snapshotNeedsExample,
    loreNeedsExample,
    galleryNeedsExample,
    exampleSnapshot,
    exampleLore,
    exampleGallery,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TGCExamples = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
