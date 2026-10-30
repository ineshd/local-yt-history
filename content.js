(() => {
  const SAVE_INTERVAL = 5000; // ms between progress saves while playing
  const MIN_SECONDS = 5;      // don't record a video until this much is watched

  let settings = { ...DEFAULTS };
  const history = new Map(); // videoId -> { id, t, d, title, channel, watchedAt, firstWatchedAt }

  // ---------- storage ----------

  chrome.storage.local.get(null, (all) => {
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(PREFIX)) history.set(key.slice(PREFIX.length), value);
    }
    settings = { ...DEFAULTS, ...all.settings };
    scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key === 'settings') {
        settings = { ...DEFAULTS, ...newValue };
      } else if (key.startsWith(PREFIX)) {
        const id = key.slice(PREFIX.length);
        if (newValue) history.set(id, newValue);
        else history.delete(id);
      }
    }
    scheduleScan();
  });

  function persist(entry) {
    // After the extension is reloaded, this orphaned script loses access to
    // chrome.* APIs until the tab is refreshed.
    if (!chrome.runtime?.id) return;
    chrome.storage.local.set({ [PREFIX + entry.id]: entry }).catch(() => {});
  }

  function idFromHref(href) {
    try {
      const url = new URL(href, location.origin);
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const m = url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // ---------- tracking the main player ----------

  // The watch page keeps its video id on <ytd-watch-flexy>, which also stays
  // correct while the video plays in the miniplayer on other pages.
  function currentVideoId() {
    return document.querySelector('ytd-watch-flexy')?.getAttribute('video-id')
      || idFromHref(location.href);
  }

  function mainPlayerOf(video) {
    if (!(video instanceof HTMLVideoElement)) return null;
    // Skip hover previews on the home page / search results.
    if (video.closest('#inline-player, ytd-video-preview')) return null;
    return video.closest('#movie_player');
  }

  function isAd(player) {
    return player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  }

  function readMetadata() {
    // innerText, not textContent: the h1 also holds a hidden alternate title.
    const title = document.querySelector('ytd-watch-metadata h1')?.innerText.trim()
      || document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
    const channel = document.querySelector('ytd-watch-metadata ytd-channel-name a')?.textContent.trim() || '';
    return { title, channel };
  }

  // A session binds one <video> load to one video id. It is only created on
  // loadedmetadata, so when YouTube navigates and the URL changes before the
  // old video stops, the old position is never saved under the new id.
  let session = null;

  function startSession(video) {
    session = { id: currentVideoId(), video, lastSave: 0, resumeChecked: false };
  }

  function resumeTo(video, id) {
    if (!settings.resume) return;
    const entry = history.get(id);
    if (!entry || progressOf(entry) >= 1 || entry.t < MIN_SECONDS) return;
    if (Math.abs(video.currentTime - entry.t) > 5) video.currentTime = entry.t;
  }

  function maybeResume(video) {
    session.resumeChecked = true;
    if (new URL(location.href).searchParams.has('t')) return; // explicit timestamp wins
    resumeTo(video, session.id);
  }

  // ---------- hover previews ----------

  // The preview player sits inside a link to the video it's previewing. It is
  // reused across hovers, so remember which video each element was seeked for.
  const previewSeeked = new WeakMap();

  function previewVideoId(video) {
    if (!(video instanceof HTMLVideoElement) || !video.closest('ytd-video-preview')) return null;
    const link = video.closest('a[href*="/watch?v="]');
    return link ? idFromHref(link.href) : null;
  }

  // Previews only get the resume seek; muted hover playback is never saved.
  function onPreviewEvent(e) {
    const video = e.target;
    if (e.type === 'loadstart') {
      previewSeeked.delete(video);
      return;
    }
    if (e.type !== 'timeupdate') return;
    const id = previewVideoId(video);
    if (!id || previewSeeked.get(video) === id) return;
    previewSeeked.set(video, id);
    resumeTo(video, id);
  }

  function save(video, force) {
    if (!settings.tracking || !session || session.video !== video) return;
    if (session.id !== currentVideoId()) return;
    const d = video.duration;
    if (!isFinite(d) || d <= 0) return; // live streams
    const now = Date.now();
    if (!force && now - session.lastSave < SAVE_INTERVAL) return;
    const prev = history.get(session.id);
    if (!prev && video.currentTime < MIN_SECONDS) return;
    session.lastSave = now;

    const meta = readMetadata();
    const entry = {
      id: session.id,
      t: video.currentTime,
      d,
      title: meta.title || prev?.title || '',
      channel: meta.channel || prev?.channel || '',
      watchedAt: now,
      firstWatchedAt: prev?.firstWatchedAt || now,
    };
    history.set(entry.id, entry);
    persist(entry);
  }

  // Media events don't bubble, but they can be caught in the capture phase,
  // which also covers YouTube swapping out the <video> element.
  function onMediaEvent(e) {
    const video = e.target;
    if (previewVideoId(video)) {
      onPreviewEvent(e);
      return;
    }
    if (e.type === 'loadstart') return;
    const player = mainPlayerOf(video);
    if (!player || isAd(player)) return;

    if (e.type === 'loadedmetadata') {
      startSession(video);
      return;
    }
    // Script injected after the video had already loaded.
    if (!session && video.readyState >= 1) {
      startSession(video);
      session.resumeChecked = true;
    }
    if (!session || session.video !== video) return;

    if (e.type === 'timeupdate') {
      if (!session.resumeChecked && video.currentTime >= 0) maybeResume(video);
      save(video, false);
    } else {
      save(video, true); // pause, seeked, ended
    }
  }

  for (const type of ['loadstart', 'loadedmetadata', 'timeupdate', 'pause', 'seeked', 'ended']) {
    document.addEventListener(type, onMediaEvent, true);
  }

  function flush() {
    if (session) save(session.video, true);
  }
  document.addEventListener('yt-navigate-start', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);

  // ---------- progress bars on thumbnails ----------

  const LINK_SELECTOR = 'a[href*="/watch?v="], a[href*="/shorts/"]';

  // Only links that wrap a thumbnail image get a bar. Title links can hold
  // small badge images, so unknown layouts must also be thumbnail-sized.
  function barHostFor(link) {
    if (link.closest('ytd-video-preview')) return null; // hover preview has its own scrubber
    const thumb = link.querySelector('yt-thumbnail-view-model');
    if (thumb) return thumb;
    if (link.id === 'thumbnail') return link;
    if (link.querySelector(':scope > .lyth-bar')) return link;
    return link.querySelector('img') && link.offsetHeight >= 60 ? link : null;
  }

  function scan() {
    if (!settings.bars) {
      for (const bar of document.querySelectorAll('.lyth-bar')) bar.remove();
      return;
    }
    for (const link of document.querySelectorAll(LINK_SELECTOR)) {
      const host = barHostFor(link);
      if (!host) continue;
      let bar = host.querySelector(':scope > .lyth-bar');
      const progress = progressOf(history.get(idFromHref(link.href)));

      if (progress <= 0) {
        bar?.remove();
        continue;
      }
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'lyth-bar';
        bar.appendChild(document.createElement('div'));
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(bar);
      }
      bar.firstChild.style.width = `${(progress * 100).toFixed(2)}%`;
    }
  }

  // YouTube mutates the DOM constantly (and recycles thumbnail elements with
  // new hrefs), so rescans are throttled rather than debounced.
  let scanPending = false;
  function scheduleScan() {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      scan();
    }, 300);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  document.addEventListener('yt-navigate-finish', scheduleScan);
})();
