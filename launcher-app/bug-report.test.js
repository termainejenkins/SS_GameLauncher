'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const bug = require('./bug-report');
const cfg = require('./config');

const USER = 'Alice';

function scrub(text) {
  return bug.scrubUserInPaths(text, [USER]);
}

test('scrub: backslashes, forward slashes, mixed case, Users prefix', () => {
  assert.equal(
    scrub('C:\\Users\\Alice\\AppData\\Local\\TGC\\Saved\\Logs\\TGC.log'),
    'C:\\Users\\<user>\\AppData\\Local\\TGC\\Saved\\Logs\\TGC.log',
  );
  assert.equal(
    scrub('C:/Users/Alice/AppData/Local/TGC/Saved/Logs/TGC.log'),
    'C:/Users/<user>/AppData/Local/TGC/Saved/Logs/TGC.log',
  );
  assert.equal(
    scrub('c:\\users\\aLiCe\\Documents\\TGC.log'),
    'c:\\users\\<user>\\Documents\\TGC.log',
  );
  assert.equal(scrub('C:\\Users\\Alice\\'), 'C:\\Users\\<user>\\');
  assert.equal(scrub('C:/users/ALICE'), 'C:/users/<user>');
});

test('scrub: %USERPROFILE%-expanded path', () => {
  const env = { USERNAME: 'Alice', USERPROFILE: 'C:\\Users\\Alice' };
  const expanded = `${env.USERPROFILE}\\Saved\\Logs\\TGC.log`;
  const names = bug.userNamesFromEnv(env);
  assert.equal(
    bug.scrubUserInPaths(expanded, names),
    'C:\\Users\\<user>\\Saved\\Logs\\TGC.log',
  );
});

test('scrub: JSON-escaped double backslashes', () => {
  // File bytes contain C:\\Users\\Alice\\AppData (two backslash chars each).
  const jsonEscaped = 'C:\\\\Users\\\\Alice\\\\AppData\\\\Local\\\\TGC.log';
  assert.equal(jsonEscaped.includes('\\\\'), true);
  assert.equal(
    scrub(jsonEscaped),
    'C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\TGC.log',
  );
  const asJson = JSON.stringify('C:\\Users\\Alice\\AppData\\Local\\TGC.log');
  const scrubbed = scrub(asJson);
  assert.equal(scrubbed.includes('Alice'), false);
  assert.equal(JSON.parse(scrubbed), 'C:\\Users\\<user>\\AppData\\Local\\TGC.log');
});

test('scrub: prose and a longer folder name are left alone', () => {
  assert.equal(scrub('Alice crashed the game near the river.'), 'Alice crashed the game near the river.');
  assert.equal(scrub('C:\\Users\\AliceSmith\\Desktop'), 'C:\\Users\\AliceSmith\\Desktop');
});

test('scrub: description and several path forms in one string', () => {
  const raw = 'Failed at C:\\Users\\Alice\\game and also C:/Users/Alice/game. See C:\\\\Users\\\\Alice\\\\log.';
  const out = bug.cleanUserText(raw, [USER]);
  assert.equal(out.includes('Alice'), false);
  assert.equal(out.includes('<user>'), true);
});

test('description length: 19 fails, 20 and 2000 pass, 2001 fails', () => {
  assert.equal(bug.validateDescription('x'.repeat(19), []).ok, false);
  assert.equal(bug.validateDescription(`  ${'x'.repeat(19)}  `, []).ok, false);
  assert.equal(bug.validateDescription('', []).ok, false);
  assert.equal(bug.validateDescription('   ', []).ok, false);
  const ok20 = bug.validateDescription('x'.repeat(20), []);
  assert.equal(ok20.ok, true);
  assert.equal(ok20.value.length, 20);
  assert.equal(bug.validateDescription('x'.repeat(2000), []).ok, true);
  assert.equal(bug.validateDescription('x'.repeat(2001), []).ok, false);
});

test('description scrub can remove a pasted profile path', () => {
  const text = `Crash path C:\\Users\\${USER}\\AppData\\Local\\x and then the game froze.`;
  const r = bug.validateDescription(text, [USER]);
  assert.equal(r.ok, true);
  assert.equal(r.value.includes(USER), false);
  assert.equal(r.value.includes('<user>'), true);
});

test('file allowlist accepts logs, crash context, and minidumps only', () => {
  const allowed = [
    'manifest.json',
    'system-info.json',
    'logs/TGC.log',
    'logs/TGC_2.log',
    'crashes/UECC-Windows-1/CrashContext.runtime-xml',
    'crashes/UECC-Windows-1/TGC.log',
    'crashes/UECC-Windows-1/UECC-Windows-1.dmp',
    'crashes/UECC-Windows-1/crash.mdmp',
  ];
  for (const name of allowed) assert.equal(bug.isAllowedReportPath(name), true, name);
});

