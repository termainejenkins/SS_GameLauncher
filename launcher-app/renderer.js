// Runs with contextIsolation + sandbox: no require(). Everything native goes through window.launcher (preload.js).
// `launcher` is the global that preload.js exposes via contextBridge (window.launcher).
const BACKEND_URL = 'http://localhost:3000';

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

function labelled(parent, label, value) {
  const strong = document.createElement('strong');
  strong.textContent = label + ' ';
  parent.appendChild(strong);
  parent.appendChild(document.createTextNode(String(value ?? '')));
  parent.appendChild(document.createElement('br'));
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

  // Simulated local game version
  const localGameVersion = '1.0.0';

  // Fetch latest update info from backend
  fetch(`${BACKEND_URL}/updates`)
    .then(res => res.json())
    .then(update => {
      const updateDiv = document.getElementById('update');
      const updateContent = document.getElementById('update-content');
      if (update && update.version) {
        updateDiv.style.display = 'block';
        updateContent.textContent = '';
        labelled(updateContent, 'Version:', update.version);
        labelled(updateContent, 'Date:', update.date);
        labelled(updateContent, 'Notes:', update.notes);
        if (update.downloadUrl && /^https?:\/\//i.test(update.downloadUrl)) {
          const a = document.createElement('a');
          a.href = update.downloadUrl;
          a.textContent = 'Download Update';
          a.onclick = (e) => { e.preventDefault(); launcher.openExternal(update.downloadUrl); };
          updateContent.appendChild(a);
        }
        // Version comparison and update prompt
        if (update.version !== localGameVersion) {
          showToast(`A new game update (v${update.version}) is available!`);
        }
      } else {
        updateDiv.style.display = 'none';
      }
    })
    .catch(() => {
      document.getElementById('update').style.display = 'none';
    });

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

  function handleLaunchResult(result) {
    if (result.success) {
      showToast(result.mode === 'exe' ? 'Starting THE GREAT CIRCLE...' : 'UE4 game launched!');
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

  // Error reporting form logic
  const errorMsgInput = document.getElementById('error-message');
  const submitErrorBtn = document.getElementById('submit-error');
  if (submitErrorBtn) {
    submitErrorBtn.onclick = () => {
      const msg = errorMsgInput.value.trim();
      if (!msg) {
        showToast('Please enter a bug description.');
        return;
      }
      fetch(`${BACKEND_URL}/analytics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'user_bug_report', message: msg, timestamp: new Date().toISOString() })
      })
        .then(() => {
          showToast('Thank you for your report!');
          errorMsgInput.value = '';
        })
        .catch(() => {
          showToast('Failed to submit report.');
        });
    };
  }

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

  // Sidebar navigation (scrolls the main column; no page navigation)
  const navButtons = document.querySelectorAll('.nav [data-scroll]');
  navButtons.forEach(btn => {
    btn.onclick = () => {
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