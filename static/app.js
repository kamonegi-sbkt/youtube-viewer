(function () {
  'use strict';

  const STORAGE_KEY = 'ytv_watch_later';

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

  // ── iframeプレイヤー ─────────────────────────────
  const overlay = document.getElementById('player-overlay');
  const iframe = document.getElementById('player-iframe');
  const closeBtn = overlay.querySelector('.player-close');
  const minimizeBtn = overlay.querySelector('.player-minimize');
  const expandBtn = overlay.querySelector('.player-expand');

  function openPlayer(videoId) {
    const src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
    if (overlay.hidden) {
      iframe.src = src;
      overlay.hidden = false;
      overlay.classList.remove('is-pip');
      document.body.style.overflow = 'hidden';
    } else {
      // 再生中に別カードをタップ → src だけ差し替え（PiP/fullscreen モードは維持）
      iframe.src = src;
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
    iframe.src = '';
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
    };
  }

  function updateLaterCount() {
    const n = Object.keys(loadLater()).length;
    const el = document.getElementById('later-count');
    if (n > 0) { el.textContent = n; el.hidden = false; }
    else       { el.hidden = true; }
  }

  function toggleLater(meta, btn) {
    const all = loadLater();
    if (all[meta.videoId]) {
      delete all[meta.videoId];
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', 'あとで見るに追加');
    } else {
      all[meta.videoId] = {
        title: meta.title,
        channelTitle: meta.channelTitle,
        thumbnail: meta.thumbnail,
        publishedIso: meta.publishedIso,
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

  function wireCard(card) {
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
        toggleLater(metaFromCard(card), btn);
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

      const timeLabel = relTime(v.publishedIso);

      card.innerHTML = `
        <div class="thumb">
          <img src="${escapeHtml(v.thumbnail || '')}" alt="" loading="lazy">
          <div class="play-overlay">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="play-overlay-mini" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <button class="bookmark-btn" aria-label="あとで見るから削除" aria-pressed="true">
            <svg class="bookmark-icon" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
        </div>
        <div class="meta">
          <div class="title">${escapeHtml(v.title || '')}</div>
          <div class="sub">
            <span class="channel">${escapeHtml(v.channelTitle || '')}</span>
            ${timeLabel ? `<span class="dot">•</span><span class="time">${timeLabel}</span>` : ''}
          </div>
        </div>`;

      wireCard(card);
      // Watch Later側でブックマーク押下 → フィード側にも反映
      card.querySelector('.bookmark-btn').addEventListener('click', () => {
        // toggleLaterがlocalStorage更新+renderLater()を呼ぶので、
        // フィード側のアイコンも後追い同期する
        syncFeedBookmarks();
      });
      laterGrid.appendChild(card);
    }
  }

  function syncFeedBookmarks() {
    const all = loadLater();
    document.querySelectorAll('#grid-feed .card').forEach((card) => {
      const btn = card.querySelector('.bookmark-btn');
      if (!btn) return;
      const saved = !!all[card.dataset.videoId];
      btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
      btn.setAttribute('aria-label', saved ? 'あとで見るから削除' : 'あとで見るに追加');
    });
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
  document.querySelectorAll('#grid-feed .card').forEach(wireCard);
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
