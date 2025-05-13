const { ipcRenderer } = require('electron');

window.onload = () => {
  // Fetch news from backend
  fetch('http://localhost:3000/news')
    .then(res => res.json())
    .then(news => {
      const newsList = document.getElementById('news-list');
      newsList.innerHTML = '';
      news.forEach(item => {
        const div = document.createElement('div');
        div.className = 'news-item';
        div.innerHTML = `<strong>${item.title}</strong><br>${item.content}`;
        newsList.appendChild(div);
      });
    })
    .catch(() => {
      document.getElementById('news-list').innerText = 'Failed to load news.';
    });

  // Simulated local game version
  const localGameVersion = '1.0.0';

  // Fetch latest update info from backend
  fetch('http://localhost:3000/updates')
    .then(res => res.json())
    .then(update => {
      const updateDiv = document.getElementById('update');
      const updateContent = document.getElementById('update-content');
      if (update && update.version) {
        updateDiv.style.display = 'block';
        updateContent.innerHTML = `<strong>Version:</strong> ${update.version}<br><strong>Date:</strong> ${update.date}<br><strong>Notes:</strong> ${update.notes}`;
        if (update.downloadUrl) {
          updateContent.innerHTML += `<br><a href="${update.downloadUrl}" target="_blank">Download Update</a>`;
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

  document.getElementById('play-ue4').onclick = () => {
    if (steamRadio.checked) {
      sendAnalytics('launch_ue4_game', { method: 'steam' });
      ipcRenderer.send('launch-ue4', { method: 'steam' });
    } else {
      const url = urlInput.value.trim();
      if (!url) {
        showToast('Please enter a URL to launch.');
        sendAnalytics('launch_ue4_game_error', { error: 'No URL entered' });
        return;
      }
      sendAnalytics('launch_ue4_game', { method: 'url', url });
      ipcRenderer.send('launch-ue4', { method: 'url', url });
    }
  };

  // Toast notification function
  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.opacity = 1; }, 10);
    setTimeout(() => {
      toast.style.opacity = 0;
      setTimeout(() => { toast.style.display = 'none'; }, 300);
    }, 3000);
  }

  ipcRenderer.on('launch-ue4-reply', (event, result) => {
    if (result.success) {
      showToast('UE4 game launched!');
    } else {
      let msg = 'Failed to launch UE4 game: ' + result.error;
      if (result.error && result.error.toLowerCase().includes('license')) {
        msg = 'Steam reported a license error. Please ensure you own the demo and try again later. If the problem persists, it may be a temporary Steam issue.';
      }
      showToast(msg);
      sendAnalytics('launch_ue4_game_error', { error: result.error });
    }
  });

  // Play Web Game button
  document.getElementById('play-web').onclick = () => {
    // Open web game in default browser
    require('electron').shell.openExternal('http://localhost:YOUR_WEB_GAME_PORT');
  };

  // Load saved URL from localStorage
  urlInput.value = localStorage.getItem('customGameUrl') || '';

  urlInput.addEventListener('input', () => {
    localStorage.setItem('customGameUrl', urlInput.value);
  });

  // Theme toggle logic
  const themeToggle = document.getElementById('theme-toggle');
  const themeLabel = document.getElementById('theme-label');

  function setTheme(mode) {
    if (mode === 'light') {
      document.body.style.background = '#f5f6fa';
      document.body.style.color = '#23272a';
      themeLabel.textContent = 'Light Mode';
      // Update other elements for light mode
      document.querySelectorAll('button').forEach(btn => {
        btn.style.background = '#e3e5e8';
        btn.style.color = '#23272a';
      });
      document.querySelectorAll('.news-item').forEach(div => {
        div.style.background = '#fff';
        div.style.color = '#23272a';
      });
      // Update Latest Update section
      const updateDiv = document.getElementById('update');
      if (updateDiv) {
        updateDiv.style.background = '#fff';
        updateDiv.style.color = '#23272a';
        updateDiv.style.borderLeft = '4px solid #0078d7';
      }
      const updateH2 = document.querySelector('#update h2');
      if (updateH2) updateH2.style.color = '#0078d7';
      const toast = document.getElementById('toast');
      if (toast) {
        toast.style.background = '#e3e5e8';
        toast.style.color = '#23272a';
      }
      document.querySelectorAll('a').forEach(a => { a.style.color = '#0078d7'; });
    } else {
      document.body.style.background = '#23272a';
      document.body.style.color = '#f5f6fa';
      themeLabel.textContent = 'Dark Mode';
      document.querySelectorAll('button').forEach(btn => {
        btn.style.background = '#2c2f33';
        btn.style.color = '#f5f6fa';
      });
      document.querySelectorAll('.news-item').forEach(div => {
        div.style.background = '#2c2f33';
        div.style.color = '#f5f6fa';
      });
      // Update Latest Update section
      const updateDiv = document.getElementById('update');
      if (updateDiv) {
        updateDiv.style.background = '#2c2f33';
        updateDiv.style.color = '#f5f6fa';
        updateDiv.style.borderLeft = '4px solid #7289da';
      }
      const updateH2 = document.querySelector('#update h2');
      if (updateH2) updateH2.style.color = '#7289da';
      const toast = document.getElementById('toast');
      if (toast) {
        toast.style.background = '#111417';
        toast.style.color = '#f5f6fa';
      }
      document.querySelectorAll('a').forEach(a => { a.style.color = '#7289da'; });
    }
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
    fetch('http://localhost:3000/analytics', {
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
      fetch('http://localhost:3000/analytics', {
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
    downloadBtn.onclick = () => {
      if (window.require) {
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('choose-download-location');
      }
    };
  }

  if (window.require) {
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('download-location-chosen', (event, filePath) => {
      if (filePath) {
        ipcRenderer.send('download-ue4', filePath);
      }
    });
    ipcRenderer.on('download-ue4-progress', (event, percent) => {
      if (progressContainer && progressBar && progressStatus) {
        progressContainer.style.display = 'block';
        progressBar.style.width = percent + '%';
        progressStatus.textContent = `Downloading... ${percent}%`;
      }
    });
    ipcRenderer.on('download-ue4-complete', (event, filePath) => {
      if (progressContainer && progressBar && progressStatus) {
        progressBar.style.width = '100%';
        progressStatus.textContent = `Download complete: ${filePath}`;
      }
      showToast('Download complete!');
    });
    ipcRenderer.on('download-ue4-error', (event, error) => {
      if (progressContainer && progressBar && progressStatus) {
        progressContainer.style.display = 'none';
        progressBar.style.width = '0%';
        progressStatus.textContent = '';
      }
      showToast('Download failed: ' + error);
    });
  }
}; 