// Replaces the contents of youtube.com/feed/history with the local history.
(() => {
  const PAGE_SIZE = 100;
  const ROOT_ID = 'lyth-history';

  let entries = [];
  let settings = { ...DEFAULTS };
  let shown = PAGE_SIZE;
  let root = null;

  const isHistoryPage = () => location.pathname === '/feed/history';

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  async function load() {
    if (!chrome.runtime?.id) return;
    const all = await chrome.storage.local.get(null);
    entries = Object.entries(all)
      .filter(([key]) => key.startsWith(PREFIX))
      .map(([, value]) => value)
      .sort((a, b) => b.watchedAt - a.watchedAt);
    settings = { ...DEFAULTS, ...all.settings };
    if (root) render();
  }

  // ---------- building the page ----------

  function build() {
    const search = el('input', { type: 'search', placeholder: 'Search watch history', className: 'lyth-search' });
    search.addEventListener('input', () => {
      shown = PAGE_SIZE;
      render();
    });

    const toggles = Object.entries({
      tracking: 'Record watch history',
      resume: 'Resume where I left off',
      bars: 'Progress bars on thumbnails',
    }).map(([key, label]) => {
      const box = el('input', { type: 'checkbox' });
      box.dataset.key = key;
      box.addEventListener('change', () => {
        chrome.storage.local.set({ settings: { ...settings, [key]: box.checked } });
      });
      return el('label', { className: 'lyth-toggle' }, [box, label]);
    });

    const fileInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileInput.addEventListener('change', () => importFile(fileInput));

    const button = (text, onClick, className = '') => {
      const b = el('button', { className: `lyth-button ${className}`, textContent: text });
      b.addEventListener('click', onClick);
      return b;
    };

    const more = button('Show more', () => {
      shown += PAGE_SIZE;
      render();
    }, 'lyth-more');

    root = el('div', { id: ROOT_ID }, [
      el('div', { className: 'lyth-main' }, [
        el('h1', { textContent: 'Watch history' }),
        el('div', { className: 'lyth-list' }),
        more,
        el('p', { className: 'lyth-empty', textContent: 'Nothing here yet. Videos you watch will show up here.' }),
      ]),
      el('aside', { className: 'lyth-side' }, [
        search,
        el('div', { className: 'lyth-count' }),
        ...toggles,
        el('div', { className: 'lyth-side-note', textContent: 'Stored only in this browser.' }),
        button('Export history', exportHistory),
        button('Import history', () => fileInput.click()),
        button('Clear all watch history', clearAll),
        fileInput,
      ]),
    ]);
    return root;
  }

  function dayLabel(ts) {
    const date = new Date(ts);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
  }

  function rowFor(entry) {
    const url = `/watch?v=${encodeURIComponent(entry.id)}`;
    const progress = progressOf(entry);
    const clock = new Date(entry.watchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const remove = el('button', { className: 'lyth-remove', title: 'Remove from watch history', textContent: '✕' });
    remove.addEventListener('click', () => chrome.storage.local.remove(PREFIX + entry.id));

    // Plain links: YouTube's own click handler turns /watch links into SPA navigations.
    return el('div', { className: 'lyth-row' }, [
      el('a', { className: 'lyth-thumb', href: url }, [
        el('img', { src: `https://i.ytimg.com/vi/${encodeURIComponent(entry.id)}/mqdefault.jpg`, loading: 'lazy', alt: '' }),
        el('span', { className: 'lyth-time', textContent: formatTime(entry.d) }),
        el('div', { className: 'lyth-row-bar' }, [el('div', { style: `width:${progress * 100}%` })]),
      ]),
      el('div', { className: 'lyth-info' }, [
        el('a', { className: 'lyth-title', href: url, textContent: entry.title || entry.id }),
        el('div', { className: 'lyth-sub', textContent: entry.channel }),
        el('div', {
          className: 'lyth-sub',
          textContent: progress >= 1 ? `Watched · ${clock}` : `${formatTime(entry.t)} of ${formatTime(entry.d)} · ${clock}`,
        }),
      ]),
      remove,
    ]);
  }

  function render() {
    const query = root.querySelector('.lyth-search').value.trim().toLowerCase();
    const matches = query
      ? entries.filter((e) => `${e.title} ${e.channel}`.toLowerCase().includes(query))
      : entries;

    root.querySelector('.lyth-count').textContent = `${matches.length} video${matches.length === 1 ? '' : 's'}`;
    root.querySelector('.lyth-empty').hidden = matches.length > 0;
    root.querySelector('.lyth-more').hidden = matches.length <= shown;
    for (const box of root.querySelectorAll('.lyth-toggle input')) box.checked = settings[box.dataset.key];

    const rows = [];
    let lastDay = null;
    for (const entry of matches.slice(0, shown)) {
      const day = dayLabel(entry.watchedAt);
      if (day !== lastDay) {
        rows.push(el('h2', { className: 'lyth-day', textContent: day }));
        lastDay = day;
      }
      rows.push(rowFor(entry));
    }
    root.querySelector('.lyth-list').replaceChildren(...rows);
  }

  // ---------- actions ----------

  async function clearAll() {
    if (!confirm(`Delete all ${entries.length} videos from your local watch history? This can't be undone.`)) return;
    await chrome.storage.local.remove(entries.map((e) => PREFIX + e.id));
  }

  function exportHistory() {
    const blob = new Blob([JSON.stringify({ version: 1, entries }, null, 2)], { type: 'application/json' });
    const a = el('a', {
      href: URL.createObjectURL(blob),
      download: `youtube-history-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importFile(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data.entries;
      if (!Array.isArray(incoming)) throw new Error('No entries found');

      // Merge: keep whichever copy of each video was watched more recently.
      const current = new Map(entries.map((entry) => [entry.id, entry]));
      const updates = {};
      for (const entry of incoming) {
        if (typeof entry?.id !== 'string' || !(entry.d > 0)) continue;
        const existing = current.get(entry.id);
        if (!existing || entry.watchedAt > existing.watchedAt) updates[PREFIX + entry.id] = entry;
      }
      await chrome.storage.local.set(updates);
      alert(`Imported ${Object.keys(updates).length} videos.`);
    } catch (err) {
      alert(`Couldn't import that file: ${err.message}`);
    }
  }

  // ---------- mounting ----------

  // YouTube keeps one <ytd-browse> per feed and reuses it across navigations,
  // so the container is mounted once and shown/hidden with a class on <html>.
  function sync() {
    const active = isHistoryPage();
    document.documentElement.classList.toggle('lyth-on-history', active);
    if (!active) return;
    const browse = document.querySelector('ytd-browse[page-subtype="history"]');
    if (!browse) return;
    if (!root) build();
    if (root.parentElement !== browse) browse.appendChild(root);
    render();
  }

  // Hide YouTube's version immediately on a direct load, before it renders.
  if (isHistoryPage()) document.documentElement.classList.add('lyth-on-history');

  document.addEventListener('yt-navigate-finish', sync);
  // The history <ytd-browse> may be created after yt-navigate-finish on a cold load.
  new MutationObserver(() => {
    if (isHistoryPage() && (!root || !root.isConnected)) sync();
  }).observe(document.documentElement, { childList: true, subtree: true });

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== 'local') return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 200);
  });

  load().then(sync);
})();
