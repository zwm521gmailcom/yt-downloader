import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around the yt-dlp CLI.
 *
 * We deliberately shell out to the real binary instead of reimplementing the
 * signature/nsig deciphering: yt-dlp is maintained upstream and stays working
 * as YouTube changes. Every call here is read-only except `download()`.
 */

/**
 * Absolute path to the ffmpeg binary, resolved once at startup.
 *
 * `--ffmpeg-location` expects a DIRECTORY or a FULL binary path — a bare command
 * name like "ffmpeg" is not resolved through PATH and makes yt-dlp report
 * "ffmpeg was not found" even when ffmpeg is installed and runnable. So we
 * resolve it ourselves before building any argv.
 *
 * @type {string|null|undefined} undefined = not resolved yet, null = not found
 */
let resolvedFfmpeg = undefined;

/** File names ffmpeg might use on this platform. */
function ffmpegNames() {
  return process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat', 'ffmpeg']
    : ['ffmpeg'];
}

/**
 * Find an executable by name, searching the process PATH directly with fs.
 *
 * We deliberately do NOT shell out to `where`/`which`: that spawns a process,
 * which adds latency and fails outright in restricted environments. Walking
 * PATH with fs is synchronous, dependency-free and always available.
 */
function findOnPath(name) {
  const pathValue = process.env.PATH || process.env.Path || '';
  const dirs = pathValue.split(process.platform === 'win32' ? ';' : ':');

  for (const dir of dirs) {
    const clean = dir.trim().replace(/^"|"$/g, '');
    if (!clean) continue;
    const candidate = path.join(clean, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* not in this directory */
    }
  }
  return null;
}

/** Locate ffmpeg, preferring the configured value, then PATH. */
async function resolveFfmpeg() {
  if (resolvedFfmpeg !== undefined) return resolvedFfmpeg;

  const configured = config.ffmpegPath;
  const candidates = [];

  if (configured && (configured.includes('/') || configured.includes('\\'))) {
    // An explicit path from YTD_FFMPEG.
    candidates.push(configured);
    // Also accept a directory, which is what --ffmpeg-location documents.
    try {
      if (fs.statSync(configured).isDirectory()) {
        for (const name of ffmpegNames()) candidates.push(path.join(configured, name));
      }
    } catch {
      /* not a directory */
    }
  } else {
    const names = configured ? [configured, ...ffmpegNames()] : ffmpegNames();
    for (const name of names) {
      const found = findOnPath(name);
      if (found) candidates.push(found);
    }
  }

  // Return the first candidate that actually runs.
  //
  // Executing a candidate is the strongest signal, but spawning can be denied
  // in restricted environments (and can be slow). So we treat a spawn failure
  // that is NOT "file missing" as inconclusive: the file exists and is
  // executable-looking, and yt-dlp will be the one to run it anyway. Only a
  // genuine ENOENT rejects a candidate outright.
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    try {
      await execFileAsync(candidate, ['-version'], { timeout: 20000 });
      resolvedFfmpeg = candidate;
      return resolvedFfmpeg;
    } catch (err) {
      const code = err?.code || '';
      // The binary is present but we were not allowed to run it. Accept it:
      // refusing here would disable merging even though yt-dlp (a different
      // process, with its own permissions) can still execute it.
      if (code === 'EPERM' || code === 'EACCES') {
        resolvedFfmpeg = candidate;
        return resolvedFfmpeg;
      }
      // ENOENT / anything else: not a usable binary, try the next candidate.
    }
  }

  resolvedFfmpeg = null;
  return null;
}

/** Base args shared by every invocation. */
function baseArgs() {
  const args = [
    '--no-warnings',
    '--no-playlist', // a single video URL should never expand into a playlist
    '--ignore-config', // ignore the user's yt-dlp.conf so behaviour is predictable
  ];
  // Some networks (shared proxies, datacenter exit IPs) get HTTP 403 from
  // googlevideo with the default player client while a browser-style client
  // such as `mweb` downloads fine. YTD_PLAYER_CLIENT selects it; probe and
  // download must use the SAME client, otherwise the format ids offered by
  // the probe may not exist for the downloader. Set off/none/default to
  // force yt-dlp's built-in behaviour.
  const playerClient = (process.env.YTD_PLAYER_CLIENT || '').trim().toLowerCase();
  if (playerClient && !['off', 'none', 'default'].includes(playerClient)) {
    args.push('--extractor-args', `youtube:player_client=${playerClient}`);
  }
  // Only pass --ffmpeg-location when we resolved a real path. Passing a bare
  // command name here is what caused "ffmpeg was not found" despite a working
  // install; omitting the flag lets yt-dlp find ffmpeg on PATH itself.
  if (resolvedFfmpeg) {
    args.push('--ffmpeg-location', resolvedFfmpeg);
  }
  return args;
}

