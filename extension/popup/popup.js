/**
 * Popup controller.
 *
 * Renders the queue, the current-tab quick download, and the cookie panel.
 * All work is delegated to the background worker so this file stays a pure
 * view layer.
 */

import { t, applyTo, initLanguage, getLanguage } from '../i18n.js';
import { detect as detectSite, supportsSubtitles } from '../sites.js';

const $ = (sel) => document.querySelector(sel);

let settings = {};
let jobs = [];
let stats = {};
let currentTab = null;
let currentInfo = null;
let selectedHeight = null;
let selectedMode = 'video';
let activeView = 'queue';

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res ?? { ok: false, error: 'No response' });
    });
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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

/** Size label for a quality chip. Approximate estimates get a leading tilde. */
function formatSizeLabel(bytes, approx) {
  const text = formatBytes(bytes);
  if (!text) return '';
  return approx ? `~${text}` : text;
}

function formatEta(eta) {
  if (!eta) return '';
  return String(eta).replace(/^ETA\s*/i, '');
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return t('time_just_now');
  if (diff < 3600000) return t('time_min_ago', { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('time_hours_ago', { n: Math.floor(diff / 3600000) });
  return new Date(ts).toLocaleDateString();
}

/**
 * The bridge builds qualityLabel from unlocalised words ("Thumbnail",
 * "Audio MP3"). Translate the generic ones and leave "1080p" style labels
 * untouched, since numbers are language-neutral.
 */
function localiseQuality(job) {
  const label = job.qualityLabel || '';
  if (job.mode === 'thumbnail') return t('cover');
  if (job.mode === 'audio') {
    const fmt = label.replace(/^Audio\s*/i, '').trim();
    return fmt ? `${t('audio_label')} ${fmt}` : t('audio_label');
  }
  return label;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Media id for a supported site URL, via the shared adapter table. */
function extractVideoId(url) {
  return detectSite(url)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Bridge status
// ---------------------------------------------------------------------------

async function refreshHealth() {
  const status = $('#status');
  const text = $('#statusText');
  const help = $('#helpBox');

  const res = await send('bridge:health');
  if (res.ok) {
    status.className = 'status online';
    const bins = res.health.binaries || {};
    text.textContent = bins.ytDlp?.ok
      ? `${t('bridge_connected')} · yt-dlp ${bins.ytDlp.version || ''}`.trim()
      : t('bridge_ytdlp_missing');
    if (!bins.ytDlp?.ok) {
      status.className = 'status offline';
      text.textContent = t('bridge_ytdlp_missing');
    }
    help.hidden = true;
    if (!bins.ffmpeg?.ok) {
      text.textContent += ` · ${t('bridge_ffmpeg_missing')}`;
    }
    return true;
  }

  status.className = 'status offline';
  text.textContent = t('bridge_not_running');
  help.hidden = false;
  updateLaunchRow();
  return false;
}

/**
 * Opening the popup should bring the bridge up. The extension cannot spawn a
 * process itself; it asks the login launcher on port 8766, which can.
 */
async function ensureBridge() {
  if (await refreshHealth()) return true;

  $('#status').className = 'status checking';
  $('#statusText').textContent = t('launch_starting');
  $('#helpBox').hidden = true;

  const launched = await send('bridge:launch');
  if (!launched.ok) {
    await refreshHealth();
    return false;
  }

  $('#statusText').textContent = t('launch_waiting');
  const ready = await send('bridge:await', { timeoutMs: 25000 });
  const online = await refreshHealth();
  return Boolean(ready.ok && online);
}

/** Manual retry, shown only when opening the popup could not start the bridge. */
async function updateLaunchRow() {
  const row = $('#launchRow');
  if (!row) return;
  // The launcher service is what actually starts the bridge, on every OS.
  row.hidden = false;
}

// ---------------------------------------------------------------------------
// Queue rendering
// ---------------------------------------------------------------------------

function jobRow(job, { showActions = true } = {}) {
  const isActive = job.status === 'running' || job.status === 'queued';
  const pct = job.status === 'done' ? 100 : Math.round(job.progress || 0);

  const statsLine = [];
  if (job.status === 'running') {
    if (job.speed) statsLine.push(job.speed);
    if (job.eta) statsLine.push(`${t('eta')} ${formatEta(job.eta)}`);
    if (job.totalBytes) {
      statsLine.push(`${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`);
    } else if (job.downloadedBytes) {
      statsLine.push(formatBytes(job.downloadedBytes));
    }
  } else if (job.status === 'done') {
    if (job.fileSize) statsLine.push(formatBytes(job.fileSize));
    statsLine.push(relativeTime(job.finishedAt));
  } else if (job.status === 'failed') {
    statsLine.push(relativeTime(job.finishedAt));
  } else {
    statsLine.push(relativeTime(job.createdAt));
  }

  const actions = [];
  if (showActions) {
    // Escape the id like every other interpolated value: it is server-generated
    // today, but an unescaped attribute is a latent injection point.
    const safeId = escapeHtml(job.id);
    if (isActive) {
      actions.push(`<button class="mini danger" data-act="cancel" data-id="${safeId}" title="${escapeHtml(t('act_cancel'))}">✕</button>`);
    } else if (job.status === 'done') {
      actions.push(`<button class="mini" data-act="save" data-id="${safeId}" title="${escapeHtml(t('act_save'))}">↓</button>`);
      actions.push(`<button class="mini" data-act="folder" data-id="${safeId}" title="${escapeHtml(t('act_folder'))}">📁</button>`);
      actions.push(`<button class="mini danger" data-act="remove" data-id="${safeId}" title="${escapeHtml(t('act_remove'))}">✕</button>`);
    } else {
      actions.push(`<button class="mini" data-act="retry" data-id="${safeId}" title="${escapeHtml(t('act_retry'))}">↻</button>`);
      actions.push(`<button class="mini danger" data-act="remove" data-id="${safeId}" title="${escapeHtml(t('act_remove'))}">✕</button>`);
    }
  }

  return `
    <div class="job" data-job="${escapeHtml(job.id)}">
      <div class="job-thumb">
        ${job.thumbnail ? `<img src="${escapeHtml(job.thumbnail)}" alt="" style="width:100%;height:100%;object-fit:cover">` : ''}
      </div>
      <div class="job-body">
        <div class="job-title">${escapeHtml(job.title)}</div>
        <div class="job-meta">
          <span class="pill ${job.status}">${escapeHtml(t(`status_${job.status}`))}</span>
          <span>${escapeHtml(localiseQuality(job))}</span>
          ${job.mode === 'audio' ? `<span>· ${escapeHtml(t('audio_label'))}</span>` : ''}
        </div>
        <div class="bar ${job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : ''}">
          <i style="width:${pct}%"></i>
        </div>
        <div class="job-stats">
          <span>${job.status === 'running' ? `${pct}%` : ''}</span>
          <span>${escapeHtml(statsLine.join(' · '))}</span>
        </div>
        ${job.error ? `<div class="job-error">${escapeHtml(job.error)}</div>` : ''}
      </div>
      <div class="job-actions">${actions.join('')}</div>
    </div>
  `;
}

function renderQueue() {
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const done = jobs.filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled');

  // The Queue tab shows everything still in flight; History shows the rest.
  const list = $('#jobList');
  const hist = $('#historyList');

  list.innerHTML = active.map((j) => jobRow(j)).join('');
  hist.innerHTML = done.map((j) => jobRow(j)).join('');

  $('#emptyQueue').hidden = active.length > 0;
  $('#emptyHistory').hidden = done.length > 0;

  // Derive the counters from the job list we are actually rendering rather
  // than from the `stats` payload. The two can briefly disagree (a job event
  // arrives with stats computed before that job settled), which would show a
  // badge counting rows that are not on screen.
  const runningCount = jobs.filter((j) => j.status === 'running').length;
  const queuedCount = jobs.filter((j) => j.status === 'queued').length;

  const summary = [];
  if (runningCount) summary.push(t('queue_downloading', { n: runningCount }));
  if (queuedCount) summary.push(t('queue_queued_n', { n: queuedCount }));
  $('#queueSummary').textContent = summary.length ? summary.join(' · ') : t('queue_none_active');

  const badge = $('#badgeActive');
  const activeCount = active.length;
  badge.hidden = activeCount === 0;
  badge.textContent = String(activeCount);

  $('#btnClear').hidden = done.length === 0;
}

// ---------------------------------------------------------------------------
// Current tab card
// ---------------------------------------------------------------------------

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const videoId = extractVideoId(tab?.url);

  if (!videoId) {
    $('#currentCard').hidden = true;
    return;
  }

  $('#currentCard').hidden = false;
  $('#curTitle').textContent = tab.title?.replace(/ - YouTube$/, '') || t('reading_formats');
  $('#curSub').textContent = t('reading_formats');
  $('#curThumb').removeAttribute('src');
  $('#curQualities').innerHTML = '<div class="spinner"></div>';

  const res = await send('video:probe', { videoId, url: tab.url });
  if (!res.ok) {
    $('#curSub').textContent = '';
    $('#curQualities').innerHTML = '';
    showMsg('#curMsg', 'err', res.error);
    return;
  }

  currentInfo = res.info;
  renderCurrentInfo();
}

function renderCurrentInfo() {
  const info = currentInfo;
  const ladder = info.formats?.ladder ?? [];

  $('#curTitle').textContent = info.title;
  $('#curThumb').src = info.thumbnail || '';
  $('#curSub').textContent =
    [info.uploader, info.durationText].filter(Boolean).join(' · ');

  const preferred = settings.defaultQuality ?? 1080;
  const heights = ladder.map((f) => f.height);
  // Closest quality at or below the user's preference.
  selectedHeight = heights.filter((h) => h <= preferred).sort((a, b) => b - a)[0]
    ?? heights.sort((a, b) => b - a)[0]
    ?? null;

  $('#curQualities').innerHTML = ladder.length
    ? ladder.map((f) => {
        const size = formatSizeLabel(f.filesize, f.filesizeApprox);
        return `<button class="chip${f.height === selectedHeight ? ' on' : ''}"
                  data-height="${f.height}" data-selector="${escapeHtml(f.selector)}">
                  ${escapeHtml(f.label)}${size ? ` <small>${escapeHtml(size)}</small>` : ''}
                </button>`;
      }).join('')
    : `<span class="muted">${escapeHtml(t('no_formats'))}</span>`;

  renderSubtitlePicker(info);

  $('#curQualities').querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#curQualities').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
      selectedHeight = Number(chip.dataset.height);
      selectedMode = 'video';
    });
  });
}

