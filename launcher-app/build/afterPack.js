// electron-builder afterPack hook: sets the SS icon and file details on TGC_Launcher.exe.
// (electron-builder's own exe editing needs a download that fails without Windows symlink rights,
//  so "signAndEditExecutable" is off and rcedit does it here instead.)
'use strict';
const path = require('path');
const rcedit = require('rcedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, `${context.packager.platformSpecificBuildOptions.executableName || context.packager.appInfo.productFilename}.exe`);
  const version = context.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(context.packager.projectDir, 'assets', 'brand', 'ss_appicon_win_multi_v2.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      CompanyName: 'Sentient Solutions',
      FileDescription: 'SS Game Launcher',
      ProductName: 'SS Game Launcher',
      InternalName: 'TGC_Launcher',
      OriginalFilename: 'TGC_Launcher.exe',
      LegalCopyright: 'Sentient Solutions',
    },
  });
  console.log('  afterPack: icon + version info set on', path.basename(exe));
};
