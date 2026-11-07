// Runs with contextIsolation + sandbox: no require(). Everything native goes through window.launcher (preload.js).
// `launcher` is the global that preload.js exposes via contextBridge (window.launcher).
const BACKEND_URL = 'http://localhost:3000';

// Hero art: v9 (Juma + Kivuli) or the trio (Jasiri, Lyanne, Kivuli), picked at random each time the launcher opens.
// No class = v9 (styles.css .hero-art); .hero-trio swaps in the trio image.
document.querySelector('.hero-art')?.classList.toggle('hero-trio', Math.random() < 0.5);

// Render news content as plain text. HTML from the server is parsed inertly (DOMParser does not run
// scripts or load images) and only http(s) links are kept, as text anchors that open in the system browser.
function renderNewsContent(container, html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) container.appendChild(document.createTextNode(text));
  doc.body.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (!/^https?:\/\//i.test(href)) return;
    container.appendChild(document.createElement('br'));
    const link = document.createElement('a');
    link.href = href;
    link.textContent = (a.textContent || href).trim() || href;
    link.onclick = (e) => { e.preventDefault(); launcher.openExternal(href); };
    container.appendChild(link);
  });
}

window.onload = () => {
  // Fetch news from backend
  fetch(`${BACKEND_URL}/news`)
    .then(res => res.json())
    .then(news => {
      const newsList = document.getElementById('news-list');
      newsList.innerHTML = '';
      news.forEach(item => {
        const div = document.createElement('div');
        div.className = 'news-item';
        const title = document.createElement('strong');
        title.textContent = item.title;
        div.appendChild(title);
        div.appendChild(document.createElement('br'));
        renderNewsContent(div, item.content);
        newsList.appendChild(div);
      });
    })
    .catch(() => {
      document.getElementById('news-list').innerText = 'Failed to load news.';
    });

  // Launcher self-update status (main process / electron-updater). The old localhost /updates panel is gone:
  // it compared a hardcoded game version against a dev-only server. The Steam copy shows nothing here.
  const updateDiv = document.getElementById('update');
  const updateContent = document.getElementById('update-content');
  const updateIdle = document.querySelector('#downloads .idle');
  function renderUpdate(st) {
    if (!st || st.state === 'disabled') { updateDiv.style.display = 'none'; return; }
    updateContent.textContent = '';
    let text = '';
    if (st.state === 'downloading') text = `Downloading launcher update${st.version ? ' v' + st.version : ''}... ${st.percent || 0}%`;
    else if (st.state === 'ready') text = `SS Game Launcher v${st.version} is ready to install.`;
    else if (st.state === 'checking') text = 'Checking for launcher updates...';
    else if (st.state === 'up_to_date') text = `SS Game Launcher v${st.current} is up to date.`;
    else if (st.state === 'error') text = `SS Game Launcher v${st.current}. Could not check for updates right now.`;
    else text = `SS Game Launcher v${st.current}`;
    updateContent.appendChild(document.createTextNode(text));
    if (st.state === 'ready') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm';
      btn.style.marginLeft = '8px';
      btn.textContent = 'Restart and update';
      btn.onclick = async () => {
        const r = await launcher.installUpdate().catch(() => ({ ok: false }));
        if (!r || !r.ok) showToast(r && r.reason === 'game_running' ? 'Close the game first, then update.' : 'Update will install next time you close the launcher.');
      };
      updateContent.appendChild(btn);
      const later = document.createElement('div');
      later.className = 'muted';
      later.textContent = 'Or keep playing: it installs automatically when you close the launcher.';
      updateContent.appendChild(later);
    }
    updateDiv.style.display = 'block';
    if (updateIdle) updateIdle.style.display = st.state === 'ready' || st.state === 'downloading' ? 'none' : '';
  }
  let lastUpdateState = '';
  launcher.onUpdateStatus((st) => {
    renderUpdate(st);
    if (st && st.state === 'ready' && lastUpdateState !== 'ready') showToast(`Launcher update v${st.version} downloaded. Restart to install.`, 6000);
    lastUpdateState = st ? st.state : '';
  });
  launcher.getUpdateStatus().then(renderUpdate).catch(() => { updateDiv.style.display = 'none'; });

  // Launcher version line under the sidebar brand, e.g. "v1.1.1".
  const versionLabel = document.getElementById('launcher-version');
  if (versionLabel) launcher.getVersion().then((v) => { if (v) { versionLabel.textContent = `v${v}`; versionLabel.title = `SS Game Launcher v${v}`; } }).catch(() => {});

  // Launch method radio buttons and URL input
  const steamRadio = document.querySelector('input[name="launch-method"][value="steam"]');
  const urlRadio = document.querySelector('input[name="launch-method"][value="url"]');
  const urlInput = document.getElementById('custom-url');

  steamRadio.onchange = urlRadio.onchange = () => {
    urlInput.disabled = !urlRadio.checked;
  };

  const playBtn = document.getElementById('play-ue4');
  playBtn.onclick = async () => {
    let opts;
    if (steamRadio.checked) {
      sendAnalytics('launch_ue4_game', { method: 'steam' });
      opts = { method: 'steam' };
    } else {
      const url = urlInput.value.trim();
      if (!url) {
        showToast('Please enter a URL to launch.');
        sendAnalytics('launch_ue4_game_error', { error: 'No URL entered' });
        return;
      }
      sendAnalytics('launch_ue4_game', { method: 'url', url });
      opts = { method: 'url', url };
    }
    playBtn.disabled = true;
    const oldLabel = playBtn.textContent;
    playBtn.textContent = 'Checking unlocks...';
    try {
      const result = await launcher.play(opts);
      handleLaunchResult(result);
      if (result && result.entitlement && !result.entitlement.skipped && !result.entitlement.error) renderAccount(result.entitlement);
    } catch (e) {
      handleLaunchResult({ success: false, error: String(e && e.message || e) });
    } finally {
      playBtn.disabled = false;
      playBtn.textContent = oldLabel;
    }
  };

  // Toast notification function
  function showToast(message, ms = 3000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.opacity = 1; }, 10);
    setTimeout(() => {
      toast.style.opacity = 0;
      setTimeout(() => { toast.style.display = 'none'; }, 300);
    }, ms);
  }

  // Play couldn't start the game through Steam: explain why and offer the next step. Built like the consent modal.
  const STEAM_DEMO_STORE_WEB = 'https://store.steampowered.com/app/1865070/';
  async function openSteamLink(steamUrl, webUrl) {
    const ok = await launcher.openExternal(steamUrl).catch(() => false);
    if (!ok && webUrl) await launcher.openExternal(webUrl).catch(() => false);
  }
  function showPlayHelp(code, demoAppId) {
    const old = document.getElementById('play-help');
    if (old) old.remove();
    const notOwned = code === 'not_owned';
    const demo = Number(demoAppId) || 1865070;
    const modal = document.createElement('div');
    modal.className = 'consent-backdrop';
    modal.id = 'play-help';
    modal.innerHTML = `
      <div class="card consent play-help" role="dialog" aria-modal="true" aria-labelledby="play-help-title">
        <h2 id="play-help-title"></h2>
        <p id="play-help-text"></p>
        <div class="row">
          <button id="play-help-go" class="btn btn-primary"></button>
          <button id="play-help-close" class="btn">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('play-help-title').textContent = notOwned ? "You don't have THE GREAT CIRCLE on Steam yet" : "Steam isn't running";
    document.getElementById('play-help-text').textContent = notOwned
      ? 'The free demo is out now. Add it to your Steam library, then press Play again. Already own it? Make sure Steam is signed in to that account.'
      : 'Start Steam and sign in, then press Play again.';
    const go = document.getElementById('play-help-go');
    go.textContent = notOwned ? 'Get the free demo on Steam' : 'Open Steam';
    const close = () => { document.removeEventListener('keydown', onKey); modal.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.getElementById('play-help-close').onclick = close;
    go.onclick = async () => {
      if (notOwned) await openSteamLink(`steam://store/${demo}`, STEAM_DEMO_STORE_WEB);
      else await openSteamLink('steam://open/main', null);
      close();
    };
    go.focus();
  }

  function handleLaunchResult(result) {
    if (result.success) {
      showToast(result.mode === 'exe' ? 'Starting THE GREAT CIRCLE...' : 'UE4 game launched!');
    } else if (result.code === 'not_owned' || result.code === 'steam_not_running') {
      showPlayHelp(result.code, result.demoAppId);
      sendAnalytics('launch_ue4_game_error', { error: result.code });
    } else if (['game_missing', 'game_exited', 'spawn_failed', 'steam_loop', 'game_running'].includes(result.code)) {
      showToast(result.error, 12000); // launcher-side launch errors are already written for players
      sendAnalytics('launch_ue4_game_error', { error: result.code });
    } else {
      let msg = 'Failed to launch UE4 game: ' + result.error;
      if (result.error && result.error.toLowerCase().includes('license')) {
        msg = 'Steam reported a license error. Please ensure you own the demo and try again later. If the problem persists, it may be a temporary Steam issue.';
      }
      showToast(msg);
      sendAnalytics('launch_ue4_game_error', { error: result.error });
    }
  }

  // ---------------- Discord account link ----------------
  const ENTITLEMENT_LABELS = {
    supporter: 'Supporter',
    restricted_content: 'Restricted Content',
    alpha_builds: 'Alpha Builds',
    nightly_builds: 'Nightly Builds',
    multiplayer: 'Multiplayer',
  };
  const REASON_TEXT = {
    not_linked: 'Not linked yet.',
    relink_required: 'Discord access was revoked or expired. Please link again.',
    session_expired: 'Your sign-in expired. Press Link Discord again.',
    steam_not_running: 'Steam is not running or you are not signed in. Start Steam and try again.',
    steam_not_owned: "This Steam account doesn't own THE GREAT CIRCLE or its demo.",
    steamworks_missing: 'Steam support is missing from this launcher build.',
    steam_ticket_failed: 'Steam did not issue a login ticket. Try again.',
    steam_timeout: 'Steam did not answer in time. Try again.',
    steam_ticket_invalid: 'The account server could not verify your Steam login.',
    server_unreachable: 'Could not reach the account server. Check your connection.',
    link_timeout: 'Timed out waiting for Discord. Press Link Discord to try again.',
    token_bad_signature: 'Unlock token failed its signature check.',
    token_expired: 'Your unlocks expired. Press Play or Link Discord to refresh.',
  };
  const accountStatus = document.getElementById('account-status');
  const accountDetail = document.getElementById('account-detail');
  const accountEnts = document.getElementById('account-entitlements');
  const linkBtn = document.getElementById('link-discord');
  const linkDoneBtn = document.getElementById('link-done');
  const accountAvatar = document.getElementById('account-avatar');
  const accountState = document.getElementById('account-state');
  const gameBadge = document.getElementById('account-game-badge');

  function renderAccount(st) {
    if (!st) return;
    loadBranches(st); // test-branch passwords, only when linked
    accountEnts.textContent = '';
    gameBadge.style.display = 'none';
    gameBadge.className = 'badge';
    if (st.linked) {
      const who = st.discordUsername ? `@${st.discordUsername}` : `Discord ID ${st.discordId}`;
      accountStatus.textContent = who;
      accountAvatar.textContent = (st.discordUsername || 'D').trim().charAt(0).toUpperCase();
      accountAvatar.classList.remove('off');
      accountState.textContent = st.source === 'cache' ? 'Linked (offline)' : 'Linked';
      accountState.classList.add('on');
      if (st.ownsFullGame === true || st.ownsFullGame === false) {
        gameBadge.textContent = st.ownsFullGame ? 'Full game' : 'Demo';
        gameBadge.classList.add(st.ownsFullGame ? 'badge-full' : 'badge-demo');
        gameBadge.style.display = 'inline-flex';
      }
      const parts = [];
      if (st.inGuild === false) parts.push('Not in the SENTIENT GAMES server, so nothing unlocks yet.');
      if (st.expiresAt) parts.push(`Unlocks valid until ${new Date(st.expiresAt * 1000).toLocaleString()}.`);
      accountDetail.textContent = parts.join(' ');
      const tier = Number(st.tier) || 0;
      if (tier >= 1) {
        const li = document.createElement('li');
        li.className = `tier tier-${tier}`;
        li.textContent = `${st.tierName || 'Supporter'} supporter`;
        accountEnts.appendChild(li);
      }
      // The tier chip already says "supporter"; don't repeat it.
      const ents = (Array.isArray(st.entitlements) ? st.entitlements : []).filter(e => !(tier >= 1 && e === 'supporter'));
      if (!ents.length && tier < 1) {
        const li = document.createElement('li');
        li.className = 'ent-none';
        li.textContent = 'No unlocks from your current Discord roles';
        accountEnts.appendChild(li);
      }
      ents.forEach(e => {
        const li = document.createElement('li');
        li.className = 'ent-' + String(e).replace(/[^a-z0-9_-]/gi, '');
        li.textContent = ENTITLEMENT_LABELS[e] || e;
        accountEnts.appendChild(li);
      });
      linkBtn.textContent = 'Relink Discord';
    } else {
      accountStatus.textContent = 'Discord not linked';
      accountAvatar.textContent = '?';
      accountAvatar.classList.add('off');
      accountState.textContent = 'Not linked';
      accountState.classList.remove('on');
      accountDetail.textContent = REASON_TEXT[st.reason] || (st.message || (st.reason ? `(${st.reason})` : ''));
      const li = document.createElement('li');
      li.className = 'ent-none';
      li.textContent = 'Link to unlock supporter content';
      accountEnts.appendChild(li);
      linkBtn.textContent = 'Link Discord';
    }
  }

  launcher.onLinkProgress((stage) => {
    if (stage === 'steam') accountDetail.textContent = 'Checking your Steam login...';
    if (stage === 'browser') accountDetail.textContent = 'Opening Discord in your browser...';
    if (stage === 'waiting') {
      accountDetail.textContent = 'Approve the link in your browser, then come back here.';
      linkDoneBtn.style.display = 'inline-block';
    }
  });

  linkBtn.onclick = async () => {
    linkBtn.disabled = true;
    try {
      const st = await launcher.linkDiscord();
      renderAccount(st);
      if (st && st.linked && !st.timedOut) showToast('Discord linked!');
      else if (st && st.error) showToast(REASON_TEXT[st.reason] || 'Link failed.');
    } catch (e) {
      showToast('Link failed: ' + (e && e.message || e));
    } finally {
      linkBtn.disabled = false;
      linkDoneBtn.style.display = 'none';
    }
  };
  linkDoneBtn.onclick = () => launcher.cancelLink();

  // ---------------- Steam test branches ----------------
  // Passwords stay in this closure and the main process's memory. They are never put in localStorage,
  // analytics, toasts or the console, and the DOM only shows one while its Show toggle is on.
  const branchesCard = document.getElementById('branches');
  const branchesList = document.getElementById('branches-list');
  const branchesEmpty = document.getElementById('branches-empty');
  const branchesRefresh = document.getElementById('branches-refresh');
  const REVEAL_MS = 30 * 1000; // a revealed code hides itself again after this long
  const BRANCH_REASON = {
    no_session: 'Press Relink Discord to load your test branches.',
    session_expired: 'Your sign-in expired. Press Relink Discord to load your test branches.',
    not_linked: '',
    server_unreachable: 'Could not reach the account server. Try Refresh.',
  };
  let branchesBusy = false;

  function clearBranches() {
    branchesList.textContent = '';
    branchesEmpty.hidden = true;
  }

  function branchRow(b) {
    const li = document.createElement('li');
    li.className = 'branch-row';
    const name = document.createElement('div');
    name.className = 'branch-name';
    name.textContent = b.branch;
    const actions = document.createElement('div');
    actions.className = 'branch-actions';
    const code = document.createElement('span');
    code.className = 'branch-code masked';
    code.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'btn btn-sm btn-ghost';
    reveal.textContent = 'Show';
    reveal.setAttribute('aria-pressed', 'false');
    let hideTimer = null;
    const hide = () => {
      clearTimeout(hideTimer);
      code.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      code.classList.add('masked');
      reveal.textContent = 'Show';
      reveal.setAttribute('aria-pressed', 'false');
    };
    reveal.onclick = () => {
      if (code.classList.contains('masked')) {
        code.textContent = b.password;
        code.classList.remove('masked');
        reveal.textContent = 'Hide';
        reveal.setAttribute('aria-pressed', 'true');
        hideTimer = setTimeout(hide, REVEAL_MS);
      } else hide();
    };
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-sm';
    copy.textContent = 'Copy';
    copy.onclick = async () => { // the ONLY path that writes the clipboard: an explicit click
      const ok = await launcher.copyBranchPassword(b.branch).catch(() => false);
      showToast(ok ? `Code for ${b.branch} copied. Paste it in Steam > Betas.` : 'Could not copy. Try Refresh.');
    };
    actions.append(code, reveal, copy);
    li.append(name, actions);
    if (b.label) {
      const label = document.createElement('div');
      label.className = 'branch-label';
      label.textContent = b.label;
      li.appendChild(label);
    }
    return li;
  }

  async function loadBranches(st) {
    if (!st || !st.linked) { clearBranches(); branchesCard.hidden = true; return; }
    if (branchesBusy) return;
    branchesBusy = true;
    try {
      const r = await launcher.getBranches();
      clearBranches();
      if (r && r.ok && r.branches.length) {
        r.branches.forEach((b) => branchesList.appendChild(branchRow(b)));
        branchesCard.hidden = false;
      } else if (r && r.ok) {
        branchesCard.hidden = true; // linked, but no tier that grants a test branch
      } else {
        const msg = BRANCH_REASON[r && r.reason];
        branchesCard.hidden = !msg;
        if (msg) { branchesEmpty.textContent = msg; branchesEmpty.hidden = false; }
      }
    } catch (_) {
      clearBranches();
      branchesCard.hidden = true;
    } finally {
      branchesBusy = false;
    }
  }

  branchesRefresh.onclick = () => launcher.getLinkStatus().then(renderAccount).catch(() => {});

  accountStatus.textContent = 'Checking Discord link...';
  launcher.getLinkStatus().then(renderAccount).catch(() => {
    accountStatus.textContent = 'Discord link status unavailable';
  });

  // Load saved URL from localStorage
  urlInput.value = localStorage.getItem('customGameUrl') || '';

  urlInput.addEventListener('input', () => {
    localStorage.setItem('customGameUrl', urlInput.value);
  });

  // Theme toggle logic
  const themeToggle = document.getElementById('theme-toggle');
  const themeLabel = document.getElementById('theme-label');

  function setTheme(mode) {
    document.body.classList.toggle('theme-light', mode === 'light');
    themeLabel.textContent = mode === 'light' ? 'Light Mode' : 'Dark Mode';
    localStorage.setItem('theme', mode);
  }

  // Load theme preference
  const savedTheme = localStorage.getItem('theme') || 'dark';
  themeToggle.checked = savedTheme === 'dark';
  setTheme(savedTheme);

  themeToggle.onchange = () => {
    setTheme(themeToggle.checked ? 'dark' : 'light');
  };

  // Analytics consent logic
  const analyticsToggle = document.getElementById('analytics-toggle');
  const analyticsLabel = document.getElementById('analytics-label');
  function isAnalyticsEnabled() {
    return localStorage.getItem('analytics') === 'true';
  }
  function setAnalytics(enabled) {
    localStorage.setItem('analytics', enabled ? 'true' : 'false');
    analyticsToggle.checked = enabled;
    analyticsLabel.textContent = enabled ? 'Analytics Enabled' : 'Enable Analytics';
  }
  analyticsToggle.onchange = () => setAnalytics(analyticsToggle.checked);
  setAnalytics(isAnalyticsEnabled());

  // Debug console. Hidden unless main says this account is a developer. The switch is cosmetic;
  // dev:toggle-console in the main process is what opens DevTools, and it refuses otherwise.
  const debugRow = document.getElementById('debug-console-row');
  const debugToggle = document.getElementById('debug-console-toggle');
  async function applyDevStatus() {
    let st = null;
    try { st = await launcher.getDevStatus(); } catch (_) { st = null; }
    const developer = !!(st && st.developer);
    if (debugRow) debugRow.hidden = !developer;
    if (debugToggle && !developer) debugToggle.checked = false;
  }
  if (debugToggle) {
    debugToggle.addEventListener('change', async () => {
      const want = debugToggle.checked;
      let result = null;
      try { result = await launcher.toggleDebugConsole(want); } catch (_) { result = null; }
      if (!result || !result.ok) {
        debugToggle.checked = false;
        if (debugRow) debugRow.hidden = true;
        return;
      }
      debugToggle.checked = !!result.open;
    });
  }
  applyDevStatus();

  function sendAnalytics(event, data = {}) {
    if (!isAnalyticsEnabled()) return;
    fetch(`${BACKEND_URL}/analytics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...data, timestamp: new Date().toISOString() })
    }).catch(() => {});
  }

  // Track launcher open
  sendAnalytics('launcher_open');

  // Bug report. Preview stays on this machine; Send is the only upload.
  const errorMsgInput = document.getElementById('error-message');
  const submitErrorBtn = document.getElementById('submit-error');
  const bugCategory = document.getElementById('bug-category');
  const bugLogs = document.getElementById('bug-logs');
  const bugSys = document.getElementById('bug-sys');
  const bugPreview = document.getElementById('bug-preview');
  const bugStatus = document.getElementById('bug-status');
  const bugCount = document.getElementById('bug-desc-count');
  const bugShot = document.getElementById('bug-shot');
  const bugShotName = document.getElementById('bug-shot-name');
  const bugShotClear = document.getElementById('bug-shot-clear');

  function formatBytes(n) {
    const bytes = Number(n) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  function bugOpts() {
    return {
      description: errorMsgInput ? errorMsgInput.value : '',
      category: bugCategory ? bugCategory.value : 'other',
      attachLogs: !!(bugLogs && bugLogs.checked),
      attachSystemInfo: !!(bugSys && bugSys.checked),
    };
  }
  function setBugStatus(message, kind) {
    if (!bugStatus) return;
    bugStatus.textContent = message || '';
    bugStatus.className = `bug-status${kind ? ` ${kind}` : ''}`;
  }
  function updateBugCount() {
    if (!bugCount || !errorMsgInput) return;
    const n = errorMsgInput.value.trim().length;
    bugCount.textContent = n < 20 ? `${n} / 2000 (at least 20)` : `${n} / 2000`;
    bugCount.className = n > 0 && n < 20 ? 'muted bug-count warn' : 'muted bug-count';
  }
  function renderBugPreview(p) {
    if (!bugPreview) return;
    bugPreview.textContent = '';
    if (!p || p.ok === false) {
      bugPreview.textContent = (p && (p.error || p.message)) || 'Could not build a preview.';
      return;
    }
    const list = document.createElement('ul');
    const zip = document.createElement('li');
    zip.textContent = `report.zip — ${formatBytes(p.zipBytes)}`;
    list.appendChild(zip);
    (p.zipEntries || []).forEach((f) => {
      const li = document.createElement('li');
      li.textContent = `  ${f.name} — ${formatBytes(f.bytes)}`;
      list.appendChild(li);
    });
    if (p.screenshot) {
      const li = document.createElement('li');
      li.textContent = `${p.screenshot.name} — ${formatBytes(p.screenshot.bytes)}`;
      list.appendChild(li);
    }
    bugPreview.appendChild(list);
    const total = document.createElement('div');
    total.textContent = `Total upload ${formatBytes(p.totalBytes)}`;
    bugPreview.appendChild(total);
    (p.notes || []).forEach((note) => {
      const line = document.createElement('div');
      line.textContent = note;
      bugPreview.appendChild(line);
    });
    if (p.configured === false) {
      const off = document.createElement('div');
      off.textContent = 'Sending is off until BUG_REPORT_URL is set. Nothing will be uploaded.';
      bugPreview.appendChild(off);
    }
  }
  let bugPreviewGen = 0;
  let bugPreviewTimer = null;
  let bugSending = false;
  async function refreshBugPreview() {
    if (!window.launcher || !launcher.previewBugReport || !bugPreview) return;
    const gen = ++bugPreviewGen;
    try {
      const p = await launcher.previewBugReport(bugOpts());
      if (gen !== bugPreviewGen) return;
      renderBugPreview(p);
    } catch (_) {
      if (gen === bugPreviewGen) bugPreview.textContent = 'Could not build a preview.';
    }
  }
  function scheduleBugPreview() {
    clearTimeout(bugPreviewTimer);
    bugPreviewTimer = setTimeout(refreshBugPreview, 200);
  }
  if (errorMsgInput) errorMsgInput.addEventListener('input', () => { updateBugCount(); scheduleBugPreview(); });
  if (bugCategory) bugCategory.onchange = scheduleBugPreview;
  if (bugLogs) bugLogs.onchange = scheduleBugPreview;
  if (bugSys) bugSys.onchange = scheduleBugPreview;
  updateBugCount();
  if (bugShot) {
    bugShot.onclick = async () => {
      if (!launcher.pickScreenshot) return;
      const r = await launcher.pickScreenshot().catch(() => null);
      if (!r) return;
      if (r.error) { setBugStatus(r.error, 'bad'); return; }
      if (r.picked) {
        bugShotName.textContent = `${r.name} (${formatBytes(r.bytes)})`;
        bugShotClear.hidden = false;
        setBugStatus('', '');
        refreshBugPreview();
      }
    };
  }
  if (bugShotClear) {
    bugShotClear.onclick = async () => {
      if (launcher.clearScreenshot) await launcher.clearScreenshot().catch(() => {});
      bugShotName.textContent = '';
      bugShotClear.hidden = true;
      refreshBugPreview();
    };
  }
  if (submitErrorBtn) {
    submitErrorBtn.onclick = async () => {
      if (bugSending) return;
      const opts = bugOpts();
      const n = opts.description.trim().length;
      if (n < 20) { setBugStatus('Description must be at least 20 characters.', 'bad'); return; }
      if (n > 2000) { setBugStatus('Description must be at most 2000 characters.', 'bad'); return; }
      bugSending = true;
      submitErrorBtn.disabled = true;
      setBugStatus('Sending…', '');
      try {
        const r = await launcher.sendBugReport(opts);
        if (r && r.ok) {
          setBugStatus(r.message || 'Bug report sent. Thank you.', 'ok');
          showToast(r.message || 'Bug report sent. Thank you.');
          errorMsgInput.value = '';
          updateBugCount();
          if (launcher.clearScreenshot) await launcher.clearScreenshot().catch(() => {});
          bugShotName.textContent = '';
          bugShotClear.hidden = true;
        } else {
          setBugStatus((r && r.message) || 'Could not send the bug report.', 'bad');
        }
      } catch (_) {
        setBugStatus('Could not send the bug report.', 'bad');
      } finally {
        bugSending = false;
        submitErrorBtn.disabled = false;
        refreshBugPreview();
      }
    };
  }
  refreshBugPreview();

  // Web game embedding logic
  const webgameModal = document.getElementById('webgame-modal');
  const webgameFrame = document.getElementById('webgame-frame');
  const playWebBtn = document.getElementById('play-web');
  const closeWebgameBtn = document.getElementById('close-webgame');

  if (playWebBtn && webgameModal && webgameFrame) {
    playWebBtn.onclick = () => {
      // Use saved URL if available, else default
      const savedUrl = localStorage.getItem('customGameUrl') || 'https://example.com/webgame';
      webgameFrame.src = savedUrl;
      webgameModal.style.display = 'flex';
    };
  }
  if (closeWebgameBtn && webgameModal) {
    closeWebgameBtn.onclick = () => {
      webgameModal.style.display = 'none';
      webgameFrame.src = '';
    };
  }

  // Download logic for THE GREAT CIRCLE
  const downloadBtn = document.getElementById('download-ue4');
  const progressContainer = document.getElementById('download-progress-container');
  const progressBar = document.getElementById('download-progress');
  const progressStatus = document.getElementById('download-status');

  if (downloadBtn) {
    downloadBtn.onclick = async () => {
      const filePath = await launcher.chooseDownloadLocation();
      if (filePath) {
        launcher.startDownload(filePath);
      }
    };
  }

  {
    launcher.onDownloadProgress((percent) => {
      if (progressContainer && progressBar && progressStatus) {
        progressContainer.style.display = 'block';
        progressBar.style.width = percent + '%';
        progressStatus.textContent = `Downloading... ${percent}%`;
      }
    });
    launcher.onDownloadComplete((filePath, checksum) => {
      if (progressContainer && progressBar && progressStatus) {
        progressBar.style.width = '100%';
        progressStatus.textContent = `Download complete: ${filePath}\nSHA256: ${checksum}`;
      }
      showToast('Download complete! SHA256: ' + checksum);
      setTimeout(() => {
        if (confirm('Download complete! Would you like to run the installer now?')) {
          launcher.runInstaller(filePath);
        }
      }, 500);
    });
    launcher.onDownloadError((error) => {
      if (progressContainer && progressBar && progressStatus) {
        progressContainer.style.display = 'none';
        progressBar.style.width = '0%';
        progressStatus.textContent = '';
      }
      showToast('Download failed: ' + error);
    });
  }

  // Per-game pages. Tabs come from GAME_VIEWS, not from the sidebar.
  // TGC is the only entry for now; another game adds its own tabs and panels later.
  const GAME_VIEWS = {
    tgc: {
      title: 'The Great Circle',
      playSelector: '#play-ue4',
      tabs: [
        { id: 'overview', label: 'Overview' },
        { id: 'characters', label: 'Characters' },
        { id: 'map', label: 'Map' },
        { id: 'library', label: 'Library' },
        { id: 'gallery', label: 'Gallery' },
      ],
    },
  };
  const gameView = document.getElementById('game-view');
  let openGameId = null;
  let gameTab = null;
  let snapshotView = null;
  let selectedId = null;
  let photoFocus = null;
  let loreView = null;
  let mapSeq = 0;
  let loreSeq = 0;
  let gallerySeq = 0;
  let mapImageCache = { worldKey: null, url: null };

  function clearMapSurface() {
    const canvas = document.getElementById('tgc-map');
    const pin = document.getElementById('tgc-map-pin');
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (pin) pin.hidden = true;
  }

  function openGame(id) {
    const game = GAME_VIEWS[id];
    if (!game || !gameView) return;
    openGameId = id;
    document.getElementById('home').hidden = true;
    gameView.hidden = false;
    gameView.dataset.game = id;
    document.getElementById('game-view-title').textContent = game.title;
    const play = document.getElementById('game-play');
    if (game.playSelector) {
      play.hidden = false;
      play.onclick = () => {
        const target = document.querySelector(game.playSelector);
        if (target) target.click();
      };
    } else {
      play.hidden = true;
      play.onclick = null;
    }
    const list = document.getElementById('game-tablist');
    list.textContent = '';
    game.tabs.forEach((tab) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'game-tab';
      btn.id = `game-tab-${id}-${tab.id}`;
      btn.setAttribute('role', 'tab');
      btn.dataset.tab = tab.id;
      btn.textContent = tab.label;
      btn.setAttribute('aria-controls', `game-panel-${id}-${tab.id}`);
      btn.onclick = () => showGameTab(tab.id);
      list.appendChild(btn);
    });
    showGameTab(game.tabs[0] ? game.tabs[0].id : null);
    document.getElementById('main').scrollTop = 0;
  }

  function closeGame() {
    openGameId = null;
    gameTab = null;
    if (gameView) {
      gameView.hidden = true;
      gameView.dataset.game = '';
    }
    const home = document.getElementById('home');
    if (home) home.hidden = false;
    document.querySelectorAll('[data-game-panel]').forEach((panel) => { panel.hidden = true; });
  }

  function showGameTab(tabId) {
    const game = GAME_VIEWS[openGameId];
    if (!game) return;
    gameTab = tabId;
    const buttons = [...document.querySelectorAll('#game-tablist [role="tab"]')];
    buttons.forEach((btn) => {
      const on = btn.dataset.tab === tabId;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('[data-game-panel]').forEach((panel) => {
      panel.hidden = !(panel.dataset.gamePanel === openGameId && panel.dataset.tab === tabId);
    });
    if (tabId === 'map') drawMap();
    else if (tabId === 'library') loadLorePanel();
    else if (tabId === 'gallery') loadGalleryPanel();
    else if (gameView) gameView.dataset.mapready = '1';
  }

  document.getElementById('game-tablist').addEventListener('keydown', (e) => {
    const buttons = [...document.querySelectorAll('#game-tablist [role="tab"]')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    let next = null;
    if (e.key === 'ArrowRight') next = buttons[(index + 1) % buttons.length];
    else if (e.key === 'ArrowLeft') next = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (e.key === 'Home') next = buttons[0];
    else if (e.key === 'End') next = buttons[buttons.length - 1];
    if (!next) return;
    e.preventDefault();
    showGameTab(next.dataset.tab);
    next.focus();
  });
  document.getElementById('game-back').onclick = () => {
    closeGame();
    document.getElementById('main').scrollTop = 0;
  };
  document.querySelectorAll('[data-open-game]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openGame(btn.dataset.openGame);
    });
  });
  document.querySelectorAll('[data-game-card]').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (GAME_VIEWS[card.dataset.gameCard]) openGame(card.dataset.gameCard);
    });
  });

  // Local profile summary. Painted only inside the open game's panels.

  function formatUnix(sec) {
    if (!Number.isFinite(sec)) return '';
    const date = new Date(sec * 1000);
    if (Number.isNaN(date.getTime())) return '';
    try { return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return date.toLocaleString(); }
  }
  function formatVital(value) {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(2);
  }
  function formatExplored(percent) {
    const rounded = Math.round(percent * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${text}% explored`;
  }
  function clearNode(el) { if (el) el.textContent = ''; }
  function selectedCard() {
    if (!snapshotView) return null;
    const all = snapshotView.alive.concat(snapshotView.graveyard);
    return all.find((c) => c.characterId === selectedId) || all[0] || null;
  }
  function chip(text) {
    const span = document.createElement('span');
    span.className = 'tgc-chip';
    span.textContent = text;
    return span;
  }
  function statBox(label, value) {
    const box = document.createElement('div');
    box.className = 'tgc-stat';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = value;
    box.append(k, v);
    return box;
  }

  function renderProfile(view) {
    const meta = document.getElementById('tgc-account-meta');
    const persona = document.getElementById('tgc-persona');
    const stats = document.getElementById('tgc-account-stats');
    const achievements = document.getElementById('tgc-achievements');
    clearNode(meta); clearNode(stats); clearNode(achievements);
    persona.hidden = true;
    persona.textContent = '';
    const blocking = view.state !== 'ok' && view.state !== 'stale';
    if (blocking) return;
    if (view.personaName) {
      persona.hidden = false;
      persona.textContent = view.personaName;
    }
    const bits = [];
    if (view.game && view.game.build) bits.push(view.game.build);
    if (view.game && view.game.branch) bits.push(view.game.branch);
    if (view.saveSlotIndex !== null && view.saveSlotIndex !== undefined) bits.push(`slot ${view.saveSlotIndex}`);
    // savedAtUnix is the writer's clock. The heading is the persona fallback, so the id is not repeated.
    if (Number.isFinite(view.savedAtUnix)) bits.push(`written ${formatUnix(view.savedAtUnix)}`);
    meta.textContent = bits.join(' · ');
    const account = view.account;
    if (!account) return;
    const lore = account.loreDiscoveredCount;
    const loreTotal = account.loreTotalCount;
    if (lore !== null || loreTotal !== null) {
      let text = lore === null ? '—' : String(lore);
      if (loreTotal !== null) text += ` / ${loreTotal}`;
      if (lore !== null && loreTotal) {
        const pct = Math.round((lore / loreTotal) * 1000) / 10;
        text += ` (${Number.isInteger(pct) ? pct : pct.toFixed(1)}%)`;
      }
      stats.appendChild(statBox('Lore', text));
    }
    if (account.photoCount !== null) stats.appendChild(statBox('Photos', String(account.photoCount)));
    if (account.lifetimeSurvivalTime !== null) stats.appendChild(statBox('Lifetime survival', account.lifetimeSurvivalTime.toLocaleString()));
    if (account.lifetimeCharactersCreated !== null) stats.appendChild(statBox('Characters created', String(account.lifetimeCharactersCreated)));
    if (account.lifetimeXP !== null) stats.appendChild(statBox('Lifetime XP', account.lifetimeXP.toLocaleString()));
    if (account.longestSurvivalTimeDays !== null) stats.appendChild(statBox('Longest survival (days)', String(account.longestSurvivalTimeDays)));
    if (account.mostPlayedSpecies !== null && account.mostPlayedSpecies !== undefined) {
      const species = typeof account.mostPlayedSpecies === 'number' ? `#${account.mostPlayedSpecies}` : account.mostPlayedSpecies;
      stats.appendChild(statBox('Most played', species));
    }
    for (const row of account.achievements || []) {
      achievements.appendChild(chip(`${row.name.replace(/_/g, ' ')} · ${row.count}`));
    }
  }

  function characterButton(card, grave) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = grave ? 'tgc-grave' : 'tgc-card';
    btn.dataset.id = card.characterId;
    if (card.characterId === selectedId) btn.classList.add('is-selected');
    const name = document.createElement('div');
    name.className = grave ? 'tgc-grave-name' : 'tgc-card-name';
    name.textContent = card.name;
    const sub = document.createElement('div');
    sub.className = grave ? 'tgc-grave-sub' : 'tgc-card-sub';
    const fresh = Number.isFinite(card.lastUpdatedUnix) ? `updated ${formatUnix(card.lastUpdatedUnix)}` : '';
    if (grave) {
      const days = card.daysSurvived === null ? 'Dead' : `Died after ${card.daysSurvived} days`;
      sub.textContent = [card.speciesId || 'Unknown', days, fresh].filter(Boolean).join(' · ');
    } else {
      const parts = [];
      if (card.speciesId) parts.push(card.speciesId);
      if (card.level !== null) parts.push(`level ${card.level}`);
      if (card.daysSurvived !== null) parts.push(`${card.daysSurvived} days`);
      if (fresh) parts.push(fresh);
      sub.textContent = parts.join(' · ') || 'Alive';
    }
    btn.append(name, sub);
    btn.onclick = () => {
      selectedId = card.characterId;
      photoFocus = null;
      paintRoster();
      paintDetail();
    };
    return btn;
  }

  function paintRoster() {
    const roster = document.getElementById('tgc-roster');
    const grave = document.getElementById('tgc-graveyard');
    clearNode(roster); clearNode(grave);
    const alive = snapshotView.alive || [];
    const dead = snapshotView.graveyard || [];
    alive.forEach((card) => roster.appendChild(characterButton(card, false)));
    dead.forEach((card) => grave.appendChild(characterButton(card, true)));
    document.getElementById('tgc-roster-empty').hidden = alive.length > 0;
    document.getElementById('tgc-grave-empty').hidden = dead.length > 0;
    const meta = document.getElementById('tgc-characters-meta');
    meta.textContent = alive.length || dead.length ? `${alive.length} alive · ${dead.length} in the graveyard` : '';
  }

  function barRow(label, value) {
    const row = document.createElement('div');
    const top = document.createElement('div');
    top.className = 'tgc-bar-top';
    const name = document.createElement('span');
    name.textContent = label;
    const num = document.createElement('span');
    num.textContent = formatVital(value);
    top.append(name, num);
    row.appendChild(top);
    if (typeof value === 'number' && value >= 0 && value <= 1) {
      const track = document.createElement('div');
      track.className = 'tgc-track';
      const fill = document.createElement('span');
      fill.style.width = `${Math.max(0, Math.min(100, value * 100))}%`;
      track.appendChild(fill);
      row.appendChild(track);
    }
    return row;
  }

  function numberBox(label, value) {
    const box = document.createElement('div');
    box.className = 'tgc-num';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = formatVital(value);
    box.append(k, v);
    return box;
  }

  function paintDetail() {
    const card = selectedCard();
    const detail = document.getElementById('tgc-detail');
    if (!card) { detail.hidden = true; return; }
    selectedId = card.characterId;
    detail.hidden = false;
    document.getElementById('tgc-detail-name').textContent = card.name;
    const subParts = [];
    if (card.speciesId) subParts.push(card.speciesId);
    else if (card.speciesByte !== null) subParts.push(`species ${card.speciesByte}`);
    if (card.level !== null) subParts.push(`level ${card.level}`);
    if (card.status === 'DEAD') subParts.push(card.daysSurvived === null ? 'Dead' : `died after ${card.daysSurvived} days`);
    else if (card.daysSurvived !== null) subParts.push(`${card.daysSurvived} days survived`);
    if (Number.isFinite(card.lastUpdatedUnix)) subParts.push(`updated ${formatUnix(card.lastUpdatedUnix)}`);
    const loc = card.location;
    if (loc && loc.region) subParts.push(loc.region);
    document.getElementById('tgc-detail-sub').textContent = subParts.join(' · ');

    const vitals = document.getElementById('tgc-vitals');
    const base = document.getElementById('tgc-base');
    const effects = document.getElementById('tgc-effects');
    const history = document.getElementById('tgc-history');
    clearNode(vitals); clearNode(base); clearNode(effects); clearNode(history);
    const bars = [['health', 'Health'], ['stamina', 'Stamina'], ['hunger', 'Hunger'], ['thirst', 'Thirst'], ['oxygen', 'Oxygen']];
    const nums = [['weight', 'Weight'], ['bodyTemp', 'Body temp'], ['sleep', 'Sleep'], ['calories', 'Calories']];
    for (const [key, label] of bars) {
      if (card.vitals && Object.prototype.hasOwnProperty.call(card.vitals, key)) vitals.appendChild(barRow(label, card.vitals[key]));
    }
    for (const [key, label] of nums) {
      if (card.vitals && Object.prototype.hasOwnProperty.call(card.vitals, key)) vitals.appendChild(barRow(label, card.vitals[key]));
    }
    for (const [key, label] of [['attack', 'Attack'], ['defense', 'Defense'], ['armor', 'Armor'], ['speed', 'Speed'], ['hp', 'HP'], ['intelligence', 'Intelligence']]) {
      if (card.base && Object.prototype.hasOwnProperty.call(card.base, key)) base.appendChild(numberBox(label, card.base[key]));
    }
    for (const label of card.statusEffects || []) effects.appendChild(chip(label));
    const inv = document.getElementById('tgc-inventory');
    if (card.inventory && (card.inventory.items !== null || card.inventory.maxSlots !== null)) {
      const items = card.inventory.items === null ? '—' : String(card.inventory.items);
      const max = card.inventory.maxSlots === null ? '—' : String(card.inventory.maxSlots);
      inv.textContent = `Carrying ${items} / ${max}`;
    } else inv.textContent = '';
    const rows = card.history || [];
    document.getElementById('tgc-history-empty').hidden = rows.length > 0;
    for (const entry of rows) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.textContent = `${entry.type} · ${entry.value}`;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = formatUnix(entry.unixTime);
      li.append(what, when);
      history.appendChild(li);
    }
    if (gameTab === 'map') drawMap();
  }

  function paintMapPicker() {
    const picker = document.getElementById('tgc-map-picker');
    if (!picker) return;
    picker.textContent = '';
    if (!snapshotView) return;
    const cards = (snapshotView.alive || []).concat(snapshotView.graveyard || []);
    cards.forEach((card) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm' + (card.characterId === selectedId ? ' is-on' : '');
      btn.textContent = card.name;
      btn.onclick = () => {
        selectedId = card.characterId;
        photoFocus = null;
        paintRoster();
        paintDetail();
        paintMapPicker();
        drawMap();
      };
      picker.appendChild(btn);
    });
  }

  function paintLastCharacter() {
    const button = document.getElementById('tgc-last');
    const empty = document.getElementById('tgc-last-empty');
    const name = document.getElementById('tgc-last-name');
    const sub = document.getElementById('tgc-last-sub');
    const cards = snapshotView ? snapshotView.alive.concat(snapshotView.graveyard) : [];
    const card = snapshotView && snapshotView.lastCharacterId
      ? (cards.find((c) => c.characterId === snapshotView.lastCharacterId) || null)
      : null;
    if (!card) {
      button.hidden = true;
      empty.hidden = false;
      name.textContent = '';
      sub.textContent = '';
      return;
    }
    button.hidden = false;
    empty.hidden = true;
    name.textContent = card.name;
    const parts = [];
    if (card.speciesId) parts.push(card.speciesId);
    if (card.status === 'DEAD') parts.push(card.daysSurvived === null ? 'Dead' : `Died after ${card.daysSurvived} days`);
    else if (card.level !== null) parts.push(`level ${card.level}`);
    if (Number.isFinite(card.lastUpdatedUnix)) parts.push(`updated ${formatUnix(card.lastUpdatedUnix)}`);
    sub.textContent = parts.join(' · ');
  }

  async function drawMap() {
    const seq = ++mapSeq;
    const card = selectedCard();
    const canvas = document.getElementById('tgc-map');
    const pin = document.getElementById('tgc-map-pin');
    const caption = document.getElementById('tgc-map-caption');
    if (gameView) gameView.dataset.mapready = '';
    if (pin) pin.hidden = true;
    const pack = card && card.map && card.map.worldKey ? snapshotView.maps[card.map.worldKey] : null;
    const lines = [];
    const focused = photoFocus && card && card.map && card.map.worldKey === photoFocus.worldKey && photoFocus.pin;
    if (focused && photoFocus.caption) lines.push(photoFocus.caption);
    if (card && card.location && card.location.region) lines.push(card.location.region);
    if (card && card.location && Number.isFinite(card.location.updatedUnix)) lines.push(`as of ${formatUnix(card.location.updatedUnix)}`);
    if (card && card.map && card.map.mode === 'fog' && Number.isFinite(card.map.exploredPercent)) lines.push(formatExplored(card.map.exploredPercent));
    if (card && card.map && card.map.message) lines.push(card.map.message);
    if (!card || !card.map || (card.map.mode !== 'fog' && card.map.mode !== 'pin') || !pack) {
      clearMapSurface();
      caption.textContent = lines.join(' · ') || 'No map data yet.';
      if (gameView) gameView.dataset.mapready = '1';
      return;
    }
    let url = mapImageCache.worldKey === card.map.worldKey ? mapImageCache.url : null;
    if (!url && launcher.getMapImage) {
      let got = null;
      try { got = await launcher.getMapImage(card.map.worldKey); } catch (_) { got = null; }
      if (seq !== mapSeq) return;
      if (!got || !got.ok || !got.dataUrl) {
        clearMapSurface();
        caption.textContent = lines.join(' · ') || 'No map data yet.';
        if (gameView) gameView.dataset.mapready = '1';
        return;
      }
      url = got.dataUrl;
      mapImageCache = { worldKey: card.map.worldKey, url };
    }
    if (!url) {
      clearMapSurface();
      caption.textContent = lines.join(' · ') || 'No map data yet.';
      if (gameView) gameView.dataset.mapready = '1';
      return;
    }
    caption.textContent = lines.join(' · ');
    const img = new Image();
    img.onload = () => {
      if (seq !== mapSeq) return;
      const w = pack.imageW || img.naturalWidth;
      const h = pack.imageH || img.naturalHeight;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      if (card.map.mode === 'fog' && card.map.fog && card.map.fog.rects) {
        ctx.fillStyle = 'rgba(8, 6, 4, 0.72)';
        ctx.fillRect(0, 0, w, h);
        for (const rect of card.map.fog.rects) {
          const x = Math.min(rect.x, rect.x + rect.w);
          const y = Math.min(rect.y, rect.y + rect.h);
          const rw = Math.abs(rect.w);
          const rh = Math.abs(rect.h);
          ctx.drawImage(img, x, y, rw, rh, x, y, rw, rh);
        }
      }
      const point = focused ? photoFocus.pin : card.map.pin;
      if (point) {
        pin.hidden = false;
        pin.style.left = `${(point.u / w) * 100}%`;
        pin.style.top = `${(point.v / h) * 100}%`;
      }
      if (gameView) gameView.dataset.mapready = '1';
    };
    img.onerror = () => {
      if (seq !== mapSeq) return;
      caption.textContent = 'No map data yet.';
      if (gameView) gameView.dataset.mapready = '1';
    };
    img.src = url;
  }

  function renderSnapshot(view) {
    snapshotView = view || { enabled: false, state: 'disabled', message: 'Profile summary is off in this build.', alive: [], graveyard: [] };
    mapImageCache = { worldKey: null, url: null };
    if (gameView) {
      gameView.dataset.state = snapshotView.state || 'disabled';
      gameView.dataset.mapready = '1';
    }
    const banner = document.getElementById('game-status');
    const blocking = !snapshotView.enabled || (snapshotView.state !== 'ok' && snapshotView.state !== 'stale');
    if (banner) {
      if (blocking || snapshotView.message) {
        banner.hidden = false;
        banner.textContent = snapshotView.message || 'Play once to see your characters.';
        banner.classList.toggle('warn', snapshotView.state === 'stale');
      } else {
        banner.hidden = true;
        banner.textContent = '';
        banner.classList.remove('warn');
      }
    }
    const overview = document.getElementById('tgc-overview-body');
    const characters = document.getElementById('tgc-characters-body');
    const mapBody = document.getElementById('tgc-map-body');
    const libraryBody = document.getElementById('tgc-library-body');
    const galleryBody = document.getElementById('tgc-gallery-body');
    if (overview) overview.hidden = blocking;
    if (characters) characters.hidden = blocking;
    if (mapBody) mapBody.hidden = blocking;
    if (libraryBody) libraryBody.hidden = blocking;
    if (galleryBody) galleryBody.hidden = blocking;
    if (blocking) {
      clearMapSurface();
      mapImageCache = { worldKey: null, url: null };
      if (gameView) gameView.dataset.mapready = '1';
      return;
    }
    const cards = snapshotView.alive.concat(snapshotView.graveyard);
    const known = cards.some((c) => c.characterId === selectedId);
    if (!known) {
      selectedId = snapshotView.lastCharacterId || (cards[0] && cards[0].characterId) || null;
      photoFocus = null;
    }
    renderProfile(snapshotView);
    paintLastCharacter();
    paintRoster();
    paintDetail();
    paintMapPicker();
    if (gameTab === 'library') loadLorePanel();
    else if (gameTab === 'gallery') loadGalleryPanel();
    else if (gameTab === 'map') drawMap();
  }

  function paintLore() {
    const list = document.getElementById('tgc-lore-list');
    const reader = document.getElementById('tgc-lore-reader');
    const empty = document.getElementById('tgc-lore-empty');
    const count = document.getElementById('tgc-lore-count');
    list.textContent = '';
    reader.hidden = true;
    list.hidden = false;
    if (!loreView || loreView.state !== 'ok') {
      empty.hidden = false;
      empty.textContent = loreView && loreView.state === 'missing' ? 'No lore catalog yet.' : 'The lore catalog could not be read.';
      count.textContent = '';
      return;
    }
    empty.hidden = true;
    count.textContent = `${loreView.unlocked} / ${loreView.total} unlocked`;
    for (const group of loreView.categories || []) {
      const block = document.createElement('section');
      block.className = 'tgc-lore-group';
      const heading = document.createElement('h3');
      heading.className = 'tgc-sub';
      heading.textContent = group.category;
      block.appendChild(heading);
      for (const entry of group.entries) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tgc-card tgc-lore-row';
        btn.disabled = !!entry.locked;
        const title = document.createElement('span');
        title.className = 'tgc-card-name';
        title.textContent = entry.title;
        const sub = document.createElement('span');
        sub.className = 'tgc-card-sub';
        sub.textContent = entry.category;
        btn.append(title, sub);
        if (!entry.locked) btn.onclick = () => openLore(entry);
        block.appendChild(btn);
      }
      list.appendChild(block);
    }
  }

  async function openLore(entry) {
    const seq = loreSeq;
    document.getElementById('tgc-lore-list').hidden = true;
    const reader = document.getElementById('tgc-lore-reader');
    reader.hidden = false;
    document.getElementById('tgc-lore-cat').textContent = entry.category;
    document.getElementById('tgc-lore-title').textContent = entry.title;
    document.getElementById('tgc-lore-text').textContent = entry.text || '';
    const img = document.getElementById('tgc-lore-img');
    img.hidden = true;
    img.removeAttribute('src');
    if (entry.image && launcher.getLoreImage) {
      try {
        const got = await launcher.getLoreImage(entry.id);
        if (seq !== loreSeq) return;
        if (got && got.ok && got.dataUrl) {
          img.src = got.dataUrl;
          img.hidden = false;
        }
      } catch (_) { /* missing art stays hidden */ }
    }
    if (seq !== loreSeq) return;
    if (gameView) gameView.dataset.readerready = '1';
  }

  document.getElementById('tgc-lore-back').onclick = () => {
    document.getElementById('tgc-lore-reader').hidden = true;
    document.getElementById('tgc-lore-list').hidden = false;
    if (gameView) gameView.dataset.readerready = '';
  };

  async function loadLorePanel() {
    if (!launcher.getLore || !gameView) return;
    const seq = ++loreSeq;
    gameView.dataset.libraryready = '';
    gameView.dataset.readerready = '';
    let next = { state: 'unreadable', categories: [], unlocked: 0, total: 0 };
    try { next = await launcher.getLore(); } catch (_) { /* keep the empty state */ }
    if (seq !== loreSeq) return;
    loreView = next;
    paintLore();
    gameView.dataset.libraryready = '1';
  }

  function paintPhotoFilter() {
    const bar = document.getElementById('tgc-photo-filter');
    bar.textContent = '';
    if (!snapshotView) return;
    const cards = (snapshotView.alive || []).concat(snapshotView.graveyard || []);
    cards.forEach((card) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm' + (card.characterId === selectedId ? ' is-on' : '');
      btn.textContent = card.name;
      btn.onclick = () => {
        selectedId = card.characterId;
        photoFocus = null;
        loadGalleryPanel();
      };
      bar.appendChild(btn);
    });
  }

  async function loadGalleryPanel() {
    if (!gameView) return;
    const seq = ++gallerySeq;
    gameView.dataset.galleryready = '';
    gameView.dataset.photoready = '';
    document.getElementById('tgc-photo-view').hidden = true;
    document.getElementById('tgc-photo-grid').hidden = false;
    document.getElementById('tgc-photo-filter').hidden = false;
    paintPhotoFilter();
    const grid = document.getElementById('tgc-photo-grid');
    const empty = document.getElementById('tgc-photo-empty');
    grid.textContent = '';
    const card = selectedCard();
    if (!card || !launcher.getPhotos) {
      empty.hidden = false;
      empty.textContent = 'No photos yet.';
      gameView.dataset.galleryready = '1';
      return;
    }
    let listed = { photos: [] };
    try { listed = await launcher.getPhotos(card.characterId); }
    catch (_) { listed = { photos: [] }; }
    if (seq !== gallerySeq) return;
    const photos = listed && listed.photos ? listed.photos : [];
    empty.hidden = photos.length > 0;
    empty.textContent = 'No photos yet.';
    const thumbs = [];
    for (const photo of photos) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tgc-card tgc-photo-thumb';
      const img = document.createElement('img');
      img.alt = photo.caption || 'Photo';
      const label = document.createElement('span');
      label.textContent = photo.caption || 'Photo';
      btn.append(img, label);
      btn.onclick = () => openPhoto(card.characterId, photo, img.src);
      grid.appendChild(btn);
      thumbs.push({ photo, img });
    }
    let cursor = 0;
    async function pull() {
      while (cursor < thumbs.length) {
        if (seq !== gallerySeq) return;
        const item = thumbs[cursor++];
        let got = null;
        try { got = await launcher.getPhoto(card.characterId, item.photo.file); } catch (_) { got = null; }
        if (seq !== gallerySeq) return;
        if (got && got.ok && got.dataUrl) item.img.src = got.dataUrl;
      }
    }
    const workers = Math.min(4, thumbs.length);
    if (workers) await Promise.all(Array.from({ length: workers }, pull));
    if (seq === gallerySeq) gameView.dataset.galleryready = '1';
  }

  function openPhoto(characterId, photo, src) {
    const seq = gallerySeq;
    document.getElementById('tgc-photo-grid').hidden = true;
    document.getElementById('tgc-photo-filter').hidden = true;
    const view = document.getElementById('tgc-photo-view');
    view.hidden = false;
    const img = document.getElementById('tgc-photo-full');
    img.src = src || '';
    img.alt = photo.caption || 'Photo';
    document.getElementById('tgc-photo-caption').textContent = photo.caption || 'Photo';
    const bits = [];
    if (Number.isFinite(photo.unixTime)) bits.push(formatUnix(photo.unixTime));
    if (photo.worldKey) bits.push(photo.worldKey);
    if (photo.timeOfDay) bits.push(photo.timeOfDay);
    if (photo.weather) bits.push(photo.weather);
    document.getElementById('tgc-photo-meta').textContent = bits.join(' · ');
    const mapBtn = document.getElementById('tgc-photo-map');
    if (photo.pin && photo.worldKey) {
      mapBtn.hidden = false;
      mapBtn.onclick = () => {
        photoFocus = { worldKey: photo.worldKey, pin: photo.pin, caption: photo.caption || 'Photo' };
        showGameTab('map');
      };
    } else {
      mapBtn.hidden = true;
      mapBtn.onclick = null;
    }
    if (!src && launcher.getPhoto) {
      launcher.getPhoto(characterId, photo.file).then((got) => {
        if (seq !== gallerySeq) return;
        if (got && got.ok && got.dataUrl) img.src = got.dataUrl;
      }).catch(() => {});
    }
    if (gameView) gameView.dataset.photoready = '1';
  }

  document.getElementById('tgc-photo-back').onclick = () => {
    document.getElementById('tgc-photo-view').hidden = true;
    document.getElementById('tgc-photo-grid').hidden = false;
    document.getElementById('tgc-photo-filter').hidden = false;
    if (gameView) gameView.dataset.photoready = '';
  };

  document.getElementById('tgc-last').onclick = () => {
    if (!snapshotView || !snapshotView.lastCharacterId) return;
    selectedId = snapshotView.lastCharacterId;
    photoFocus = null;
    paintRoster();
    paintDetail();
    paintMapPicker();
    showGameTab('characters');
  };

  async function loadSnapshot() {
    if (!launcher.getSnapshot) return;
    try { renderSnapshot(await launcher.getSnapshot()); }
    catch (_) { renderSnapshot({ enabled: false, state: 'disabled' }); }
  }
  if (launcher.onSnapshotUpdated) launcher.onSnapshotUpdated(() => { loadSnapshot(); });
  loadSnapshot();

  // Sidebar navigation (scrolls the main column; no page navigation)
  const navButtons = document.querySelectorAll('.nav [data-scroll]');
  navButtons.forEach(btn => {
    btn.onclick = () => {
      closeGame();
      navButtons.forEach(b => b.classList.toggle('active', b === btn));
      const target = document.getElementById(btn.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  // Library card "Play" = the hero Play button (same launch + unlock refresh)
  document.querySelectorAll('[data-action="play-tgc"]').forEach(b => { b.onclick = () => playBtn.click(); });

  // Analytics consent modal on first launch
  if (!localStorage.getItem('analyticsConsentAsked')) {
    const modal = document.createElement('div');
    modal.className = 'consent-backdrop';
    modal.innerHTML = `
      <div class="card consent">
        <h2>Help us improve!</h2>
        <p>May we collect anonymous usage statistics to improve the launcher and your experience?</p>
        <div class="row">
          <button id="consent-yes" class="btn btn-primary">Yes, I agree</button>
          <button id="consent-no" class="btn">No, thanks</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('consent-yes').onclick = () => {
      setAnalytics(true);
      localStorage.setItem('analyticsConsentAsked', 'true');
      document.body.removeChild(modal);
    };
    document.getElementById('consent-no').onclick = () => {
      setAnalytics(false);
      localStorage.setItem('analyticsConsentAsked', 'true');
      document.body.removeChild(modal);
    };
  }
}; 