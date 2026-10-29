// electron-builder beforePack: runs before app files are copied into the package.
// Bakes build-time ACCOUNT_SERVER_URL / BUG_REPORT_URL over config.private.json
// so the packed app contains them, then afterPack restores the working tree.
'use strict';

const path = require('path');
const { stagePrivateConfig, restorePrivateConfig } = require('./private-config');

let exitHooked = false;

exports.default = async function beforePack() {
  const result = stagePrivateConfig(path.resolve(__dirname, '..'), process.env);
  if (!exitHooked) {
    process.on('exit', () => {
      try { restorePrivateConfig(); } catch (_) { /* best effort if the pack fails */ }
    });
    exitHooked = true;
  }
  if (result.unreadable) {
    console.log('  beforePack: config.private.json could not be read. This build ships with those URLs unset.');
    return;
  }
  if (result.included) {
    const how = result.wrote
      ? 'environment variables applied for this pack'
      : 'file packed as-is';
    console.log(`  beforePack: config.private.json included (${how})`);
    return;
  }
  console.log('  beforePack: no private launcher URLs. This build ships with bug reports off and the account server unset.');
};
