/**
 * Background service worker.
 *
 * Responsibilities:
 *  - talk to the local yt-dlp bridge (HTTP + SSE)
 *  - keep a live copy of the queue so the popup renders instantly
 *  - harvest YouTube cookies on demand for age/region/login gated videos
 *  - relay messages between content scripts and the popup
 *
 * MV3 service workers are evicted when idle, so no long-lived state lives only
 * in memory: the queue is mirrored into chrome.storage.session, and the SSE
 * stream is re-established lazily whenever the worker wakes up.
 */

import { t, initLanguage } from './i18n.js';
import { detect as detectSite, SITES } from './sites.js';

const DEFAULT_SETTINGS = {
  bridgeUrl: 'http://127.0.0.1:8765',
  token: '',
  /** Cached copy of the token, used to build an authenticated ytdl:// launch. */
  launchToken: '',
  defaultQuality: 1080,
  defaultMode: 'video',
  audioFormat: 'mp3',
  container: 'mp4',
  showOverlayButton: true,
  overlayPosition: 'bottom-right',
  useCookies: false,
  cookieProfile: 'youtube',
  embedMetadata: true,
  embedThumbnail: false,
  writeSubtitles: false,
  subtitleFormat: 'srt',
  sponsorblock: false,
  notifyOnComplete: true,
  autoDownloadWatched: false,
  concurrency: 2,
};

let settings = { ...DEFAULT_SETTINGS };
let queueState = { jobs: [], stats: {} };
let eventSource = null;
let reconnectTimer = null;
let bridgeOnline = false;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings = { ...DEFAULT_SETTINGS, ...stored };
  return settings;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);
  broadcast({ type: 'settings:changed', settings });
  return settings;
}

// ---------------------------------------------------------------------------
// Bridge client
// ---------------------------------------------------------------------------

/**
 * Resolve the shared secret. If the user has not set one we ask /health.
 *
 * The same value doubles as the ytdl:// launch token, so we cache it under
 * `launchToken` as well. That copy is what lets the "Start bridge" button work
 * on a later run when the bridge is down and cannot be asked.
 */
async function ensureToken(force = false) {
  if (settings.token && !force) return settings.token;
  try {
    const res = await fetch(`${settings.bridgeUrl}/health`, { cache: 'no-store' });
    if (!res.ok) return settings.token;
    const body = await res.json();
    if (body?.token) {
      settings.token = body.token;
      await chrome.storage.sync.set({ token: body.token, launchToken: body.token });
    }
    return settings.token;
  } catch {
    return settings.token;
  }
}

/** Call the bridge with authentication and friendly error mapping. */
async function bridgeFetch(path, options = {}, retry = true) {
  const token = await ensureToken();
  const url = path.startsWith('http') ? path : `${settings.bridgeUrl}${path}`;

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-YTD-Token': token } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    bridgeOnline = false;
    broadcast({ type: 'bridge:status', online: false });
    throw new Error(t('bg_bridge_unreachable', { url: settings.bridgeUrl }));
  }

  // A stale token after a bridge reinstall is recoverable: refresh and retry once.
  if (res.status === 401 && retry) {
    await ensureToken(true);
    return bridgeFetch(path, options, false);
  }

  bridgeOnline = true;
  broadcast({ type: 'bridge:status', online: true });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  // Cache the token for the ytdl:// launcher while the bridge is reachable.
  if (body?.token && body.token !== settings.launchToken) {
    settings.launchToken = body.token;
    chrome.storage.sync.set({ launchToken: body.token }).catch(() => {});
  }

  if (!res.ok) {
    throw new Error(body?.error || `Bridge returned HTTP ${res.status}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Live queue via SSE
// ---------------------------------------------------------------------------

function connectEvents() {
  if (eventSource || !settings.bridgeUrl) return;

  const token = settings.token || '';
  const url = `${settings.bridgeUrl}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  try {
    eventSource = new EventSource(url);
  } catch {
    scheduleReconnect();
    return;
  }

  eventSource.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    queueState = { jobs: data.jobs || [], stats: data.stats || {} };
    bridgeOnline = true;
    broadcast({ type: 'queue:snapshot', ...queueState });
    broadcast({ type: 'bridge:status', online: true });
  });

  // Every job event carries the full job plus fresh stats from the bridge, so
  // the local mirror (and therefore the popup counters) stays current.
  for (const name of ['job:created', 'job:started', 'job:progress', 'job:done', 'job:failed', 'job:cancelled', 'job:removed']) {
    eventSource.addEventListener(name, (e) => {
      const { job, stats } = JSON.parse(e.data);
      if (stats) queueState.stats = stats;
      upsertJob(job);
      broadcast({ type: name, job, stats: queueState.stats });

      if (name === 'job:done' && settings.notifyOnComplete) {
        notifyDone(job);
      }
    });
  }

  eventSource.onerror = () => {
    bridgeOnline = false;
    broadcast({ type: 'bridge:status', online: false });
    closeEvents();
    scheduleReconnect();
  };
}

