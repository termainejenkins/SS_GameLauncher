// Main-process gate for the debug console. No Electron import, so node --test can call it.
// The renderer may hide the switch. Only handleDebugConsoleToggle may open DevTools.
'use strict';

function debugConsoleDecision(developer, open) {
  if (!developer) return { ok: false, reason: 'not_developer', open: false };
  return { ok: true, open: !!open };
}

/**
 * Body of the dev:toggle-console IPC handler.
 * isDeveloperFn is the main-process check (signed token, fresh server fetch).
 * applyOpen runs only after that check passes.
 */
async function handleDebugConsoleToggle({ isDeveloperFn, open, applyOpen }) {
  const developer = typeof isDeveloperFn === 'function' ? await isDeveloperFn() : false;
  const decision = debugConsoleDecision(developer, open);
  if (!decision.ok) return decision;
  if (typeof applyOpen === 'function') {
    const applied = await applyOpen(decision.open);
    if (typeof applied === 'boolean') return { ok: true, open: applied };
  }
  return decision;
}

module.exports = { debugConsoleDecision, handleDebugConsoleToggle };