/**
 * Prefer the interface language, then English, and put human captions ahead
 * of automatic ones so the dropdown opens on a useful track.
 */
function sortSubtitles(subs) {
  const wanted = getLanguage() === 'zh' ? ['zh', 'en'] : ['en', 'zh'];
  const rank = (s) => {
    const lang = (s.lang || '').toLowerCase();
    const idx = wanted.findIndex((w) => lang === w || lang.startsWith(`${w}-`));
    if (idx >= 0) return idx * 2 + (s.kind === 'manual' ? 0 : 1);
    return 10 + (s.kind === 'manual' ? 0 : 2);
  };
  return subs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map(({ s }) => s);
}

function renderSubtitlePicker(info) {
  const block = $('#curSubs');
  const select = $('#subLang');
  const toggle = $('#optSubs');
  const pageUrl = info.webpageUrl || currentTab?.url;
  const subs = sortSubtitles(info.subtitles ?? []);

  if (!supportsSubtitles(pageUrl)) {
    block.hidden = true;
    return;
  }

  block.hidden = false;
  toggle.checked = Boolean(settings.writeSubtitles);
  select.innerHTML = subs.length
    ? subs.map((s) => {
        const kind = t(s.kind === 'auto' ? 'sub_kind_auto' : 'sub_kind_manual');
        return `<option value="${escapeHtml(s.lang)}">${escapeHtml(s.label)} (${escapeHtml(kind)})</option>`;
      }).join('')
    : '<option value="en">en (auto)</option>';
}