test('file allowlist rejects ini, config, tokens, clipboard, and other folders', () => {
  const rejected = [
    'Saved/Config/Windows/Game.ini',
    'Windows/GameUserSettings.ini',
    'crashes/UECC-Windows-1/CrashReportClient.ini',
    'logs/tokens.log',
    'crashes/UECC-Windows-1/password.txt',
    'clipboard.txt',
    'webhook.txt',
    '../secrets.txt',
    'crashes/UECC-Windows-1/notes.txt',
    'logs/other.log',
    'C:/Users/Alice/TGC.log',
    'crashes/UECC-Windows-1/../../etc/passwd',
    'Saved/Config/GameUserSettings.ini',
  ];
  for (const name of rejected) assert.equal(bug.isAllowedReportPath(name), false, name);
});

test('25 MB cap constant, and a zip over the cap is tailed to the cap', async () => {
  assert.equal(bug.ZIP_MAX_BYTES, 25 * 1024 * 1024);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-bug-'));
  try {
    const logs = path.join(dir, 'TheGreatCircle', 'Saved', 'Logs');
    fs.mkdirSync(logs, { recursive: true });
    const header = 'HEADER_SHOULD_BE_GONE\n';
    const footer = '\nFOOTER_MUST_REMAIN\n';
    // Just over the real 25 MB cap, ASCII so the zip stays stored (no deflate of a huge buffer).
    const fillerLen = bug.ZIP_MAX_BYTES + 1024 * 1024 - header.length - footer.length;
    const log = Buffer.concat([
      Buffer.from(header),
      Buffer.alloc(fillerLen, 0x78),
      Buffer.from(footer),
    ]);
    assert.ok(log.length > bug.ZIP_MAX_BYTES);
    fs.writeFileSync(path.join(logs, 'TGC.log'), log);
    const prepared = bug.prepareBugReport({
      description: 'x'.repeat(40),
      category: 'crash',
      attachLogs: true,
      attachSystemInfo: false,
      userNames: [USER],
      localAppData: dir,
      projectDir: 'TheGreatCircle',
      uploadUrl: cfg.BUG_REPORT_URL,
      forSend: true,
      maxZipBytes: bug.ZIP_MAX_BYTES,
    });
    assert.equal(prepared.ok, true, prepared.error);
    assert.ok(prepared.zip.length <= bug.ZIP_MAX_BYTES, `zip ${prepared.zip.length}`);
    assert.equal(prepared.zip.subarray(0, 4).toString('binary'), 'PK\u0003\u0004');
    const entries = bug.readZipEntries(prepared.zip);
    const packed = entries.find((e) => e.name === 'logs/TGC.log');
    assert.ok(packed, 'log missing');
    const text = packed.data.toString('utf8');
    assert.equal(text.includes('HEADER_SHOULD_BE_GONE'), false);
    assert.equal(text.includes('FOOTER_MUST_REMAIN'), true);
    assert.equal(prepared.notes.some((n) => /shortened/i.test(n)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zip cap tails a small fixture when maxZipBytes is tiny', () => {
  const entries = bug.readZipEntries(bug.buildZip([
    { name: 'logs/TGC.log', data: Buffer.from(`${'START\n'}${'m'.repeat(5000)}\nEND\n`), compressible: false },
  ]));
  assert.equal(entries[0].data.toString('utf8').endsWith('END\n'), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-bug-small-'));
  try {
    const logs = path.join(dir, 'Game', 'Saved', 'Logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'TGC.log'), `START_MARKER\n${'m'.repeat(8000)}\nEND_MARKER\n`);
    const prepared = bug.prepareBugReport({
      description: 'x'.repeat(30),
      category: 'other',
      attachLogs: true,
      attachSystemInfo: false,
      localAppData: dir,
      projectDir: 'Game',
      forSend: true,
      maxZipBytes: 2500,
    });
    assert.equal(prepared.ok, true, prepared.error);
    assert.ok(prepared.zip.length <= 2500);
    const log = bug.readZipEntries(prepared.zip).find((e) => e.name === 'logs/TGC.log');
    const text = log.data.toString('utf8');
    assert.equal(text.includes('END_MARKER'), true);
    assert.equal(text.includes('START_MARKER'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collection keeps the newest crash folder and drops ini, tokens, and config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-bug-files-'));
  try {
    const root = path.join(dir, 'TheGreatCircle', 'Saved');
    const logs = path.join(root, 'Logs');
    const oldCrash = path.join(root, 'Crashes', 'UECC-old');
    const newCrash = path.join(root, 'Crashes', 'UECC-new');
    const configDir = path.join(root, 'Config', 'Windows');
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(oldCrash, { recursive: true });
    fs.mkdirSync(newCrash, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    const secret = 'super-secret-token-value';
    fs.writeFileSync(path.join(configDir, 'Game.ini'), `User=C:\\Users\\${USER}\\\nToken=${secret}\n`);
    fs.writeFileSync(path.join(root, 'clipboard.txt'), 'clipboard should never be read');
    fs.writeFileSync(
      path.join(logs, 'TGC.log'),
      `LogInit: Build: 1.2.3+cl\npath=C:\\Users\\${USER}\\AppData\\Local\\TGC\\Saved\\Logs\\TGC.log\n`
      + `webhook=https://discord.com/api/webhooks/1/${secret}\nsteamid=76561198000000000\n`,
    );
    fs.writeFileSync(path.join(oldCrash, 'CrashContext.runtime-xml'), '<old/>');
    fs.writeFileSync(path.join(newCrash, 'CrashContext.runtime-xml'), `<ctx>C:\\Users\\${USER}\\crash</ctx>`);
    fs.writeFileSync(path.join(newCrash, 'TGC.log'), `C:/Users/${USER}/crash.log`);
    fs.writeFileSync(path.join(newCrash, 'UECC-new.dmp'), Buffer.from('MDMP-not-text'));
    fs.writeFileSync(path.join(newCrash, 'CrashReportClient.ini'), `Password=${secret}`);
    fs.writeFileSync(path.join(newCrash, 'auth-token.txt'), secret);
    const oldTime = new Date('2020-01-01T00:00:00Z');
    const newTime = new Date('2026-10-01T00:00:00Z');
    fs.utimesSync(oldCrash, oldTime, oldTime);
    fs.utimesSync(newCrash, newTime, newTime);

    const prepared = bug.prepareBugReport({
      description: `Crashed after C:\\Users\\${USER}\\AppData load. The animal did not spawn.`,
      category: 'crash',
      attachLogs: true,
      attachSystemInfo: true,
      userNames: [USER],
      localAppData: dir,
      projectDir: 'TheGreatCircle',
      launcherVersion: '1.1.5',
      osVersion: 'win32 10.0.22631 x64',
      cpu: 'Test CPU (4 cores)',
      ramBytes: 1024,
      gpu: { name: 'Test GPU', driverVersion: '1.2.3', vramBytes: 2048 },
      configPath: path.join(dir, 'missing-config.json'),
      uploadUrl: cfg.BUG_REPORT_URL,
      forSend: true,
      settingsPath: path.join(dir, 'settings.json'),
    });
    assert.equal(prepared.ok, true, prepared.error);
    const entries = bug.readZipEntries(prepared.zip);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, [
      'crashes/UECC-new/CrashContext.runtime-xml',
      'crashes/UECC-new/TGC.log',
      'crashes/UECC-new/UECC-new.dmp',
      'logs/TGC.log',
      'manifest.json',
      'system-info.json',
    ]);
    const blob = Buffer.concat(entries.filter((e) => e.name.endsWith('.dmp') === false).map((e) => e.data)).toString('utf8');
    assert.equal(blob.includes(USER), false);
    assert.equal(blob.includes(secret), false);
    assert.equal(blob.includes('76561198000000000'), false);
    assert.equal(blob.includes('discord.com/api/webhooks'), false);
    assert.equal(blob.includes('[webhook]'), true);
    assert.equal(blob.includes('[steam]'), true);
    assert.equal(blob.includes('<user>'), true);
    assert.equal(blob.includes('<old/>'), false);
    assert.equal(blob.includes('clipboard'), false);
    const sys = JSON.parse(entries.find((e) => e.name === 'system-info.json').data.toString('utf8'));
    assert.equal(sys.launcherVersion, '1.1.5');
    assert.equal(sys.gameBuild, '1.2.3+cl');
    assert.equal(sys.gpu, 'Test GPU');
    for (const k of Object.keys(sys)) assert.doesNotMatch(k, /user|host|machine|computer|^ip$/i);
    assert.equal(prepared.description.includes(USER), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('system info drops a username that was handed in as a path', () => {
  const info = bug.buildSystemInfo({
    launcherVersion: '1.1.5',
    gameBuild: null,
    gameBranch: null,
    osVersion: 'win32 10.0.22631 x64',
    cpu: 'AMD Ryzen (8 cores)',
    ramBytes: 16,
    gpu: { name: 'C:\\Users\\Alice\\fake-gpu', driverVersion: '32.0.1', vramBytes: 8 },
  });
  const scrubbed = bug.scrubSystemInfo(info, [USER]);
  const text = JSON.stringify(scrubbed);
  assert.equal(text.includes('Alice'), false);
  assert.equal(scrubbed.gpu.includes('<user>'), true);
  assert.equal(Object.hasOwn(scrubbed, 'username'), false);
  assert.equal(Object.hasOwn(scrubbed, 'hostname'), false);
});

test('install id is a random uuid stored locally and only the sha256 is for upload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-bug-id-'));
  try {
    const file = path.join(dir, 'bug-report-install-id.json');
    const id = bug.loadOrCreateInstallId(file);
    assert.match(id, /^[0-9a-f-]{36}$/i);
    assert.equal(bug.loadOrCreateInstallId(file), id);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.installId, id);
    assert.equal(saved.steamId, undefined);
    const hash = bug.hashInstallId(id);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(hash, id);
    assert.equal(hash, crypto.createHash('sha256').update(id, 'utf8').digest('hex'));
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('placeholder URL sends nothing', async () => {
  let called = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-bug-url-'));
  try {
    const result = await bug.sendBugReport({
      description: 'x'.repeat(30),
      category: 'gameplay',
      attachLogs: false,
      attachSystemInfo: false,
      uploadUrl: cfg.BUG_REPORT_URL,
      settingsPath: path.join(dir, 'id.json'),
      postImpl() { called = true; throw new Error('should not post'); },
    });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_configured');
    assert.match(result.message, /nothing was sent/i);
    assert.equal(bug.isBugReportConfigured(cfg.BUG_REPORT_URL), false);
    assert.equal(cfg.BUG_REPORT_URL, bug.BUG_REPORT_URL_PLACEHOLDER);
    assert.equal(cfg.GAME_SAVED_PROJECT_DIR, 'TheGreatCircle');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('429 response is explained with Retry-After', () => {
  const r = bug.interpretUploadResponse(429, { 'retry-after': '3600' }, '{"error":"rate_limited"}');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rate_limited');
  assert.equal(r.retryAfter, 3600);
  assert.match(r.message, /too many bug reports/i);
  assert.match(r.message, /1h/);
});

test('multipart upload posts the zip and the hash, not the raw install id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgc-bug-http-'));
  const settings = path.join(dir, 'id.json');
  const id = bug.loadOrCreateInstallId(settings);
  let body = Buffer.alloc(0);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      body = Buffer.concat(chunks);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'report-1' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await bug.sendBugReport({
      description: 'The zebra clipped through the camp at dusk.',
      category: 'gameplay',
      attachLogs: false,
      attachSystemInfo: true,
      launcherVersion: '1.1.5',
      osVersion: 'test-os',
      cpu: 'test-cpu',
      ramBytes: 10,
      gpu: { name: 'Test GPU', driverVersion: '9', vramBytes: 1 },
      uploadUrl: 'https://reports.example.com/api/bug-report',
      settingsPath: settings,
      postImpl(url, req) {
        return new Promise((resolve, reject) => {
          const u = new URL(url);
          const r = http.request({
            method: 'POST',
            hostname: '127.0.0.1',
            port,
            path: u.pathname,
            headers: req.headers,
          }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
              status: res.statusCode,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }));
          });
          r.on('error', reject);
          r.end(req.body);
        });
      },
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.id, 'report-1');
    const text = body.toString('utf8');
    assert.equal(text.includes(id), false);
    assert.equal(text.includes(bug.hashInstallId(id)), true);
    assert.equal(text.includes('name="category"'), true);
    assert.equal(body.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);
    assert.equal(text.includes('screenshot'), false);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshot magic and size cap', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.equal(bug.validateScreenshot(png, 'shot.PNG').filename, 'screenshot.png');
  assert.equal(bug.validateScreenshot(jpg, 'a.jpeg').contentType, 'image/jpeg');
  assert.equal(bug.validateScreenshot(png, 'shot.gif').ok, false);
  assert.equal(bug.validateScreenshot(Buffer.from('not an image'), 'shot.png').ok, false);
  const big = Buffer.concat([png, Buffer.alloc(bug.SCREENSHOT_MAX_BYTES)]);
  assert.equal(bug.validateScreenshot(big, 'shot.png').code, 'screenshot_too_large');
  assert.equal(bug.SCREENSHOT_MAX_BYTES, 8 * 1024 * 1024);
});

test('launcher page has the report form fields', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /Report a bug/);
  assert.match(html, /id="bug-category"/);
  assert.match(html, /value="crash"/);
  assert.match(html, /value="performance"/);
  assert.match(html, /value="gameplay"/);
  assert.match(html, /value="other"/);
  assert.match(html, /id="bug-logs" checked/);
  assert.match(html, /id="bug-sys" checked/);
  assert.match(html, /id="bug-preview"/);
  assert.match(html, /id="bug-shot"/);
  assert.match(html, /used only to fix bugs/i);
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  assert.match(preload, /previewBugReport/);
  assert.match(preload, /sendBugReport/);
  assert.match(preload, /pickScreenshot/);
});
