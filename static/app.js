(function () {
  'use strict';

  const STORAGE_KEY = 'ytv_watch_later';
  const HIDDEN_KEY = 'ytv_hidden';
  const RESUME_KEY = 'ytv_resume';

  // ── localStorage ラッパ ─────────────────────────────
  function loadLater() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function saveLater(obj) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
      console.warn('saveLater failed:', e);
    }
  }

  // 見終わった動画のID集合。新着タブからは非表示にする。
  function loadHidden() {
    try {
      const raw = localStorage.getItem(HIDDEN_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function saveHidden(obj) {
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(obj));
    } catch (e) {
      console.warn('saveHidden failed:', e);
    }
  }
  function addToHidden(videoId) {
    const hidden = loadHidden();
    hidden[videoId] = Date.now();
    saveHidden(hidden);
  }

  // 再生位置の保存。videoId → { position, duration, updatedAt }
  function loadResume() {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function saveResume(obj) {
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify(obj));
    } catch (e) {
      console.warn('saveResume failed:', e);
    }
  }
  function getResumePosition(videoId) {
    const all = loadResume();
    const entry = all[videoId];
    if (!entry) return 0;
    const pos = Number(entry.position) || 0;
    if (pos < 5) return 0;
    return pos;
  }
  function setResumePosition(videoId, position, duration) {
    if (!videoId) return;
    position = Number(position) || 0;
    duration = Number(duration) || 0;
    // ライブ / duration未取得、もしくは序盤は保存しない
    if (!duration) return;
    // 終盤まで観た → 観終わり扱いで削除
    if (position >= duration - 10 || position / duration >= 0.95) {
      clearResume(videoId);
      return;
    }
    if (position < 5) return;
    const all = loadResume();
    all[videoId] = { position, duration, updatedAt: Date.now() };
    saveResume(all);
  }
  function clearResume(videoId) {
    const all = loadResume();
    if (all[videoId]) {
      delete all[videoId];
      saveResume(all);
    }
  }

  // ── サムネ進捗バー（YouTube風） ─────────────────────
  function applyProgressToCard(card) {
    if (!card) return;
    const videoId = card.dataset.videoId;
    if (!videoId) return;
    const thumb = card.querySelector('.thumb');
    if (!thumb) return;
    const all = loadResume();
    const entry = all[videoId];
    let bar = thumb.querySelector('.progress-bar');
    if (!entry || !entry.duration || !entry.position || entry.position < 5) {
      if (bar) bar.remove();
      return;
    }
    const ratio = Math.max(0, Math.min(1, entry.position / entry.duration));
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'progress-bar';
      const fill = document.createElement('div');
      fill.className = 'progress-bar-fill';
      bar.appendChild(fill);
      thumb.appendChild(bar);
    }
    bar.querySelector('.progress-bar-fill').style.width = `${ratio * 100}%`;
  }
  function applyProgressToAllCards() {
    document.querySelectorAll('.card').forEach(applyProgressToCard);
  }
  function refreshProgressForVideo(videoId) {
    if (!videoId) return;
    document.querySelectorAll(`.card[data-video-id="${CSS.escape(videoId)}"]`)
      .forEach(applyProgressToCard);
  }

  // ── 相対時刻 ─────────────────────────────
  function relTime(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (isNaN(then)) return '';
    const s = Math.floor((Date.now() - then.getTime()) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}日前`;
    if (s < 86400 * 30) return `${Math.floor(s / (86400 * 7))}週間前`;
    if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}ヶ月前`;
    return `${Math.floor(s / (86400 * 365))}年前`;
  }

  // ── iframeプレイヤー (YouTube IFrame Player API) ─────────────────────
  // iOS Safari ではiframeのautoplay=1だけでは「Tap to play」UIで止まる。
  // user gesture (clickハンドラ) の中で player.playVideo() を呼ぶことで
  // 確実にワンタップ再生を実現する。
  const overlay = document.getElementById('player-overlay');
  const playerHost = document.getElementById('player-host');
  const closeBtn = overlay.querySelector('.player-close');
  const minimizeBtn = overlay.querySelector('.player-minimize');
  const expandBtn = overlay.querySelector('.player-expand');

  let ytPlayer = null;
  let ytReady = false;
  let pendingVideoId = null;
  let pendingStart = 0;
  let currentVideoId = null;
  let saveIntervalId = null;
  let ytApiLoading = false;

  function ensurePlayerHost() {
    let host = document.getElementById('player-iframe');
    if (!host) {
      playerHost.innerHTML = '';
      host = document.createElement('div');
      host.id = 'player-iframe';
      playerHost.appendChild(host);
    }
    return host;
  }

  // YouTube IFrame API は起動時に準備し、クリック時の loadVideoById を user gesture 内で通す。
  function loadYTApi() {
    if (window.YT && YT.Player) {
      window.onYouTubeIframeAPIReady();
      return;
    }
    if (ytApiLoading) return;
    ytApiLoading = true;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  window.onYouTubeIframeAPIReady = function () {
    if (ytPlayer) return;
    ensurePlayerHost();
    ytPlayer = new YT.Player('player-iframe', {
      width: '100%',
      height: '100%',
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: () => {
          ytReady = true;
          if (pendingVideoId) {
            ytPlayer.loadVideoById({ videoId: pendingVideoId, startSeconds: pendingStart || 0 });
            pendingVideoId = null;
            pendingStart = 0;
          }
        },
        onStateChange: onPlayerStateChange,
      },
    });
  };

  function savePositionNow() {
    if (!ytReady || !ytPlayer || !currentVideoId) return;
    try {
      setResumePosition(currentVideoId, ytPlayer.getCurrentTime(), ytPlayer.getDuration());
      refreshProgressForVideo(currentVideoId);
    } catch {}
  }
  function startSaveInterval() {
    stopSaveInterval();
    saveIntervalId = setInterval(savePositionNow, 5000);
  }
  function stopSaveInterval() {
    if (saveIntervalId !== null) {
      clearInterval(saveIntervalId);
      saveIntervalId = null;
    }
  }
  function onPlayerStateChange(e) {
    if (!window.YT || !YT.PlayerState) return;
    switch (e.data) {
      case YT.PlayerState.PLAYING:
        startSaveInterval();
        break;
      case YT.PlayerState.PAUSED:
        stopSaveInterval();
        savePositionNow();
        break;
      case YT.PlayerState.ENDED:
        stopSaveInterval();
        if (currentVideoId) {
          clearResume(currentVideoId);
          refreshProgressForVideo(currentVideoId);
        }
        break;
    }
  }

  function openPlayer(videoId) {
    // 別動画の切り替えなら、前動画の位置をまず保存してから切り替える
    if (currentVideoId && currentVideoId !== videoId) {
      savePositionNow();
    }
    stopSaveInterval();
    currentVideoId = videoId;
    const start = getResumePosition(videoId);

    if (overlay.hidden) {
      overlay.hidden = false;
      overlay.classList.remove('is-pip');
      document.body.style.overflow = 'hidden';
    }
    if (ytReady && ytPlayer) {
      // user gestureコンテキスト内でロード+再生 → モバイルでもautoplay制約を超えられる
      ytPlayer.loadVideoById({ videoId, startSeconds: start });
    } else {
      // API/player 準備中だけ pending に積む。iframe src の直書き換えは二重ロードの原因になる。
      pendingVideoId = videoId;
      pendingStart = start;
      loadYTApi();
    }
  }
  function minimizePlayer() {
    overlay.classList.add('is-pip');
    document.body.style.overflow = '';
  }
  function expandPlayer() {
    overlay.classList.remove('is-pip');
    document.body.style.overflow = 'hidden';
  }
  function closePlayer() {
    // 停止前に再生位置を保存する（×ボタン / Esc / 背景クリック 共通パス）
    // savePositionNow() の中で refreshProgressForVideo も走るのでサムネは即更新される。
    savePositionNow();
    stopSaveInterval();
    currentVideoId = null;
    if (ytPlayer) {
      if (ytPlayer.stopVideo) ytPlayer.stopVideo();
    }
    overlay.hidden = true;
    overlay.classList.remove('is-pip');
    document.body.style.overflow = '';
  }
  closeBtn.addEventListener('click', closePlayer);
  minimizeBtn.addEventListener('click', minimizePlayer);
  expandBtn.addEventListener('click', expandPlayer);
  overlay.addEventListener('click', (e) => {
    // PiP モード時はオーバーレイ自体が pointer-events: none なので発火しない
    if (e.target === overlay) closePlayer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closePlayer();
  });
  // タブ切替・バックグラウンド化・PWA終了時も保存（beforeunloadはモバイルSafariで不発なので使わない）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePositionNow();
  });
  window.addEventListener('pagehide', savePositionNow);

  // ── ブックマーク UI ─────────────────────────────
  function metaFromCard(card) {
    return {
      videoId: card.dataset.videoId,
      title: card.dataset.title,
      channelTitle: card.dataset.channel,
      thumbnail: card.dataset.thumbnail,
      publishedIso: card.dataset.published,
      duration: card.dataset.duration || '',
    };
  }

  function updateLaterCount() {
    const n = Object.keys(loadLater()).length;
    const el = document.getElementById('later-count');
    if (n > 0) { el.textContent = n; el.hidden = false; }
    else       { el.hidden = true; }
  }

  function toggleLater(meta, btn, fromLater = false) {
    const all = loadLater();
    if (all[meta.videoId]) {
      delete all[meta.videoId];
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', 'あとで見るに追加');
      // 「あとで」タブから外した = 見終わった、として新着からも隠す
      if (fromLater) {
        addToHidden(meta.videoId);
        removeFeedCard(meta.videoId);
      }
    } else {
      all[meta.videoId] = {
        title: meta.title,
        channelTitle: meta.channelTitle,
        thumbnail: meta.thumbnail,
        publishedIso: meta.publishedIso,
        duration: meta.duration || '',
        savedAt: Date.now(),
      };
      btn.setAttribute('aria-pressed', 'true');
      btn.setAttribute('aria-label', 'あとで見るから削除');
      btn.classList.remove('just-saved');
      // reflow to restart the animation
      void btn.offsetWidth;
      btn.classList.add('just-saved');
    }
    saveLater(all);
    updateLaterCount();
    renderLater();
  }

  function removeFeedCard(videoId) {
    const card = document.querySelector(`#grid-feed .card[data-video-id="${CSS.escape(videoId)}"]`);
    if (card) card.remove();
  }

  function filterHiddenFromFeed() {
    const hidden = loadHidden();
    if (Object.keys(hidden).length === 0) return;
    document.querySelectorAll('#grid-feed .card').forEach((card) => {
      if (hidden[card.dataset.videoId]) card.remove();
    });
  }

  function markBookmarksInFeed() {
    const all = loadLater();
    document.querySelectorAll('#grid-feed .card').forEach((card) => {
      const id = card.dataset.videoId;
      const btn = card.querySelector('.bookmark-btn');
      if (!btn) return;
      if (all[id]) {
        btn.setAttribute('aria-pressed', 'true');
        btn.setAttribute('aria-label', 'あとで見るから削除');
      }
    });
  }

  function wireCard(card, fromLater = false) {
    card.addEventListener('click', (e) => {
      // ブックマーク操作は再生トリガに含めない
      if (e.target.closest('.bookmark-btn')) return;
      const id = card.dataset.videoId;
      if (id) openPlayer(id);
    });
    const btn = card.querySelector('.bookmark-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleLater(metaFromCard(card), btn, fromLater);
      });
    }
  }

  // ── Watch Later 一覧描画 ─────────────────────────────
  const laterGrid = document.getElementById('grid-later');
  const laterEmpty = document.getElementById('later-empty');

  function renderLater() {
    const all = loadLater();
    const entries = Object.entries(all)
      .map(([videoId, v]) => ({ videoId, ...v }))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

    laterGrid.innerHTML = '';
    if (entries.length === 0) {
      return; // empty表示はタブ切替側で制御
    }

    for (const v of entries) {
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.videoId = v.videoId;
      card.dataset.title = v.title || '';
      card.dataset.channel = v.channelTitle || '';
      card.dataset.thumbnail = v.thumbnail || '';
      card.dataset.published = v.publishedIso || '';
      card.dataset.duration = v.duration || '';

      const timeLabel = relTime(v.publishedIso);
      const durationBadge = v.duration
        ? `<span class="duration-badge">${escapeHtml(v.duration)}</span>`
        : '';

      card.innerHTML = `
        <div class="thumb">
          <img src="${escapeHtml(v.thumbnail || '')}" alt="" loading="lazy">
          <div class="play-overlay">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <button class="bookmark-btn" aria-label="あとで見るから削除" aria-pressed="true">
            <svg class="bookmark-icon" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          ${durationBadge}
        </div>
        <div class="meta">
          <div class="title">${escapeHtml(v.title || '')}</div>
          <div class="sub">
            <span class="channel">${escapeHtml(v.channelTitle || '')}</span>
            ${timeLabel ? `<span class="dot">•</span><span class="time">${timeLabel}</span>` : ''}
          </div>
        </div>`;

      wireCard(card, /* fromLater */ true);
      laterGrid.appendChild(card);
      applyProgressToCard(card);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── タブ切り替え ─────────────────────────────
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('[data-tab-panel]');

  function switchTab(name) {
    tabs.forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    panels.forEach((p) => {
      if (p.dataset.tabPanel !== name) { p.hidden = true; return; }
      // later-empty は中身があるかで分岐
      if (p.id === 'later-empty') {
        p.hidden = Object.keys(loadLater()).length !== 0;
      } else if (p.id === 'grid-later') {
        p.hidden = Object.keys(loadLater()).length === 0;
      } else {
        p.hidden = false;
      }
    });
    // 選択タブをURLハッシュに反映（リロードで維持）
    if (name === 'later') {
      history.replaceState(null, '', '#later');
    } else {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
  tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ── 起動処理 ─────────────────────────────
  filterHiddenFromFeed();
  document.querySelectorAll('#grid-feed .card').forEach((card) => wireCard(card, /* fromLater */ false));
  markBookmarksInFeed();
  applyProgressToAllCards();
  updateLaterCount();
  renderLater();
  loadYTApi();

  // #later でアクセスされたら最初からあとで見るタブ
  if (location.hash === '#later') {
    switchTab('later');
  } else {
    switchTab('feed');
  }
})();
