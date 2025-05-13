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
      ipcRenderer.send('launch-ue4', { method: 'steam' });
    } else {
      const url = urlInput.value.trim();
      if (!url) {
        alert('Please enter a URL to launch.');
        return;
      }
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
      const updateDiv = document.getElementById('update');
      if (updateDiv) {
        updateDiv.style.background = '#fff';
        updateDiv.style.color = '#23272a';
        updateDiv.style.borderLeft = '4px solid #0078d7';
      }
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
      const updateDiv = document.getElementById('update');
      if (updateDiv) {
        updateDiv.style.background = '#2c2f33';
        updateDiv.style.color = '#f5f6fa';
        updateDiv.style.borderLeft = '4px solid #7289da';
      }
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
}; 