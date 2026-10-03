/**
 * Site adapters.
 *
 * Everything site-specific lives here: how to recognise a page, how to pull a
 * stable id out of a URL, which cookies the bridge should use, and which
 * features actually apply.
 *
 * The rest of the extension asks this module instead of hard-coding YouTube, so
 * adding a site means adding one descriptor rather than editing five files.
 *
 * Adding a site:
 *   1. write a descriptor below
 *   2. add it to SITES and to the match list in manifest.json
 *      (content_scripts, host_permissions, web_accessible_resources)
 *   3. if it needs cookies, add the domains to `cookieDomains`
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a URL, returning null instead of throwing. */
function safeUrl(input, base) {
  try {
    return new URL(input, base);
  } catch {
    return null;
  }
}

/** Strip query and hash: they never identify the media itself. */
function cleanPath(u) {
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const youtube = {
  id: 'youtube',
  label: 'YouTube',
  /** Where the bridge should look for this site's session cookies. */
  cookieDomains: ['.youtube.com', '.google.com'],
  cookieProfile: 'youtube',
  features: {
    /** Real resolution tiers to choose from. */
    qualityLadder: true,
    /** Separate subtitle tracks. */
    subtitles: true,
    /** SponsorBlock segment removal. */
    sponsorblock: true,
    /** A dedicated audio-only stream exists. */
    audioOnly: true,
    /** A URL may expand into a playlist. */
    playlist: true,
    /** 1080p+ needs video+audio merged by ffmpeg. */
    merging: true,
  },

  test(u) {
    return /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname);
  },

  /** @returns {{id: string, canonical: string}|null} */
  parse(u) {
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return id ? { id, canonical: `https://www.youtube.com/watch?v=${id}` } : null;
    }
    const v = u.searchParams.get('v');
    if (v) return { id: v, canonical: `https://www.youtube.com/watch?v=${v}` };

    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
    if (m) return { id: m[2], canonical: `https://www.youtube.com/watch?v=${m[2]}` };

    return null;
  },

  /** Is this a page that can hold a single video? */
  isMediaPage(u) {
    if (u.hostname === 'youtu.be') return true;
    if (u.searchParams.get('v')) return true;
    return /^\/(watch|shorts|live|embed)/.test(u.pathname);
  },

  /**
   * YouTube needs no in-page check: a video page always has exactly one video.
   * The DOM probe is only used by sites where a page may or may not contain one.
   */
  hasMediaInPage() {
    return true;
  },
};

// ---------------------------------------------------------------------------
// X (Twitter)
// ---------------------------------------------------------------------------

const x = {
  id: 'x',
  label: 'X',
  cookieDomains: ['.x.com', '.twitter.com'],
  cookieProfile: 'x',
  features: {
    // X serves one progressive MP4, so there are no resolution tiers to pick
    // between and no separate audio stream. "Audio only" still works, because
    // the bridge extracts the track from the video with ffmpeg.
    qualityLadder: false,
    subtitles: false,
    sponsorblock: false,
    audioOnly: false,
    playlist: false,
    merging: false,
  },

  test(u) {
    return /(^|\.)(x\.com|twitter\.com)$/i.test(u.hostname);
  },

  parse(u) {
    // Shapes:  /<user>/status/<id>   /i/status/<id>   /<user>/status/<id>/video/1
    const m = u.pathname.match(/\/status(?:es)?\/(\d+)/);
    if (!m) return null;

    const id = m[1];
    // Normalise the host so the bridge sees one canonical form. Keep the rest
    // of the path: yt-dlp accepts /i/status/ and /<user>/status/ alike.
    return { id, canonical: `https://x.com${u.pathname.replace(/\/+$/, '')}` };
  },

  isMediaPage(u) {
    return /\/status(?:es)?\/\d+/.test(u.pathname);
  },

  /**
   * A status page often has no video at all (text or image posts), so the URL
   * alone cannot decide. X renders a <video> element only when there is one.
   */
  hasMediaInPage() {
    if (typeof document === 'undefined') return false;
    return Boolean(document.querySelector('video'));
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SITES = [youtube, x];

/** The neutral shape returned by detect(). */
function describe(site, u, parsed) {
  return {
    siteId: site.id,
    siteLabel: site.label,
    id: parsed.id,
    canonicalUrl: parsed.canonical,
    features: site.features,
    cookieDomains: site.cookieDomains,
    cookieProfile: site.cookieProfile,
  };
}

/**
 * A bare YouTube video id: 11 URL-safe characters, no whitespace.
 *
 * Being strict here matters — a loose rule would treat arbitrary text (or a
 * pasted sentence) as a video id and send it to the bridge.
 */
const BARE_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * Work out which site a URL belongs to and pull out its media id.
 *
 * @param {string} input  a full URL, or a bare YouTube video id
 * @param {string} [base] base for relative URLs
 * @returns {object|null} null when no adapter recognises it
 */
export function detect(input, base) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // A bare id (no scheme, no slash, no spaces) is assumed to be a YouTube video
  // id, which is what the Alt+D shortcut and the popup receive on a video page.
  const looksLikeBareId = BARE_ID_RE.test(raw) && !raw.includes('/');
  const u = safeUrl(looksLikeBareId ? `https://www.youtube.com/watch?v=${raw}` : raw, base);
  if (!u) return null;

  for (const site of SITES) {
    if (!site.test(u)) continue;
    const parsed = site.parse(u);
    if (!parsed) return null; // right site, but not a media URL
    return describe(site, u, parsed);
  }
  return null;
}

/** Convenience: the canonical URL for an input, or the input unchanged. */
export function canonicalize(input, base) {
  return detect(input, base)?.canonicalUrl ?? String(input ?? '');
}

/** Which adapter serves this URL, even if it is not a media URL. */
export function siteFor(input, base) {
  const u = safeUrl(input, base);
  if (!u) return null;
  return SITES.find((s) => s.test(u)) || null;
}

/** Cookie domains for whatever site the URL belongs to. */
export function cookieDomainsFor(input, base) {
  return siteFor(input, base)?.cookieDomains ?? [];
}

/** Whether a URL points at a single-video page on a supported site. */
export function isMediaPage(input, base) {
  const u = safeUrl(input, base);
  if (!u) return false;
  const site = SITES.find((s) => s.test(u));
  return Boolean(site && site.isMediaPage(u));
}

/**
 * True when the page is worth showing the download button on.
 *
 * Adds the adapter's own in-page check, which matters for sites like X where a
 * status page may or may not contain a video.
 */
export function hasDownloadableMedia(input, base) {
  const u = safeUrl(input, base);
  if (!u) return false;
  const site = SITES.find((s) => s.test(u));
  if (!site || !site.isMediaPage(u)) return false;
  if (!detect(input, base)) return false;
  return site.hasMediaInPage();
}

/** True when the site can supply separate subtitle tracks. */
export function supportsSubtitles(input, base) {
  return Boolean(siteFor(input, base)?.features.subtitles);
}

/** True when the site supports SponsorBlock removal. */
export function supportsSponsorblock(input, base) {
  return Boolean(siteFor(input, base)?.features.sponsorblock);
}

/** Manifest match patterns for every adapter, for keep-in-sync checks. */
export const SITE_HOSTS = [
  'https://www.youtube.com/*',
  'https://m.youtube.com/*',
  'https://music.youtube.com/*',
  'https://x.com/*',
  'https://twitter.com/*',
];
