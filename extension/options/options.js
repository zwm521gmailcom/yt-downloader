/**
 * Options page controller.
 *
 * Reads the stored settings into the form, writes them back on save, and
 * offers a live connection test against the local bridge.
 */

import { t, applyTo, initLanguage, setLanguage } from '../i18n.js';

const FIELDS = {
  text: ['bridgeUrl', 'token', 'cookieProfile'],
  select: ['defaultMode', 'defaultQuality', 'container', 'audioFormat', 'subtitleFormat', 'overlayPosition'],
  check: [
    'embedMetadata', 'embedThumbnail', 'writeSubtitles', 'sponsorblock',
    'showOverlayButton', 'useCookies', 'notifyOnComplete',
  ],
};

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:8765',
  token: '',
  defaultMode: 'video',
  defaultQuality: 1080,
  container: 'mp4',
  audioFormat: 'mp3',
  subtitleFormat: 'srt',
  overlayPosition: 'bottom-right',
  cookieProfile: 'youtube',
  embedMetadata: true,
  embedThumbnail: false,
  writeSubtitles: false,
  sponsorblock: false,
  showOverlayButton: true,
  useCookies: false,
  notifyOnComplete: true,
};

const $ = (sel) => document.querySelector(sel);

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

async function loadIntoForm() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const settings = { ...DEFAULTS, ...stored };

  for (const id of FIELDS.text) {
    const el = document.getElementById(id);
    if (el) el.value = settings[id] ?? '';
  }
  for (const id of FIELDS.select) {
    const el = document.getElementById(id);
    if (el) el.value = String(settings[id]);
  }
  for (const id of FIELDS.check) {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(settings[id]);
  }

  // defaultQuality is stored as a number but compared as a string in the select.
  const q = document.getElementById('defaultQuality');
  q.value = String(settings.defaultQuality);
}

function collectForm() {
  const patch = {};
  for (const id of FIELDS.text) {
    const el = document.getElementById(id);
    if (el) patch[id] = el.value.trim();
  }
  for (const id of FIELDS.select) {
    const el = document.getElementById(id);
    if (el) patch[id] = el.value;
  }
  for (const id of FIELDS.check) {
    const el = document.getElementById(id);
    if (el) patch[id] = el.checked;
  }
  // Numeric fields need an explicit cast; the select yields a string.
  patch.defaultQuality = Number.parseInt(patch.defaultQuality, 10) || 1080;
  if (!patch.bridgeUrl) patch.bridgeUrl = DEFAULTS.bridgeUrl;
  // Normalise a trailing slash so path joins stay predictable.
  patch.bridgeUrl = patch.bridgeUrl.replace(/\/+$/, '');
  if (!patch.cookieProfile) patch.cookieProfile = 'youtube';
  return patch;
}

async function save() {
  const patch = collectForm();
  const res = await send('settings:set', { patch });
  const msg = $('#saveMsg');
  if (res.ok !== false) {
    msg.textContent = t('saved');
    msg.className = 'test-result ok';
  } else {
    msg.textContent = res.error || t('save_failed');
    msg.className = 'test-result err';
  }
  setTimeout(() => { msg.textContent = ''; }, 2600);
  return patch;
}

/** Persist first, then probe, so the test always reflects what is on screen. */
async function testConnection() {
  const btn = $('#btnTest');
  const out = $('#testResult');
  const detail = $('#healthDetail');

  btn.disabled = true;
  out.textContent = t('testing');
  out.className = 'test-result';
  detail.hidden = true;

  await save();
  const res = await send('bridge:health');
  btn.disabled = false;

  if (!res.ok) {
    out.textContent = `✗ ${t('cannot_reach')}`;
    out.className = 'test-result err';
    detail.hidden = false;
    detail.innerHTML = `
      <div class="health-row"><span>${escapeHtml(t('health_error'))}</span><span class="no">${escapeHtml(res.error || t('err_unknown'))}</span></div>
      <div class="health-row"><span>${escapeHtml(t('health_fix'))}</span><span>${escapeHtml(t('test_fix'))}</span></div>
    `;
    return;
  }

  const h = res.health;
  const bins = h.binaries || {};
  out.textContent = `✓ ${t('connected')}`;
  out.className = 'test-result ok';

  detail.hidden = false;
  detail.innerHTML = `
    <div class="health-row"><span>${escapeHtml(t('health_downloads'))}</span><span>${escapeHtml(h.downloadDir || '')}</span></div>
    <div class="health-row"><span>${escapeHtml(t('health_ytdlp'))}</span><span class="${bins.ytDlp?.ok ? 'yes' : 'no'}">${escapeHtml(bins.ytDlp?.ok ? bins.ytDlp.version : bins.ytDlp?.error || t('health_missing'))}</span></div>
    <div class="health-row"><span>${escapeHtml(t('health_ffmpeg'))}</span><span class="${bins.ffmpeg?.ok ? 'yes' : 'no'}">${escapeHtml(bins.ffmpeg?.ok ? t('health_available') : bins.ffmpeg?.error || t('health_missing'))}</span></div>
    <div class="health-row"><span>${escapeHtml(t('health_concurrency'))}</span><span>${h.concurrency}</span></div>
    <div class="health-row"><span>${escapeHtml(t('health_token'))}</span><span class="${h.token ? 'yes' : 'no'}">${escapeHtml(h.token ? t('health_configured') : t('health_none'))}</span></div>
  `;
}

async function pushCookies() {
  const btn = $('#btnPush');
  const msg = $('#cookieMsg');
  btn.disabled = true;
  btn.textContent = t('cookies_sending');

  await save(); // make sure the bridge URL is current before sending
  const res = await send('cookies:push');

  btn.disabled = false;
  btn.textContent = t('cookie_send_now');
  msg.hidden = false;

  if (res.ok) {
    msg.className = 'msg ok';
    msg.textContent = t('saved_cookies_hint', { n: res.count });
    $('#useCookies').checked = true;
    await save();
  } else {
    msg.className = 'msg err';
    msg.textContent = res.error || t('cookie_fail');
  }
}

async function clearCookies() {
  const msg = $('#cookieMsg');
  await save();
  await send('cookies:clear');
  $('#useCookies').checked = false;
  msg.hidden = false;
  msg.className = 'msg ok';
  msg.textContent = t('cookies_deleted');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- wiring ---------------------------------------------------------------

$('#btnSave').addEventListener('click', save);
$('#btnTest').addEventListener('click', testConnection);
$('#btnPush').addEventListener('click', pushCookies);
$('#btnClear').addEventListener('click', clearCookies);

// Language changes apply instantly, without a reload and without being part of
// the main Save flow — the user expects the page to switch as soon as they pick.
$('#language').addEventListener('change', async (e) => {
  await setLanguage(e.target.value);
  applyTo(document);
  // Re-render the parts built in JS rather than from data-i18n markers.
  const out = $('#testResult');
  if (out.textContent) testConnection();
  $('#saveMsg').textContent = '';
});

// Ctrl/Cmd+S saves without leaving the page.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

(async function init() {
  // Resolve the language before the first render so nothing flashes in the
  // wrong language, then reflect the stored preference in the switcher.
  await initLanguage();
  applyTo(document);

  const stored = await chrome.storage.sync.get({ language: 'auto' });
  $('#language').value = stored.language || 'auto';

  await loadIntoForm();
  if (new URLSearchParams(location.search).get('welcome') === '1') {
    $('#welcomeBanner').hidden = false;
  }
  // Surface connectivity straight away — this is the most common problem.
  testConnection();
})();
