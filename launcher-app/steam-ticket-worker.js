// Runs in a short-lived Electron utilityProcess (see account.js), ONE Steam app id per process:
//   argv: <appid> <mode>   mode = "verify" (default) | "probe"
// verify: init Steam for <appid>, get a Web API ticket, trade it with SS_AccountServer
//         (POST /steam/verify {ticket, appid}) for a session, post the result, exit.
// probe:  only check that Steam can init for <appid> (i.e. this account owns it), then exit.
// One app per process because steamworks.js init(appId) sets the SteamAppId env var and the
// Steam API can't switch apps inside a process. Exiting right away means Steam only shows the
// game as "running" for a moment and never blocks steam://run/<appid> when the player hits Play.
// The ticket and session are never logged.
'use strict';

const { STEAM_IDENTITY, ACCOUNT_SERVER_URL, STEAM_APP_IDS } = require('./config');

const appId = Number(process.argv[2]);
const mode = process.argv[3] === 'probe' ? 'probe' : 'verify';

function reply(msg) {
  process.parentPort.postMessage({ appid: appId, ...msg });
}

async function run() {
  if (!STEAM_APP_IDS.includes(appId)) return reply({ ok: false, code: 'bad_appid', message: 'App id not allowed.' });

  let steamworks;
  try {
    steamworks = require('steamworks.js');
  } catch (e) {
    return reply({ ok: false, code: 'steamworks_missing', message: 'steamworks.js is not installed' });
  }

  let client;
  try {
    client = steamworks.init(appId); // sets SteamAppId for this process; no steam_appid.txt needed
  } catch (e) {
    // Steam not running/signed in, or this account doesn't own appId ("ConnectToGlobalUser failed").
    return reply({ ok: false, code: 'steam_init_failed', message: String((e && e.message) || e).slice(0, 200) });
  }
  try {
    const actual = client.utils.getAppId();
    if (actual !== appId) return reply({ ok: false, code: 'steam_wrong_app', message: `Steam initialised app ${actual}, expected ${appId}` });
  } catch (_) { /* older steamworks.js: skip */ }

  if (mode === 'probe') return reply({ ok: true });

  let ticket;
  try {
    ticket = await client.auth.getAuthTicketForWebApi(STEAM_IDENTITY, 15);
  } catch (e) {
    return reply({ ok: false, code: 'steam_ticket_failed', message: 'Steam did not issue a login ticket.' });
  }

  try {
    const hex = Buffer.from(ticket.getBytes()).toString('hex');
    const res = await fetch(`${ACCOUNT_SERVER_URL}/steam/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: hex, appid: appId }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.session !== 'string') {
      return reply({ ok: false, code: body.error || `http_${res.status}`, message: body.message || 'Account server rejected the Steam ticket.' });
    }
    return reply({ ok: true, session: body.session, steamid: String(body.steamid || ''), expires_at: Number(body.expires_at) || 0 });
  } catch (e) {
    return reply({ ok: false, code: 'server_unreachable', message: 'Could not reach the account server.' });
  } finally {
    try { ticket.cancel(); } catch (_) { /* ignore */ }
  }
}

run().finally(() => setTimeout(() => process.exit(0), 50));