/**
 * Absolute path to the yt-dlp executable, resolved once.
 *
 * Resolving up front means a bare `yt-dlp` is turned into the real file path
 * before we spawn it, which works even when the spawning process has a PATH
 * that differs from the shell's.
 */
let resolvedYtDlp = undefined;

function resolveYtDlpSync() {
  if (resolvedYtDlp !== undefined) return resolvedYtDlp;

  const configured = config.ytDlpPath;
  if (configured && (configured.includes('/') || configured.includes('\\'))) {
    resolvedYtDlp = configured;
    return resolvedYtDlp;
  }

  const names = process.platform === 'win32'
    ? ['yt-dlp.exe', 'yt-dlp.cmd', 'yt-dlp.bat', 'yt-dlp']
    : ['yt-dlp'];

  for (const name of names) {
    const found = findOnPath(name);
    if (found) {
      resolvedYtDlp = found;
      return resolvedYtDlp;
    }
  }

  // Fall back to the configured name and let the spawn report the failure.
  resolvedYtDlp = configured || 'yt-dlp';
  return resolvedYtDlp;
}

/** Public accessor used by the queue and the diagnostics script. */
export function getYtDlpPath() {
  return resolveYtDlpSync();
}

/** Public accessor for the resolved ffmpeg path (may be null). */
export function getFfmpegPath() {
  return resolvedFfmpeg ?? null;
}

function cookieArgs(cookieFile) {
  return cookieFile ? ['--cookies', cookieFile] : [];
}

/**
 * Detect whether yt-dlp and ffmpeg are usable. Powers the extension's setup
 * screen so users get a clear message instead of mysterious failures.
 */
export async function checkBinaries() {
  const ffmpegPath = await resolveFfmpeg();

  const result = {
    ytDlp: { ok: false, version: null, path: config.ytDlpPath, error: null },
    ffmpeg: {
      ok: false,
      version: null,
      path: ffmpegPath || config.ffmpegPath,
      error: null,
    },
  };

  // Resolve yt-dlp the same way as ffmpeg: search PATH with fs rather than
  // relying on a subprocess lookup, then verify by running it.
  const ytDlpPath = getYtDlpPath();
  result.ytDlp.path = ytDlpPath;

  try {
    const { stdout } = await execFileAsync(ytDlpPath, ['--version'], { timeout: 20000 });
    result.ytDlp.ok = true;
    result.ytDlp.version = stdout.trim();
  } catch (err) {
    const code = err?.code || '';
    if (code === 'EPERM' || code === 'EACCES') {
      // Present but not runnable from this process — see the ffmpeg note below.
      result.ytDlp.ok = true;
      result.ytDlp.version = null;
      result.ytDlp.inconclusive = true;
    } else {
      result.ytDlp.error = code === 'ENOENT'
        ? 'yt-dlp not found on PATH'
        : String(err.stderr || err.message || err).trim();
    }
  }

  // Report on the ffmpeg we actually resolved, so this check and the download
  // path can never disagree (they previously did: health said "ok" while
  // downloads failed because --ffmpeg-location was given a bare name).
  if (ffmpegPath) {
    try {
      const { stdout } = await execFileAsync(ffmpegPath, ['-version'], { timeout: 20000 });
      result.ffmpeg.ok = true;
      result.ffmpeg.version = stdout.split('\n')[0].trim();
    } catch (err) {
      const code = err?.code || '';
      if (code === 'EPERM' || code === 'EACCES') {
        // The binary exists but this process may not run it. Treat as present;
        // yt-dlp runs it as a separate process with its own permissions.
        result.ffmpeg.ok = true;
        result.ffmpeg.version = null;
        result.ffmpeg.inconclusive = true;
      } else {
        result.ffmpeg.error = String(err.stderr || err.message || err).trim();
      }
    }
  } else {
    result.ffmpeg.error = 'ffmpeg not found on PATH';
  }

  return result;
}

