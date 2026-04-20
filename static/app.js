(function () {
  'use strict';

  const STORAGE_KEY = 'ytv_watch_later';
  const HIDDEN_KEY = 'ytv_hidden';

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
  const iframe = document.getElementById('player-iframe');
  const closeBtn = overlay.querySelector('.player-close');
  const minimizeBtn = overlay.querySelector('.player-minimize');
  const expandBtn = overlay.querySelector('.player-expand');

  let ytPlayer = null;
  let ytReady = false;
  let pendingVideoId = null;

  // YouTube IFrame APIスクリプトを読み込み（グローバルコールバック onYouTubeIframeAPIReady）
  (function loadYTApi() {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  })();

  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player('player-iframe', {
      events: {
        onReady: () => {
          ytReady = true;
          if (pendingVideoId) {
            ytPlayer.loadVideoById(pendingVideoId);
            pendingVideoId = null;
          }
        },
      },
    });
  };

  function openPlayer(videoId) {
    if (overlay.hidden) {
      overlay.hidden = false;
      overlay.classList.remove('is-pip');
      document.body.style.overflow = 'hidden';
    }
    if (ytReady && ytPlayer) {
      // user gestureコンテキスト内でロード+再生 → モバイルでもautoplay制約を超えられる
      ytPlayer.loadVideoById(videoId);
    } else {
      // API未ロード時はフォールバックでsrcを直接書き換え
      pendingVideoId = videoId;
      iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1&enablejsapi=1`;
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
    if (ytReady && ytPlayer && ytPlayer.stopVideo) {
      ytPlayer.stopVideo();
    } else {
      iframe.src = '';
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
  updateLaterCount();
  renderLater();

  // #later でアクセスされたら最初からあとで見るタブ
  if (location.hash === '#later') {
    switchTab('later');
  } else {
    switchTab('feed');
  }
})();
