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
}; 