async function startCurrentDownload(mode = 'video') {
  if (!currentInfo) return;
  const btn = $('#curDownload');
  btn.disabled = true;
  btn.textContent = t('queuing');
  hideMsg('#curMsg');

  const pick = { mode };
  if (mode === 'video') {
    pick.height = selectedHeight;
    pick.selector = $(`#curQualities .chip.on`)?.dataset.selector || null;
    const subsBlock = $('#curSubs');
    if (subsBlock && !subsBlock.hidden) {
      const on = Boolean($('#optSubs')?.checked);
      pick.subtitles = on;
      if (on) {
        const lang = $('#subLang')?.value || 'en';
        pick.subtitleLangs = [lang];
        const track = (currentInfo.subtitles || []).find((s) => s.lang === lang);
        pick.subtitleAuto = track ? track.kind === 'auto' : true;
      }
    }
  }

  const res = await send('video:download', {
    videoId: currentInfo.videoId,
    url: currentInfo.webpageUrl,
    pick,
  });

  btn.disabled = false;
  btn.textContent = t('download');

  if (res.ok) {
    showMsg('#curMsg', 'ok', t('queued_see_tab', { quality: localiseQuality(res.job || {}) }));
    await refreshQueue();
  } else {
    showMsg('#curMsg', 'err', res.error);
  }
}