function closeEvents() {
  if (eventSource) {
    try {
      eventSource.close();
    } catch {
      /* already closed */
    }
    eventSource = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectEvents();
  }, 5000);
}

function upsertJob(job) {
  if (!job) return;
  const idx = queueState.jobs.findIndex((j) => j.id === job.id);
  if (idx === -1) {
    queueState.jobs.unshift(job);
  } else {
    queueState.jobs[idx] = job;
  }
  queueState.jobs = queueState.jobs.slice(0, 200);
  chrome.storage.session.set({ queueState }).catch(() => {});
}

/**
 * Refresh the whole queue from the bridge.
 *
 * This merges by id instead of replacing the array outright. A plain replace
 * can transiently resurrect a row the user just deleted: the in-flight
 * request was issued before the delete landed, so its response still contains
 * the removed job, and the popup re-renders it for a frame.
 */
async function refreshStats() {
  try {
    const data = await bridgeFetch('/jobs');
    const incoming = data.jobs || [];

    if (queueState.jobs?.length) {
      const incomingIds = new Set(incoming.map((j) => j.id));
      // Keep any locally known job the response has not caught up with yet.
      const missing = queueState.jobs.filter((j) => !incomingIds.has(j.id));
      queueState.jobs = [...incoming, ...missing];
    } else {
      queueState.jobs = incoming;
    }

    queueState.jobs = queueState.jobs
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 200);
    queueState.stats = data.stats || queueState.stats || {};

    chrome.storage.session.set({ queueState }).catch(() => {});
    broadcast({ type: 'queue:snapshot', ...queueState });
  } catch {
    /* the SSE stream will catch up on its own */
  }
}

