/**
 * Content script: injects a floating download button on YouTube pages.
 *
 * YouTube is a single-page app, so we watch for navigation instead of relying
 * on a one-time document load, and we mount our UI inside a shadow root so
 * YouTube's own CSS can never bleed into it.
 */

(() => {
  const HOST_ID = 'ytd-downloader-root';
  if (window.__ytdOverlayLoaded) return;
  window.__ytdOverlayLoaded = true;

  // Content scripts cannot use ES module imports directly, so i18n and the site
  // table are pulled in dynamically. Until they resolve we fall back to safe
  // stubs, which keeps the button readable even if a module fails to load.
  let t = (key) => key;
  let getLang = () => 'en';
  let i18nReady = false;
  let sites = null; // the ./sites.js module once loaded

  const modulesPromise = Promise.all([
    import(chrome.runtime.getURL('i18n.js'))
      .then(async (mod) => {
        await mod.initLanguage();
        t = mod.t;
        getLang = mod.getLanguage;
        i18nReady = true;
      })
      .catch(() => null),
    import(chrome.runtime.getURL('sites.js'))
      .then((mod) => { sites = mod; })
      .catch(() => null),
  ]);

  let host = null;
  let shadow = null;
  let button = null;
  let panel = null;
  let settings = null;
  let currentVideoId = null;
  let cachedInfo = null;
  let probeToken = 0;
  /** Adapter for the current page, e.g. the YouTube or X descriptor. */
  let currentMatch = null;
  /** Feature flags for the current site (subtitles, quality ladder, ...). */
  let currentFeatures = null;
  /** Last seen location, used to detect SPA navigation. */
  let lastHref = location.href;

  // -------------------------------------------------------------------------
  // URL helpers
  // -------------------------------------------------------------------------

  /**
   * Media id for the current page, via the site adapter.
   *
   * Falls back to a YouTube-shaped parse if sites.js has not loaded yet, so the
   * button still appears promptly on YouTube.
   */
  function extractVideoId(url = location.href) {
    if (sites) return sites.detect(url, location.origin)?.id ?? null;

    try {
      const u = new URL(url, location.origin);
      if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
      return u.searchParams.get('v') || null;
    } catch {
      return null;
    }
  }

  /** True when this page is one where a single video can be downloaded. */
  function isWatchPage() {
    if (sites) return sites.isMediaPage(location.href, location.origin);
    return /^\/(watch|shorts|live|embed)/.test(location.pathname);
  }

  /** Whether the site provides real resolution tiers to choose from. */
  function hasQualityLadder() {
    return currentFeatures ? currentFeatures.qualityLadder : true;
  }

  function siteSupports(feature) {
    return currentFeatures ? Boolean(currentFeatures[feature]) : true;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response ?? { ok: false, error: 'No response from extension' });
      });
    });
  }

  // -------------------------------------------------------------------------
  // UI construction
  // -------------------------------------------------------------------------

  function buildUI() {
    if (host) return;

    host = document.createElement('div');
    host.id = HOST_ID;
    // Keep YouTube's own styles and keyboard handlers away from our widget.
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: "Roboto", "Segoe UI", system-ui, sans-serif; }

      .wrap { position: fixed; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
      .wrap.pos-bottom-right { right: 24px; bottom: 24px; }
      .wrap.pos-bottom-left  { left: 24px;  bottom: 24px; align-items: flex-start; }
      .wrap.pos-top-right    { right: 24px; top: 80px; }
      .wrap.pos-top-left     { left: 24px;  top: 80px; align-items: flex-start; }

      .fab {
        display: flex; align-items: center; gap: 8px;
        height: 44px; padding: 0 16px 0 13px;
        border: none; border-radius: 22px; cursor: pointer;
        background: linear-gradient(135deg, #ff0033, #c4002b);
        color: #fff; font-size: 14px; font-weight: 600; letter-spacing: .2px;
        box-shadow: 0 4px 16px rgba(0,0,0,.42);
        transition: transform .15s ease, box-shadow .15s ease, opacity .15s ease;
        white-space: nowrap;
      }
      .fab:hover { transform: translateY(-2px); box-shadow: 0 8px 22px rgba(0,0,0,.5); }
      .fab:active { transform: translateY(0); }
      .fab[disabled] { opacity: .6; cursor: default; transform: none; }
      .fab.busy svg { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .fab svg { width: 20px; height: 20px; flex: none; }

      .panel {
        width: 320px; max-height: 68vh; overflow-y: auto;
        background: #212121; color: #f1f1f1;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 14px; padding: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,.6);
        animation: rise .16s ease;
      }
      @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
      .panel[hidden] { display: none; }
      .panel::-webkit-scrollbar { width: 8px; }
      .panel::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }

      .p-head { display: flex; gap: 10px; margin-bottom: 12px; }
      .p-thumb { width: 84px; height: 47px; border-radius: 6px; object-fit: cover; flex: none; background: #333; }
      .p-meta { min-width: 0; }
      .p-title { font-size: 13px; font-weight: 600; line-height: 1.3; margin: 0 0 4px;
                 display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .p-sub { font-size: 11px; color: #aaa; }

      .label { font-size: 11px; text-transform: uppercase; letter-spacing: .6px;
               color: #999; margin: 12px 0 6px; font-weight: 600; }

      .tabs { display: flex; gap: 4px; background: #181818; padding: 4px; border-radius: 9px; }
      .tab { flex: 1; padding: 7px 0; border: none; border-radius: 6px; cursor: pointer;
             background: transparent; color: #bbb; font-size: 12px; font-weight: 600; }
      .tab:hover { color: #fff; }
      .tab.on { background: #3d3d3d; color: #fff; }

      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
      .q { padding: 9px 4px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
           background: #2a2a2a; color: #eee; font-size: 12px; font-weight: 600; cursor: pointer;
           text-align: center; transition: background .12s, border-color .12s; }
      .q:hover { background: #383838; border-color: rgba(255,255,255,.3); }
      .q.on { background: #ff0033; border-color: #ff0033; color: #fff; }
      .q small { display: block; font-size: 9px; font-weight: 400; color: #bbb; margin-top: 2px; }
      .q.on small { color: rgba(255,255,255,.85); }

      select { width: 100%; padding: 8px; border-radius: 8px; background: #2a2a2a;
               color: #eee; border: 1px solid rgba(255,255,255,.14); font-size: 12px; }

      .checks { display: flex; flex-direction: column; gap: 7px; }
      .chk { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #ddd; cursor: pointer; }
      .chk input { width: 15px; height: 15px; accent-color: #ff0033; cursor: pointer; }

      .go { width: 100%; margin-top: 14px; padding: 11px; border: none; border-radius: 9px;
            background: #ff0033; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer; }
      .go:hover { background: #e6002e; }
      .go[disabled] { opacity: .55; cursor: default; }

      .msg { margin-top: 10px; padding: 9px 10px; border-radius: 8px; font-size: 11.5px; line-height: 1.4; }
      .msg.err { background: rgba(255,0,51,.14); color: #ff8095; border: 1px solid rgba(255,0,51,.3); }
      .msg.ok  { background: rgba(0,200,83,.13); color: #6ee7a0; border: 1px solid rgba(0,200,83,.3); }
      .msg[hidden] { display: none; }

      .spin { display: flex; align-items: center; justify-content: center;
              padding: 26px 0; color: #aaa; font-size: 12px; gap: 9px; }
      .dot { width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.25);
             border-top-color: #ff0033; border-radius: 50%; animation: spin .8s linear infinite; }
    `;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = `wrap pos-${settings?.overlayPosition || 'bottom-right'}`;

    button = document.createElement('button');
    button.className = 'fab';
    button.innerHTML = `${iconSvg()}<span>${escapeHtml(t('ov_download'))}</span>`;
    button.addEventListener('click', onButtonClick);
    wrap.appendChild(button);

    panel = document.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    wrap.appendChild(panel);

    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);
  }

  function iconSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>`;
  }

  function spinnerSvg() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
              stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>`;
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  async function onButtonClick() {
    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    await showPicker();
  }

  async function showPicker() {
    const videoId = extractVideoId();
    if (!videoId) {
      renderMessage('err', t('ov_no_video'));
      return;
    }

    panel.innerHTML = `<div class="spin"><span class="dot"></span>${escapeHtml(t('ov_reading'))}</div>`;

    const myToken = ++probeToken;
    const result = await send('video:probe', { videoId, url: location.href });

    // A newer probe started while this one was in flight — drop this result.
    if (myToken !== probeToken) return;

    if (!result.ok) {
      renderMessage('err', result.error);
      return;
    }

    cachedInfo = result.info;
    renderPickerForm(cachedInfo);
  }

  /**
   * Order the subtitle dropdown so the most useful track is preselected:
   * interface language first (zh users see 中文 first, then English), manual
   * tracks before automatic ones, otherwise the provider order is kept.
   */
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** Second line under a quality button: frame rate and file size. */
  function qualityHint(format) {
    const parts = [];
    if (format.fps && format.fps >= 50) parts.push(`${Math.round(format.fps)}fps`);
    const size = formatBytes(format.filesize);
    if (size) parts.push(format.filesizeApprox ? `~${size}` : size);
    else if (format.ext) parts.push(format.ext);
    return parts.join(' · ');
  }

  function sortSubtitles(subs) {
    const wanted = getLang() === 'zh' ? ['zh', 'en'] : ['en', 'zh'];
    const rank = (s) => {
      const lang = (s.lang || '').toLowerCase();
      const idx = wanted.findIndex((w) => lang === w || lang.startsWith(w + '-'));
      if (idx >= 0) return idx * 2 + (s.kind === 'manual' ? 0 : 1);
      return 10 + (s.kind === 'manual' ? 0 : 2);
    };
    return subs
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .map(({ s }) => s);
  }

  function renderPickerForm(info) {
    const ladder = info.formats?.ladder ?? [];
    const audioOptions = info.formats?.audioOnly ?? [];
    const subs = sortSubtitles(info.subtitles ?? []);

    const preferred = settings?.defaultQuality ?? 1080;
    const available = ladder.map((f) => f.height);
    // Pick the closest quality that does not exceed the preference.
    const initial = available.filter((h) => h <= preferred).sort((a, b) => b - a)[0]
      ?? available.sort((a, b) => b - a)[0]
      ?? null;

    // Build the quality grid only for sites that actually offer tiers. On X
    // there is a single progressive file, so an empty "Quality" section would
    // be confusing; we omit it and let yt-dlp pick the best.
    const showQuality = hasQualityLadder() && ladder.length > 0;
    const showSubtitles = siteSupports('subtitles');
    const showSponsor = siteSupports('sponsorblock');

    panel.innerHTML = `
      <div class="p-head">
        ${info.thumbnail ? `<img class="p-thumb" src="${escapeAttr(info.thumbnail)}" alt="">` : ''}
        <div class="p-meta">
          <p class="p-title">${escapeHtml(info.title)}</p>
          <div class="p-sub">${escapeHtml(info.uploader || '')}${info.durationText ? ` · ${info.durationText}` : ''}</div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab on" data-mode="video">${escapeHtml(t('ov_video'))}</button>
        <button class="tab" data-mode="audio">${escapeHtml(t('ov_audio'))}</button>
        ${siteSupports('thumbnails') ? `<button class="tab" data-mode="thumbnail">${escapeHtml(t('ov_cover'))}</button>` : ''}
      </div>

      <div data-pane="video">
        ${showQuality ? `
        <div class="label">${escapeHtml(t('ov_quality'))}</div>
        <div class="grid" id="qualityGrid">
          ${ladder.map((f) => `
            <button class="q${f.height === initial ? ' on' : ''}" data-height="${f.height}"
                    data-selector="${escapeAttr(f.selector)}" title="${escapeAttr(f.vcodec || '')} ${escapeAttr(f.hasAudio ? t('chip_has_audio') : t('chip_best_audio'))}">
              ${escapeHtml(f.label)}<small>${escapeHtml(qualityHint(f))}</small>
            </button>`).join('')}
        </div>` : `
        <div class="label">${escapeHtml(t('ov_quality'))}</div>
        <div class="p-sub">${escapeHtml(t('ov_single_format', { site: currentMatch?.siteLabel || '' }))}</div>`}

        <div class="label">${escapeHtml(t('ov_options'))}</div>
        <div class="checks">
          ${showSubtitles ? `<label class="chk"><input type="checkbox" id="optSubs" ${settings?.writeSubtitles ? 'checked' : ''}> ${escapeHtml(t('ov_save_subs'))}</label>` : ''}
          <label class="chk"><input type="checkbox" id="optEmbedThumb" ${settings?.embedThumbnail ? 'checked' : ''}> ${escapeHtml(t('ov_embed_thumb'))}</label>
          ${showSponsor ? `<label class="chk"><input type="checkbox" id="optSponsor" ${settings?.sponsorblock ? 'checked' : ''}> ${escapeHtml(t('ov_sponsor'))}</label>` : ''}
        </div>

        ${showSubtitles ? `
        <!-- The language list is always visible (not hidden behind the checkbox) so
             users can see which subtitle languages this video offers and pick one
             before downloading. Previously the block was hidden until 「保存字幕」
             was checked, so many never found it. Still gated on showSubtitles so it
             only appears on sites that actually support subtitles. -->
        <div id="subsBlock">
          <div class="label">${escapeHtml(t('ov_sub_lang'))}</div>
          <select id="subLang">
            ${subs.length
              ? subs.map((s) => `<option value="${escapeAttr(s.lang)}">${escapeHtml(s.label)} (${escapeHtml(t(s.kind === 'auto' ? 'sub_kind_auto' : 'sub_kind_manual'))})</option>`).join('')
              : '<option value="en">en (auto)</option>'}
          </select>
        </div>
        ` : ''}
      </div>

      <div data-pane="audio" hidden>
        <div class="label">${escapeHtml(t('ov_audio_format'))}</div>
        <div class="grid" id="audioGrid">
          ${['mp3', 'm4a', 'opus', 'wav'].map((f) => `
            <button class="q${f === (settings?.audioFormat || 'mp3') ? ' on' : ''}" data-audio="${f}">${f.toUpperCase()}</button>
          `).join('')}
        </div>
        ${audioOptions.length ? `<div class="label">${escapeHtml(t('ov_source_stream'))}</div>
        <select id="audioSrc">
          ${audioOptions.map((a) => `<option value="${escapeAttr(a.selector)}">${a.abr ? Math.round(a.abr) + ' kbps' : ''} ${a.acodec || ''} (${a.ext})</option>`).join('')}
        </select>` : ''}
      </div>

      <div data-pane="thumbnail" hidden>
        <div class="msg ok" style="margin-top:12px">${escapeHtml(t('ov_cover_note'))}</div>
      </div>

      <button class="go" id="goBtn">${escapeHtml(t('ov_download'))}</button>
      <div class="msg" id="panelMsg" hidden></div>
    `;

    wirePickerEvents(info);
  }

  function wirePickerEvents(info) {
    let mode = 'video';
    let height = Number(panel.querySelector('.q.on')?.dataset.height) || null;
    let audioFormat = settings?.audioFormat || 'mp3';

    panel.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        mode = tab.dataset.mode;
        // NOTE: the loop variable must not be `t` — that shadows translate().
        panel.querySelectorAll('.tab').forEach((tabEl) => tabEl.classList.toggle('on', tabEl === tab));
        panel.querySelectorAll('[data-pane]').forEach((p) => {
          p.hidden = p.dataset.pane !== mode;
        });
      });
    });

    panel.querySelectorAll('#qualityGrid .q').forEach((btn) => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('#qualityGrid .q').forEach((b) => b.classList.toggle('on', b === btn));
        height = Number(btn.dataset.height);
      });
    });

    panel.querySelectorAll('#audioGrid .q').forEach((btn) => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('#audioGrid .q').forEach((b) => b.classList.toggle('on', b === btn));
        audioFormat = btn.dataset.audio;
      });
    });

    const subsToggle = panel.querySelector('#optSubs');
    const subLang = panel.querySelector('#subLang');
    // The language list is always visible now, so picking one is the signal that
    // the user wants subtitles: auto-enable 「保存字幕」. This closes the old
    // gap where a user could choose a language but nothing downloaded because the
    // checkbox stayed unchecked.
    if (subLang && subsToggle) {
      subLang.addEventListener('change', () => {
        subsToggle.checked = true;
      });
    }

    panel.querySelector('#goBtn').addEventListener('click', async () => {
      const goBtn = panel.querySelector('#goBtn');
      goBtn.disabled = true;
      goBtn.textContent = t('ov_adding');

      const pick = { mode };
      if (mode === 'video') {
        pick.height = height;
        pick.selector = panel.querySelector('#qualityGrid .q.on')?.dataset.selector || null;
        if (subsToggle) {
          pick.subtitles = subsToggle.checked;
          if (subsToggle.checked) {
            const lang = panel.querySelector('#subLang')?.value || 'en';
            pick.subtitleLangs = [lang];
            // Only request ASR captions when the chosen track is auto-generated.
            // Manual tracks then skip `--write-auto-subs` entirely, which avoids
            // YouTube's 429 throttling of anonymous auto-caption downloads.
            const track = (cachedInfo?.subtitles || []).find((s) => s.lang === lang);
            pick.subtitleAuto = track ? track.kind === 'auto' : true;
          }
        }
      } else if (mode === 'audio') {
        pick.audioFormat = audioFormat;
        pick.audioSelector = panel.querySelector('#audioSrc')?.value || null;
      }

      const result = await send('video:download', {
        videoId: info.videoId,
        url: info.webpageUrl,
        pick,
      });

      if (result.ok) {
        renderMessage('ok', t('ov_queued_ok', {
          quality: result.job?.qualityLabel || '',
        }));
        goBtn.textContent = t('ov_queued_btn');
        setTimeout(() => { panel.hidden = true; }, 1800);
      } else {
        renderMessage('err', result.error);
        goBtn.disabled = false;
        goBtn.textContent = t('ov_download');
      }
    });
  }

  function renderMessage(kind, text) {
    panel.innerHTML = `<div class="msg ${kind}">${escapeHtml(text)}</div>`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function escapeAttr(value) {
    return escapeHtml(value);
  }

  // -------------------------------------------------------------------------
  // Page lifecycle
  // -------------------------------------------------------------------------

  /**
   * Decide whether the floating button should be visible.
   *
   * Beyond "is this a video page", sites like X can show a status post with no
   * video at all, so we also ask the adapter whether the page actually contains
   * downloadable media. Showing a Download button on a text-only post would be
   * misleading.
   */
  function syncVisibility() {
    if (!host) return;

    const configured = Boolean(settings?.showOverlayButton);
    const onMediaPage = isWatchPage() && Boolean(extractVideoId());
    const hasMedia = sites
      ? sites.hasDownloadableMedia(location.href, location.origin)
      : onMediaPage;

    host.style.display = (configured && onMediaPage && hasMedia) ? 'block' : 'none';

    if (settings?.overlayPosition && shadow) {
      const wrap = shadow.querySelector('.wrap');
      if (wrap) wrap.className = `wrap pos-${settings.overlayPosition}`;
    }
  }

  /** Refresh the cached adapter for the current page. */
  function refreshSiteMatch() {
    currentMatch = sites ? sites.detect(location.href, location.origin) : null;
    currentFeatures = currentMatch?.features ?? null;
  }

  /**
   * Videos are swapped in place (YouTube) or revealed lazily (X), so reset
   * cached state whenever the page identity changes.
   */
  function onNavigate() {
    const id = extractVideoId();
    const urlChanged = location.href !== lastHref;

    if (id === currentVideoId && !urlChanged) {
      // Same media: X may have only just rendered the <video> element, so
      // re-check visibility without discarding the probe result.
      syncVisibility();
      return;
    }

    currentVideoId = id;
    cachedInfo = null;
    probeToken += 1; // invalidate any in-flight probe
    if (panel) panel.hidden = true;
    refreshSiteMatch();
    syncVisibility();
  }

  // YouTube fires this custom event on every SPA navigation.
  window.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('yt-page-data-updated', onNavigate);
  // X renders tweets progressively: a status page can be reached before its
  // <video> exists, so watch the DOM and re-evaluate as it fills in.
  if (typeof MutationObserver !== 'undefined') {
    let observerTimer = null;
    const observer = new MutationObserver(() => {
      // Coalesce bursts of mutations into one check.
      clearTimeout(observerTimer);
      observerTimer = setTimeout(syncVisibility, 300);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  // Fallback for the non-SPA and mobile layouts.
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onNavigate();
    }
  }, 800);

  // React to settings changes made in the options page or popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (settings) settings[key] = newValue;
    }

    // A language change should relabel the button without a page reload.
    if (changes.language && i18nReady) {
      const label = button?.querySelector('span');
      if (label) label.textContent = t('ov_download');
      // The picker is rebuilt from scratch on each open, so it needs no update.
      if (panel && !panel.hidden) panel.hidden = true;
    }

    syncVisibility();
  });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Defaults used when the background worker cannot be reached.
   *
   * These must be permissive: `syncVisibility()` hides the button when
   * `showOverlayButton` is falsy, so falling back to an empty object after a
   * transient background failure would hide the button for the lifetime of
   * the tab with no way to recover.
   */
  const FALLBACK_SETTINGS = {
    showOverlayButton: true,
    overlayPosition: 'bottom-right',
    defaultQuality: 1080,
    defaultMode: 'video',
    audioFormat: 'mp3',
    writeSubtitles: false,
    embedThumbnail: false,
    sponsorblock: false,
  };

  async function boot() {
    // Wait for the dictionaries and the site table before building the UI:
    // otherwise the button briefly renders a raw translation key and page
    // detection runs without adapters.
    await modulesPromise;

    refreshSiteMatch();
    currentVideoId = extractVideoId();

    const result = await send('content:register', { url: location.href });
    if (result?.ok && result.settings) {
      settings = result.settings;
      // Trust the worker's detection if it succeeded; it may know a site the
      // page-side table does not (for example right after an update).
      if (result.features) currentFeatures = result.features;
    } else {
      // The worker may still be starting up. Show the button with defaults and
      // retry shortly so a real configuration is picked up once it responds.
      settings = { ...FALLBACK_SETTINGS };
      retryRegister();
    }

    buildUI();
    syncVisibility();
  }

  let registerRetries = 0;

  /** Re-attempt registration a few times, then give up quietly. */
  function retryRegister() {
    if (registerRetries >= 5) return;
    registerRetries += 1;
    setTimeout(async () => {
      const result = await send('content:register', { url: location.href });
      if (result?.ok && result.settings) {
        settings = result.settings;
        registerRetries = 0;
      } else {
        retryRegister();
        return;
      }
      syncVisibility();
    }, 700 * registerRetries);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