function showMsg(sel, kind, text) {
  const el = $(sel);
  el.className = `msg ${kind}`;
  el.textContent = text;
  el.hidden = false;
}
function hideMsg(sel) {
  $(sel).hidden = true;
}

// ---------------------------------------------------------------------------
// Queue data
// ---------------------------------------------------------------------------

async function refreshQueue() {
  const res = await send('queue:get');
  if (res.jobs) jobs = res.jobs;
  if (res.stats) stats = res.stats;
  renderQueue();
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

async function refreshCookieState() {
  const el = $('#cookieState');
  const res = await send('cookies:list');
  const profiles = res.profiles || [];

  if (!profiles.length) {
    el.innerHTML = `<div class="cookie-row"><span>${escapeHtml(t('cookies_none'))}</span>`
      + `<span class="muted">${escapeHtml(t('cookies_anonymous'))}</span></div>`;
    return;
  }
  el.innerHTML = profiles.map((p) => `
    <div class="cookie-row">
      <span>${escapeHtml(p.profile)}.txt</span>
      <span class="ok">${relativeTime(p.updatedAt)}</span>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

function switchView(view) {
  activeView = view;
  // NOTE: the loop variable must not be named `t` — that would shadow the
  // imported translate() for the rest of this function.
  document.querySelectorAll('.tab').forEach((tabEl) => {
    tabEl.classList.toggle('on', tabEl.dataset.view === view);
  });
  $('#viewQueue').hidden = view !== 'queue';
  $('#viewHistory').hidden = view !== 'history';
  $('#viewCookies').hidden = view !== 'cookies';
  if (view === 'cookies') refreshCookieState();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

$('#btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#btnRetry').addEventListener('click', async () => {
  $('#status').className = 'status checking';
  $('#statusText').textContent = t('reconnecting');
  await refreshHealth();
  await refreshQueue();
});

/**
 * One-click start.
 *
 * The extension cannot spawn a process, so this asks Windows to run the
 * registered ytdl:// handler, then waits for the bridge to actually answer.
 * Reporting success only after a real /health response avoids claiming a
 * start that silently failed (for example when the handler is not installed).
 */
$('#btnStartBridge').addEventListener('click', async () => {
  const btn = $('#btnStartBridge');
  const state = $('#launchState');

  btn.disabled = true;
  state.textContent = t('launch_starting');
  state.className = 'launch-state';

  const launched = await send('bridge:launch');
  if (!launched.ok) {
    btn.disabled = false;
    state.textContent = launched.error || t('launch_failed');
    state.className = 'launch-state err';
    // Point at the manual route rather than leaving the user stuck.
    $('#helpBox').hidden = false;
    return;
  }

  state.textContent = t('launch_waiting');
  const ready = await send('bridge:await', { timeoutMs: 25000 });

  btn.disabled = false;
  if (ready.ok) {
    state.textContent = t('launch_ok');
    state.className = 'launch-state ok';
    await refreshHealth();
    await refreshQueue();
    await loadCurrentTab();
  } else {
    state.textContent = ready.error || t('launch_failed');
    state.className = 'launch-state err';
  }
});

$('#subLang')?.addEventListener('change', () => {
  const toggle = $('#optSubs');
  if (toggle) toggle.checked = true;
});

$('#curDownload').addEventListener('click', () => startCurrentDownload('video'));
$('#curAudio').addEventListener('click', () => startCurrentDownload('audio'));
$('#curCover').addEventListener('click', () => startCurrentDownload('thumbnail'));

$('#btnClear').addEventListener('click', async () => {
  await send('job:clear', { deleteFiles: false });
  await refreshQueue();
});

// Opens the downloads folder itself (no specific job). Passing an explicit
// null id keeps this distinct from a caller that forgot to supply one.
$('#btnOpenFolder').addEventListener('click', () => send('file:openFolder', { id: null }));

$('#btnPushCookies').addEventListener('click', async () => {
  const btn = $('#btnPushCookies');
  btn.disabled = true;
  btn.textContent = t('cookies_sending');
  hideMsg('#cookieMsg');
  const res = await send('cookies:push');
  btn.disabled = false;
  btn.textContent = t('cookies_send');
  if (res.ok) {
    showMsg('#cookieMsg', 'ok', t('cookies_sent', { n: res.count }));
  } else {
    showMsg('#cookieMsg', 'err', res.error);
  }
  await refreshCookieState();
});

$('#linkClearCookies').addEventListener('click', async (e) => {
  e.preventDefault();
  await send('cookies:clear');
  showMsg('#cookieMsg', 'ok', t('cookies_deleted'));
  await refreshCookieState();
});

// Delegated actions on job rows.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  btn.disabled = true;

  // Report failures instead of swallowing them. Previously a failed action
  // left the button looking inert, with no way to tell what went wrong.
  let result = { ok: true };
  try {
    if (act === 'cancel') result = await send('job:cancel', { id });
    else if (act === 'retry') result = await send('job:retry', { id });
    else if (act === 'remove') result = await send('job:remove', { id, deleteFile: false });
    else if (act === 'save') result = await send('file:save', { id });
    else if (act === 'folder') result = await send('file:openFolder', { id });
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }

  btn.disabled = false;

  if (act === 'folder') {
    if (result?.ok) {
      // Tell the user when we could not reveal the file itself and opened the
      // folder instead, so it does not look like nothing happened.
      if (result.fellBack) showToast(t('folder_fell_back'), 'warn');
    } else {
      showToast(result?.error || t('folder_failed'), 'err');
    }
  } else if (result && result.ok === false && result.error) {
    showToast(result.error, 'err');
  }

  await refreshQueue();
});

// ---------------------------------------------------------------------------
// Transient status message
// ---------------------------------------------------------------------------

let toastTimer = null;

/** Show a short-lived message at the bottom of the popup. */
function showToast(text, kind = 'ok') {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast ${kind}`;
  el.textContent = text;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('gone');
    setTimeout(() => el.classList.remove('gone'), 250);
  }, 3200);
}

// Live updates pushed from the background worker.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'queue:snapshot') {
    jobs = message.jobs || [];
    stats = message.stats || {};
    renderQueue();
  } else if (message.type?.startsWith('job:')) {
    // Patch the single job in place so the scroll position survives.
    if (message.job) {
      const idx = jobs.findIndex((j) => j.id === message.job.id);
      if (idx === -1) jobs.unshift(message.job);
      else jobs[idx] = message.job;
    }
    if (message.stats) stats = message.stats;
    renderQueue();
  } else if (message.type === 'bridge:status') {
    if (!message.online) {
      $('#status').className = 'status offline';
      $('#statusText').textContent = t('bridge_not_running');
      $('#helpBox').hidden = false;
    }
  } else if (message.type === 'settings:changed') {
    settings = message.settings;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  // Resolve the language before the first render so no English text flashes
  // on a Chinese UI.
  await initLanguage();
  applyTo(document);

  const res = await send('settings:get');
  settings = res.settings || {};

  const online = await ensureBridge();
  await refreshQueue();
  if (online) await loadCurrentTab();
})();