function notifyDone(job) {
  const label = job.mode === 'audio'
    ? t('bg_saved_audio')
    : job.qualityLabel
      ? t('bg_saved_video', { quality: job.qualityLabel })
      : t('bg_saved_generic');
  chrome.notifications.create(`ytd-${job.id}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: label,
    message: job.title || t('bg_saved_generic'),
    silent: false,
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Copy the user's session cookies into Netscape cookie files the bridge can feed
 * to yt-dlp. This is what makes age-restricted, private, members-only and
 * login-required media work — including most X videos.
 *
 * Every supported site's cookies are collected at once, each into its own
 * profile, so the user does not have to remember which site needs signing in.
 *
 * @param {string} [only] restrict to one site id (e.g. 'x')
 */
async function pushCookies(only) {
  const targets = SITES.filter((s) => !only || s.id === only);

  if (!targets.length) throw new Error(`Unknown site: ${only}`);

  const results = [];

  for (const site of targets) {
    const collected = [];

    for (const domain of site.cookieDomains) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const c of cookies) {
          // Skip cookies that are already expired.
          if (c.expirationDate && c.expirationDate * 1000 < Date.now()) continue;
          collected.push({
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
            name: c.name,
            value: c.value,
          });
        }
      } catch {
        /* the domain simply has no cookies */
      }
    }

    if (!collected.length) continue; // not signed in there; that is fine

    const result = await bridgeFetch('/cookies', {
      method: 'POST',
      body: JSON.stringify({ domain: site.cookieProfile, cookies: collected }),
    });

    results.push({
      site: site.id,
      label: site.label,
      profile: result.profile ?? site.cookieProfile,
      count: result.count ?? collected.length,
    });
  }

  if (!results.length) throw new Error(t('bg_no_cookies'));

  return {
    // Keep `count`/`profile` for the existing single-site UI copy.
    count: results.reduce((n, r) => n + r.count, 0),
    profile: results[0].profile,
    results,
  };
}

/** Quick check that the harvested cookies actually produce a signed-in session. */
async function verifyCookies() {
  const profiles = await bridgeFetch('/cookies');
  return profiles.profiles || [];
}

// ---------------------------------------------------------------------------
// Site helpers (delegated to sites.js so this file stays site-agnostic)
// ---------------------------------------------------------------------------

/** Extract the media id from a supported site URL, or null. */
function extractVideoId(url) {
  return detectSite(url)?.id ?? null;
}

/** Normalise to the adapter's canonical URL for the site. */
function normaliseMediaUrl(url) {
  return detectSite(url)?.canonicalUrl ?? url;
}

/** Ask the bridge for metadata and the quality ladder. */
async function probe(videoId, url) {
  // Prefer the full URL: it is unambiguous across sites. Only fall back to the
  // id when we have nothing else (e.g. the Alt+D shortcut on a known page).
  const query = url
    ? `url=${encodeURIComponent(url)}`
    : `videoId=${encodeURIComponent(videoId)}`;
  const params = settings.useCookies ? `&cookieProfile=${encodeURIComponent(settings.cookieProfile)}` : '';
  const info = await bridgeFetch(`/probe?${query}${params}`);
  return info;
}

/** Build the download spec from user settings plus an explicit quality pick. */
function buildSpec(info, pick = {}) {
  const mode = pick.mode || settings.defaultMode;

  // Features are per-site: SponsorBlock only exists for YouTube, and asking for
  // it elsewhere makes yt-dlp warn or fail.
  const sourceUrl = info.webpageUrl || pick.url || '';
  const site = detectSite(sourceUrl);

  const spec = {
    videoId: info.videoId,
    url: info.webpageUrl,
    title: info.title,
    thumbnail: info.thumbnail,
    duration: info.duration,
    mode,
    // Use the site's own cookie profile, not one global setting.
    cookieProfile: settings.useCookies ? (site?.cookieProfile ?? settings.cookieProfile) : null,
    embedMetadata: settings.embedMetadata,
    embedThumbnail: settings.embedThumbnail,
    sponsorblock: Boolean(settings.sponsorblock && site?.features.sponsorblock),
    container: settings.container,
  };

  if (mode === 'audio') {
    spec.audioFormat = pick.audioFormat || settings.audioFormat;
    spec.audioSelector = pick.audioSelector || info.formats?.audioOnly?.[0]?.selector || null;
    spec.qualityLabel = `Audio ${String(spec.audioFormat).toUpperCase()}`;
  } else if (mode === 'thumbnail') {
    spec.qualityLabel = 'Thumbnail';
  } else {
    const ladder = info.formats?.ladder ?? [];
    const height = pick.height || settings.defaultQuality;
    // Sites without a resolution ladder (X) expose a single "best" entry, so
    // fall back to it rather than trying to match a height that is not there.
    const entry = ladder.find((f) => f.height === height)
      || ladder.find((f) => f.height <= height)
      || ladder[0];

    spec.height = entry?.height ?? null;
    spec.selector = pick.selector || entry?.selector || null;
    // A generic entry has no measured height; label it by the site instead of
    // showing a misleading "0p".
    spec.qualityLabel = entry?.generic
      ? (site?.siteLabel ?? 'best')
      : `${entry?.height ?? height}p`;
  }

  // An explicit false from the picker wins over the saved default, so unchecking
  // 「保存字幕」 actually skips the subtitle download.
  const wantSubtitles = mode === 'video' && site?.features.subtitles && (
    pick.subtitles === true || (pick.subtitles !== false && settings.writeSubtitles)
  );
  if (wantSubtitles) {
    spec.subtitles = {
      enabled: true,
      format: settings.subtitleFormat || 'srt',
      langs: pick.subtitleLangs || ['en'],
      auto: pick.subtitleAuto !== false,
      embed: Boolean(pick.embedSubs),
    };
  }

  return spec;
}

/** Probe then enqueue — the single entry point used by every UI surface. */
async function startDownload({ videoId, url, pick = {} }) {
  // Resolve to a canonical URL for the detected site.
  const canonical = url ? normaliseMediaUrl(url) : videoId;
  if (!canonical) throw new Error(t('bg_no_video'));

  const info = await probe(canonical, canonical);
  if (info.isLive) {
    throw new Error(t('bg_live_stream'));
  }

  const spec = buildSpec(info, { ...pick, url: canonical });
  const result = await bridgeFetch('/download', {
    method: 'POST',
    body: JSON.stringify(spec),
  });

  return { job: result.job, info };
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function broadcast(message) {
  // Popups and content scripts may not exist; ignore the resulting errors.
  chrome.runtime.sendMessage(message).catch(() => {});
}

const handlers = {
  async 'settings:get'() {
    return { settings };
  },

  async 'settings:set'({ patch }) {
    const next = await saveSettings(patch);
    if (patch.bridgeUrl || patch.token) {
      // The endpoints changed, so the existing stream points at the old
      // address. Tear it down and reconnect immediately — leaving it closed
      // would silently stop all live updates until the worker restarts.
      closeEvents();
      connectEvents();
      await refreshStats().catch(() => {});
    }
    return { settings: next };
  },

  async 'bridge:health'() {
    try {
      const health = await bridgeFetch('/health');
      bridgeOnline = true;
      return { ok: true, health };
    } catch (err) {
      bridgeOnline = false;
      return { ok: false, error: err.message };
    }
  },

  async 'queue:get'() {
    try {
      const data = await bridgeFetch('/jobs');
      queueState = { jobs: data.jobs || [], stats: data.stats || {} };
      connectEvents();
      return { ok: true, ...queueState };
    } catch (err) {
      return { ok: false, error: err.message, ...queueState };
    }
  },

  async 'video:probe'({ videoId, url }) {
    const info = await probe(videoId, url);
    return { ok: true, info };
  },

  async 'video:download'({ videoId, url, pick }) {
    const result = await startDownload({ videoId, url, pick });
    connectEvents();
    return { ok: true, ...result };
  },

  async 'job:cancel'({ id }) {
    await bridgeFetch(`/jobs/${id}/cancel`, { method: 'POST' });
    return { ok: true };
  },

  async 'job:retry'({ id }) {
    await bridgeFetch(`/jobs/${id}/retry`, { method: 'POST' });
    return { ok: true };
  },

  async 'job:remove'({ id, deleteFile }) {
    await bridgeFetch(`/jobs/${id}${deleteFile ? '?deleteFile=1' : ''}`, { method: 'DELETE' });
    return { ok: true };
  },

  async 'job:clear'({ deleteFiles }) {
    await bridgeFetch(`/jobs/clear${deleteFiles ? '?deleteFiles=1' : ''}`, { method: 'POST' });
    return { ok: true };
  },

  async 'file:save'({ id }) {
    // Ask the bridge for the authoritative job record rather than trusting the
    // local mirror, which may be empty if no snapshot has arrived yet. Falling
    // back to a placeholder name would silently save the right bytes under the
    // wrong filename.
    const { job } = await bridgeFetch(`/jobs/${encodeURIComponent(id)}`);
    if (!job?.fileName) {
      throw new Error(t('bg_no_file'));
    }

    // Resolve the token through ensureToken so it is populated (and refreshed)
    // the same way bridgeFetch does it. Building the URL with a blank token
    // would take the /file route outside the 401-retry path and fail silently.
    const token = await ensureToken();
    const url = new URL(`${settings.bridgeUrl}/file`);
    url.searchParams.set('jobId', id);
    if (token) url.searchParams.set('token', token);

    // chrome.downloads streams the file through the bridge, giving the user a
    // real browser download with a proper name instead of a raw link.
    const downloadId = await chrome.downloads.download({
      url: url.toString(),
      filename: job.fileName,
      saveAs: false,
    });
    return { ok: true, downloadId };
  },

  async 'file:openFolder'({ id }) {
    // Pass the bridge's answer through: it reports when it could not reveal the
    // specific file (moved or deleted) and opened the parent folder instead, so
    // the UI can say so rather than appearing to do nothing.
    const result = await bridgeFetch('/open-folder', {
      method: 'POST',
      body: JSON.stringify({ jobId: id }),
    });
    return { ok: true, target: result?.target, fellBack: Boolean(result?.fellBack) };
  },

  async 'cookies:push'() {
    const result = await pushCookies();
    await saveSettings({ useCookies: true });
    return { ok: true, ...result };
  },

  async 'cookies:list'() {
    return { ok: true, profiles: await verifyCookies() };
  },

  async 'cookies:clear'() {
    await bridgeFetch(`/cookies?profile=${encodeURIComponent(settings.cookieProfile)}`, { method: 'DELETE' });
    await saveSettings({ useCookies: false });
    return { ok: true };
  },

  async 'content:register'({ url }) {
    // Content script announcing itself. We report the detected site so the
    // overlay can adapt its UI (X has no quality ladder or subtitles, for
    // example) without duplicating the site table.
    const match = detectSite(url);
    return {
      ok: true,
      videoId: match?.id ?? null,
      siteId: match?.siteId ?? null,
      siteLabel: match?.siteLabel ?? null,
      features: match?.features ?? null,
      settings,
    };
  },

  /**
   * Start the bridge from the browser.
   *
   * A Chrome extension cannot spawn a local process, so we ask a helper to do
   * it. There are two routes, tried in this order:
   *
   *   1. The launcher service on 127.0.0.1:8766. Pure HTTP, so nothing is
   *      executed by the shell and no window can appear.
   *   2. The ytdl:// protocol. Windows runs the registered handler, which is a
   *      .vbs precisely so it does not create a console. Kept as a fallback for
   *      when the launcher is not running.
   *
   * Route 1 is preferred for more than convenience: it needs no shared secret,
   * so it works on a completely fresh install — which is exactly when the
   * button is needed.
   */
  async 'bridge:launch'() {
    // Preferred route: the launcher service listens on loopback and starts the
    // bridge on request. It needs no shared secret, so this works from a fresh
    // install — which is exactly when the button is needed.
    const viaLauncher = await launchViaLauncher();
    if (viaLauncher.ok) return viaLauncher;
    if (viaLauncher.definitive) return viaLauncher;

    // Fallback: the ytdl:// protocol handler, for setups where the launcher is
    // not running. This one does require a token, so it can legitimately fail
    // on a fresh install; the error text says what to do about it.
    return launchViaProtocol();
  },

  async 'bridge:await'({ timeoutMs = 25000 } = {}) {
    // Poll until the bridge answers, so the popup can report real success
    // instead of claiming it started something that never came up.
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 3000), 60000);
    while (Date.now() < deadline) {
      try {
        const health = await bridgeFetch('/health');
        bridgeOnline = true;
        connectEvents();
        return { ok: true, health };
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return { ok: false, error: t('launch_timeout') };
  },
};

/** Windows is the only platform the launcher protocol is registered on. */
function isWindows() {
  // navigator.userAgentData is not available in a service worker context, so
  // fall back to the user agent string.
  const ua = self.navigator?.userAgent || '';
  return /Windows/i.test(ua);
}

/** Where the launcher service listens. Mirrors launcher/launcher.js. */
const LAUNCHER_URL = 'http://127.0.0.1:8766';

/**
 * Ask the launcher service to start the bridge.
 *
 * @returns {Promise<{ok: boolean, definitive?: boolean, error?: string}>}
 *   `definitive` means the launcher answered but could not start the bridge,
 *   so there is no point trying the protocol fallback.
 */
async function launchViaLauncher() {
  let ping;
  try {
    const res = await fetch(`${LAUNCHER_URL}/ping`, { cache: 'no-store' });
    if (!res.ok) return { ok: false };
    ping = await res.json();
  } catch {
    // Not installed or not running — caller should try the fallback.
    return { ok: false };
  }

  if (ping.bridgeUp) {
    bridgeOnline = true;
    connectEvents();
    return { ok: true, alreadyRunning: true };
  }

  try {
    const res = await fetch(`${LAUNCHER_URL}/start`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      return { ok: false, definitive: true, error: body.error || t('launch_failed') };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, definitive: true, error: String(err?.message || err) };
  }
}

/**
 * Fallback: open a ytdl:// URL so the registered handler starts the bridge.
 * Requires a token, so it cannot work on a completely fresh install.
 */
async function launchViaProtocol() {
  if (!isWindows()) {
    return { ok: false, error: t('launch_unsupported') };
  }

  let token = settings.launchToken || settings.token || '';
  if (!token) {
    token = await ensureToken(true);
    if (token) {
      settings.launchToken = token;
      await chrome.storage.sync.set({ launchToken: token });
    }
  }

  if (!token) {
    return { ok: false, error: t('launch_no_token') };
  }

  try {
    await chrome.tabs.create({ url: `ytdl://start/${encodeURIComponent(token)}`, active: false });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  return { ok: true, token };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  await initLanguage();
  await loadSettings();
  connectEvents();

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await initLanguage();
  await loadSettings();
  connectEvents();
});

// Clicking the toolbar icon with no popup focus still refreshes state.
chrome.action.onClicked.addListener(() => {
  refreshStats().catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'download-current') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = extractVideoId(tab?.url);
  if (!videoId) return;
  try {
    await startDownload({ videoId, url: tab.url });
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: t('bg_notification_queued'),
      message: t('bg_notification_queued_body'),
    });
  } catch (err) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: t('bg_notification_failed'),
      message: String(err.message || err).slice(0, 200),
    });
  }
});

// Wake the SSE stream when the worker spins back up.
//
// The cached snapshot is restored BEFORE connecting, so a fresh SSE snapshot
// always wins. Reversing these two would let a late-arriving cache read
// clobber newer data and make the popup briefly show stale jobs.
(async () => {
  await initLanguage();
  await loadSettings();
  try {
    const { queueState: cached } = await chrome.storage.session.get('queueState');
    if (cached?.jobs) queueState = cached;
  } catch {
    /* session storage may be unavailable; an empty mirror is fine */
  }
  connectEvents();
})();