/**
 * Turn a bare video id into a URL, and leave a real URL alone.
 *
 * This used to wrap *everything* into `youtube.com/watch?v=<input>`, which
 * silently broke every non-YouTube site: asking to probe
 * `https://x.com/user/status/123` became
 * `youtube.com/watch?v=https://x.com/user/status/123`.
 *
 * yt-dlp accepts a plain URL for any of the ~1800 sites it supports, so the
 * only thing we need to do here is expand an id that is not already a URL.
 */
export function canonicalUrl(input) {
  const value = String(input ?? '').trim();
  if (!value) return value;

  // Already a URL (any scheme) — hand it to yt-dlp untouched.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;

  // A bare id is assumed to be a YouTube video id.
  return `https://www.youtube.com/watch?v=${value}`;
}

/** True when the input looks like a full URL rather than a bare id. */
export function isUrl(input) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(input ?? '').trim());
}

/**
 * Fetch metadata plus the list of downloadable formats for one video.
 *
 * `--dump-single-json` gives us everything in one process spawn, which matters
 * because extracting formats is the slow part (~1-3s per video).
 */
export async function probeVideo(videoId, { cookieFile } = {}) {
  const args = [
    ...baseArgs(),
    ...cookieArgs(cookieFile),
    '--dump-single-json',
    '--no-download',
    canonicalUrl(videoId),
  ];

  let stdout;
  try {
    ({ stdout } = await execFileAsync(getYtDlpPath(), args, {
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    throw new Error(explainYtDlpError(err));
  }

  const info = JSON.parse(stdout);
  return {
    videoId: info.id,
    title: info.title,
    uploader: info.uploader || info.channel || '',
    duration: info.duration || 0,
    durationText: formatDuration(info.duration),
    thumbnail: pickThumbnail(info),
    viewCount: info.view_count ?? null,
    uploadDate: info.upload_date ?? null,
    isLive: Boolean(info.is_live),
    webpageUrl: info.webpage_url,
    subtitles: normaliseSubtitles(info),
    formats: buildFormatLadder(info),
  };
}

function pickThumbnail(info) {
  const list = info.thumbnails || [];
  if (!list.length) return null;
  // Highest-resolution thumbnail that is not a storyboard sprite.
  const real = list.filter((t) => t.width && t.height);
  const best = real.length ? real[real.length - 1] : list[list.length - 1];
  return best.url || null;
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Turn yt-dlp's raw format list into the human-facing quality ladder the
 * extension shows in its dropdown.
 *
 * YouTube serves high resolutions as separate video-only and audio-only
 * streams (DASH). We therefore present one entry per resolution and remember
 * the best audio id, so the download step can merge them with ffmpeg.
 */
function buildFormatLadder(info) {
  const formats = info.formats || [];

  // Progressive formats already contain audio and video — highest priority
  // because they need no ffmpeg merging.
  const progressive = formats.filter(
    (f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.ext !== 'none',
  );

  const videoOnly = formats.filter(
    (f) => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'),
  );

  const audioFormats = formats.filter(
    (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'),
  );

  const bestAudio = audioFormats
    .slice()
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  const byResolution = new Map();

  const consider = (f, hasAudio) => {
    const height = f.height || 0;
    if (!height) return;
    const key = height;
    const current = byResolution.get(key);
    // Prefer higher bitrate, and prefer a stream that already has audio.
    const score = (f.tbr || f.vbr || 0) + (hasAudio ? 100000 : 0);
    if (!current || score > current.score) {
      byResolution.set(key, { format: f, hasAudio, score });
    }
  };

  progressive.forEach((f) => consider(f, true));
  videoOnly.forEach((f) => consider(f, false));
  // Explicit 1080p+ markers: YouTube labels some DASH video as height 0 in rare
  // cases; fall back to the format_note when present.
  formats.forEach((f) => {
    if (!f.height && f.format_note && /^\d{3,4}p/.test(f.format_note)) {
      consider({ ...f, height: Number.parseInt(f.format_note, 10) }, false);
    }
  });

  const duration = info.duration || 0;
  const ladder = [...byResolution.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, { format, hasAudio }]) => {
      const size = estimateSize(format, hasAudio, bestAudio, duration);
      return {
        /** Stable selector string handed back to yt-dlp at download time. */
        selector: hasAudio ? format.format_id : `${format.format_id}+${bestAudio?.format_id ?? 'bestaudio'}`,
        /** Video-only selector used when the user wants no audio track. */
        videoOnlySelector: format.format_id,
        height,
        label: `${height}p`,
        ext: format.ext,
        fps: format.fps ?? null,
        vcodec: shortCodec(format.vcodec),
        acodec: hasAudio ? shortCodec(format.acodec) : shortCodec(bestAudio?.acodec),
        filesize: size.bytes,
        /** True when the number comes from bitrate × duration rather than a reported length. */
        filesizeApprox: size.approx,
        hasAudio,
        hdr: Boolean(format.dynamic_range && format.dynamic_range !== 'SDR'),
      };
    });

  // Some sites (X/Twitter among them) report a single progressive format whose
  // height is absent or 0. Filtering those out above would leave an empty
  // quality list and the extension would claim "no downloadable formats" even
  // though the video is perfectly downloadable. Fall back to a single "best"
  // entry so there is always something to pick.
  if (!ladder.length) {
    const best = progressive[0]
      || [...formats].reverse().find((f) => f.vcodec && f.vcodec !== 'none')
      || null;

    if (best) {
      const size = estimateSize(
        best,
        Boolean(best.acodec && best.acodec !== 'none'),
        null,
        info.duration || 0,
      );
      ladder.push({
        selector: best.format_id,
        videoOnlySelector: best.format_id,
        height: 0,
        label: 'best',
        ext: best.ext,
        fps: best.fps ?? null,
        vcodec: shortCodec(best.vcodec),
        acodec: shortCodec(best.acodec),
        filesize: size.bytes,
        filesizeApprox: size.approx,
        hasAudio: Boolean(best.acodec && best.acodec !== 'none'),
        hdr: false,
        /** Signals the UI that this is a fallback, not a measured resolution. */
        generic: true,
      });
    }
  }

  return {
    ladder,
    bestAudioFormatId: bestAudio?.format_id ?? null,
    audioOnly: audioFormats
      .slice()
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
      .slice(0, 5)
      .map((f) => {
        const size = streamBytes(f, info.duration || 0);
        return {
          selector: f.format_id,
          ext: f.ext,
          abr: f.abr ?? null,
          acodec: shortCodec(f.acodec),
          filesize: size.bytes,
          filesizeApprox: size.approx,
        };
      }),
  };
}

function shortCodec(codec) {
  if (!codec || codec === 'none') return null;
  // "avc1.640028" -> "avc1", "mp4a.40.2" -> "mp4a"
  return String(codec).split('.')[0];
}

/**
 * Byte length of one stream.
 *
 * yt-dlp often omits filesize on YouTube DASH formats. When that happens,
 * bitrate (kbps) × duration is a close enough estimate for the quality picker.
 */
function streamBytes(format, durationSec) {
  if (!format) return { bytes: null, approx: false };
  const exact = Number(format.filesize) || 0;
  if (exact > 0) return { bytes: exact, approx: false };
  const reported = Number(format.filesize_approx) || 0;
  if (reported > 0) return { bytes: reported, approx: true };
  const kbps = Number(format.tbr) || Number(format.vbr) || Number(format.abr) || 0;
  const seconds = Number(format.duration) || Number(durationSec) || 0;
  if (kbps > 0 && seconds > 0) {
    return { bytes: Math.round((kbps * 1000 / 8) * seconds), approx: true };
  }
  return { bytes: null, approx: false };
}

/**
 * Size of the file the user will actually get.
 *
 * High resolutions are video-only and get merged with the best audio, so that
 * audio length has to be included even though the video format itself has none.
 */
function estimateSize(videoFormat, hasAudio, audioFormat, durationSec) {
  const video = streamBytes(videoFormat, durationSec);
  if (hasAudio || !audioFormat) return video;
  const audio = streamBytes(audioFormat, durationSec);
  if (video.bytes && audio.bytes) {
    return { bytes: video.bytes + audio.bytes, approx: video.approx || audio.approx };
  }
  const bytes = video.bytes || audio.bytes;
  return { bytes, approx: Boolean(bytes) };
}

/**
 * Collapse yt-dlp's subtitle maps into a flat, UI-friendly list.
 * `subtitles` = human-authored, `automatic_captions` = ASR-generated.
 */
function normaliseSubtitles(info) {
  const out = [];
  const seen = new Set();

  const push = (map, kind) => {
    for (const [lang, tracks] of Object.entries(map || {})) {
      const formats = (tracks || []).filter((t) => ['srt', 'vtt', 'json3', 'ttml'].includes(t.ext));
      if (!formats.length) continue;
      if (seen.has(lang)) continue;
      seen.add(lang);
      out.push({
        lang,
        kind,
        label: tracks[0]?.name || lang,
        // Prefer a plain-text-ish format; srt is easiest for users.
        ext: formats.some((f) => f.ext === 'srt') ? 'srt' : formats[0].ext,
      });
    }
  };

  push(info.subtitles, 'manual');
  push(info.automatic_captions, 'auto');

  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'manual' ? -1 : 1;
    return a.lang.localeCompare(b.lang);
  });
}

/**
 * Build the yt-dlp argv for an actual download.
 *
 * `job` comes from the extension and is validated by the caller.
 */
export function buildDownloadArgs(job, paths) {
  const args = [...baseArgs()];

  // Progress lines we can parse without the fragile --newline table output.
  //
  // The template emits one machine-readable line per update. If a field is
  // unavailable in a given build it renders as "N/A", which the parser in
  // queue.js tolerates — and it also falls back to plain `[download]` lines,
  // so progress keeps working across yt-dlp versions.
  args.push('--newline');
  args.push(
    '--progress-template',
    'download:@@PROGRESS@@%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s',
  );
  args.push('--print', 'after_move:@@DONE@@%(filepath)s');

  if (paths.cookieFile) args.push('--cookies', paths.cookieFile);

  // Robustness for YouTube's throttled DASH streams.
  //
  // We deliberately do NOT pass --no-part: writing straight to the target name
  // makes yt-dlp resume into a file whose range bookkeeping can disagree with
  // the server, which surfaces as "HTTP Error 416: Requested range not
  // satisfiable". The default .part file is resumable and avoids that.
  args.push('--retries', '10');
  args.push('--fragment-retries', '10');
  args.push('--retry-sleep', '2');
  args.push('--file-access-retries', '5');
  // Keep the .part file between attempts so a retry resumes rather than restarts.
  args.push('--continue');

  // ---- format selection -------------------------------------------------
  if (job.mode === 'audio') {
    args.push('-f', job.audioSelector || 'bestaudio/best');
    args.push('--extract-audio');
    args.push('--audio-format', job.audioFormat || 'mp3');
    args.push('--audio-quality', '0');
  } else if (job.mode === 'thumbnail') {
    args.push('--skip-download');
    args.push('--write-thumbnail');
    args.push('--convert-thumbnails', 'jpg');
  } else {
    // Video mode: prefer the requested resolution, fall back downwards so the
    // job still succeeds when that exact height is unavailable.
    const height = Number(job.height) || 1080;
    const selector = job.selector
      ? job.selector
      : `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
    args.push('-f', selector);
    // Remux into mp4 when the codecs allow it, otherwise keep the native container.
    args.push('--merge-output-format', job.container || 'mp4');
  }

  // ---- subtitles --------------------------------------------------------
  if (job.subtitles?.enabled) {
    args.push('--write-subs');
    if (job.subtitles.auto) args.push('--write-auto-subs');
    const langs = (job.subtitles.langs || []).join(',') || 'en';
    args.push('--sub-langs', langs);
    args.push('--convert-subs', job.subtitles.format || 'srt');
    if (job.subtitles.embed) args.push('--embed-subs');
  } else if (job.embedSubs) {
    args.push('--write-auto-subs', '--embed-subs', '--sub-langs', 'en.*,en');
  }

  if (job.embedThumbnail) args.push('--embed-thumbnail');
  if (job.embedMetadata) args.push('--embed-metadata');
  if (job.sponsorblock) {
    args.push('--sponsorblock-remove', 'sponsor,selfpromo,interaction');
  }

  if (job.playlist) {
    // Explicitly re-enable playlist handling only when the user asked for it.
    const idx = args.indexOf('--no-playlist');
    if (idx !== -1) args.splice(idx, 1);
    args.push('--yes-playlist');
    if (job.playlistItems) args.push('--playlist-items', job.playlistItems);
  }

  // ---- output -----------------------------------------------------------
  args.push('-o', paths.outputTemplate);
  args.push('--paths', `home:${paths.downloadDir}`);
  if (job.rateLimit) args.push('--limit-rate', job.rateLimit);

  if (job.url) {
    args.push(job.url);
  } else {
    args.push(canonicalUrl(job.videoId));
  }

  return args;
}

/** Turn yt-dlp's stderr into something a normal person can act on. */
export function explainYtDlpError(err) {
  const text = String(err?.stderr || err?.stdout || err?.message || err).trim();
  const lower = text.toLowerCase();

  // Process could not be started at all. Checked before the generic ENOENT
  // branch below because the causes and fixes are different.
  if (lower.includes('eperm') || lower.includes('eacces')) {
    return (
      'The bridge could not start yt-dlp (permission denied). ' +
      'If you are running inside a restricted or sandboxed shell, run the bridge normally instead. ' +
      'Otherwise check that yt-dlp is not blocked by antivirus, and set YTD_YTDLP to its full path.'
    );
  }
  if (lower.includes('enoent')) {
    return (
      'yt-dlp was not found. Install it (winget install yt-dlp.yt-dlp) and restart the bridge, ' +
      'or set YTD_YTDLP to the full path of yt-dlp.exe.'
    );
  }

  // Check age restriction before the general bot check: YouTube's age-gate
  // message ("Sign in to confirm your age") also contains "sign in to confirm",
  // so the bot pattern would otherwise match it first and give the wrong advice.
  if (lower.includes('confirm your age') || (lower.includes('age') && lower.includes('restricted'))) {
    return 'This video is age-restricted. Send your YouTube cookies from the extension and retry.';
  }
  if (lower.includes('sign in to confirm') || lower.includes("confirm you're not a bot")) {
    return 'YouTube asked this request to prove it is not a bot. Open the extension settings and enable "Use browser cookies", then retry.';
  }
  if (lower.includes('video unavailable')) {
    return 'This video is unavailable (removed, region-locked, or private).';
  }
  if (lower.includes('private video')) {
    return 'This is a private video. Sign in via browser cookies to download it.';
  }
  if (lower.includes('members-only') || lower.includes('join this channel')) {
    return 'This video is members-only. Browser cookies from a subscribed account are required.';
  }
  if (lower.includes('requested format is not available')) {
    return 'The requested quality is no longer available for this video. Pick a different quality.';
  }
  if (lower.includes('ffmpeg') && (lower.includes('not found') || lower.includes('not installed'))) {
    return 'ffmpeg was not found, so separate video and audio streams cannot be merged. Install ffmpeg and restart the bridge service.';
  }
  if (lower.includes('unsupported url')) {
    return 'That URL is not a supported YouTube video link.';
  }
  if (lower.includes('download video subtitles')) {
    return (
      'YouTube throttled the subtitle request (HTTP 429 is common for auto-generated ' +
      'captions without sign-in). Pick a "manual" subtitle track, or enable *Use browser ' +
      'cookies* in the extension and retry. The video itself downloads fine.'
    );
  }
  if (
    lower.includes('403') ||
    lower.includes('forbidden') ||
    lower.includes('unable to download video data')
  ) {
    return (
      'YouTube rejected the download link (HTTP 403). This is usually IP/proxy based and is fixed ' +
      'by updating yt-dlp (brew upgrade yt-dlp / winget upgrade yt-dlp.yt-dlp / pip install -U yt-dlp). ' +
      'If it persists, restart the bridge with a browser-style client — `YTD_PLAYER_CLIENT=mweb ./start-bridge.sh` ' +
      '(offers up to 360p only) — or send browser cookies from the extension and retry.'
    );
  }
  // Fall back to the last meaningful stderr line.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.find((l) => l.startsWith('ERROR:')) || lines[lines.length - 1] || 'Unknown yt-dlp failure';
  return errorLine.replace(/^ERROR:\s*/, '');
}

export { spawn };
