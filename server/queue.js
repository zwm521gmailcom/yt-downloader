import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { buildDownloadArgs, explainYtDlpError, getYtDlpPath } from './ytdlp.js';

/**
 * Download queue with a fixed concurrency limit.
 *
 * Jobs are persisted to disk so that closing the popup, or even restarting the
 * bridge, does not lose the queue. Progress is streamed to the extension via
 * Server-Sent Events.
 */

const HISTORY_LIMIT = 200;

class DownloadManager {
  constructor() {
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set();
    this.running = 0;
    this.stateFile = path.join(config.cookieDir, '..', 'ytd-bridge-state.json');
    this.#load();
  }

  // ---- persistence ------------------------------------------------------

  #load() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const job of raw.jobs || []) {
        // Anything that was mid-flight when the process died is now failed.
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'failed';
          job.error = 'Interrupted by bridge restart';
          job.finishedAt = Date.now();
        }
        this.jobs.set(job.id, job);
      }
    } catch {
      /* a corrupt state file just means we start clean */
    }
  }

  #save() {
    try {
      const jobs = [...this.jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, HISTORY_LIMIT);
      fs.writeFileSync(this.stateFile, JSON.stringify({ jobs }, null, 2), 'utf8');
    } catch {
      /* persistence is best-effort */
    }
  }

  // ---- events -----------------------------------------------------------

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(type, job) {
    // Include fresh stats on every event. The client mirrors them directly, so
    // omitting them would leave its counters stale between snapshots (the
    // active-download badge would not move when a job is created or cancelled).
    const payload = { type, job: this.publicJob(job), stats: this.stats(), at: Date.now() };
    for (const fn of this.listeners) {
      try {
        fn(payload);
      } catch {
        /* a broken SSE stream must not break the queue */
      }
    }
  }

  publicJob(job) {
    return {
      id: job.id,
      videoId: job.videoId,
      url: job.url,
      title: job.title,
      thumbnail: job.thumbnail,
      duration: job.duration,
      mode: job.mode,
      qualityLabel: job.qualityLabel,
      status: job.status,
      progress: job.progress,
      speed: job.speed,
      eta: job.eta,
      downloadedBytes: job.downloadedBytes,
      totalBytes: job.totalBytes,
      filePath: job.filePath,
      fileName: job.filePath ? path.basename(job.filePath) : null,
      fileSize: job.fileSize,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      playlistTitle: job.playlistTitle ?? null,
    };
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => this.publicJob(j));
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  stats() {
    const all = [...this.jobs.values()];
    return {
      total: all.length,
      queued: all.filter((j) => j.status === 'queued').length,
      running: all.filter((j) => j.status === 'running').length,
      done: all.filter((j) => j.status === 'done').length,
      failed: all.filter((j) => j.status === 'failed').length,
      cancelled: all.filter((j) => j.status === 'cancelled').length,
      active: this.running,
      maxConcurrent: config.maxConcurrent,
    };
  }

  // ---- queue control ----------------------------------------------------

  /**
   * Create a job and start it if capacity allows.
   * @param {object} spec job description coming from the extension
   */
  enqueue(spec) {
    const job = {
      id: randomUUID(),
      videoId: spec.videoId ?? null,
      url: spec.url ?? null,
      title: spec.title || spec.videoId || 'YouTube video',
      thumbnail: spec.thumbnail ?? null,
      duration: spec.duration ?? 0,
      mode: spec.mode || 'video',
      qualityLabel: spec.qualityLabel || (spec.mode === 'audio' ? 'Audio' : `${spec.height || 1080}p`),
      height: spec.height ?? null,
      selector: spec.selector ?? null,
      audioSelector: spec.audioSelector ?? null,
      audioFormat: spec.audioFormat ?? 'mp3',
      container: spec.container ?? 'mp4',
      subtitles: spec.subtitles ?? null,
      embedSubs: Boolean(spec.embedSubs),
      embedThumbnail: Boolean(spec.embedThumbnail),
      embedMetadata: spec.embedMetadata !== false,
      sponsorblock: Boolean(spec.sponsorblock),
      playlist: Boolean(spec.playlist),
      playlistItems: spec.playlistItems ?? null,
      playlistTitle: spec.playlistTitle ?? null,
      rateLimit: spec.rateLimit ?? null,
      cookieFile: spec.cookieFile ?? null,

      status: 'queued',
      progress: 0,
      speed: null,
      eta: null,
      downloadedBytes: 0,
      totalBytes: null,
      filePath: null,
      fileSize: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      child: null,
      cancelled: false,
    };

    this.jobs.set(job.id, job);
    this.#save();
    this.#emit('job:created', job);
    this.#pump();
    return this.publicJob(job);
  }

  #pump() {
    if (this.running >= config.maxConcurrent) return;
    const next = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return;
    this.#start(next);
    // Fill remaining slots.
    this.#pump();
  }

  #start(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    this.running += 1;
    this.#emit('job:started', job);

    const safeTitle = sanitiseForFilename(job.title);
    const outputTemplate = path.join(
      config.downloadDir,
      job.mode === 'audio' ? '%(title)s.%(ext)s' : '%(title)s [%(height)sp].%(ext)s',
    );

    const args = buildDownloadArgs(job, {
      cookieFile: job.cookieFile,
      outputTemplate,
      downloadDir: config.downloadDir,
    });

    let stderrBuf = '';
    let child;
    try {
      child = spawn(getYtDlpPath(), args, {
        // windowsHide sets CREATE_NO_WINDOW on the child. Windows then gives the
        // child no console at all, and — this is the important part — any process
        // yt-dlp starts inherits that, so the ffmpeg it runs to merge video and
        // audio does not flash a window either.
        //
        // This is the only lever we have: yt-dlp exposes no option for
        // suppressing its own subprocess windows (see yt-dlp issue #1251), so
        // without this every merge pops a console.
        windowsHide: true,
        // Must stay attached to our (already console-less) process group. A
        // detached child gets a fresh console, which defeats windowsHide.
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.#fail(job, explainYtDlpError(err));
      return;
    }

    job.child = child;

    // Collect raw Buffers and decode them ourselves.
    //
    // We must NOT call setEncoding('utf8'): on Windows yt-dlp writes the
    // `--print` output (which contains the file path) using the console's
    // ANSI/OEM codepage, not UTF-8. Decoding those bytes as UTF-8 replaces
    // every non-ASCII character with U+FFFD, permanently destroying a
    // Chinese/Japanese/Korean filename before we ever see it.
    const stdoutDecoder = new LineDecoder();
    const stderrDecoder = new LineDecoder();

    child.stdout.on('data', (chunk) => {
      for (const line of stdoutDecoder.push(chunk)) this.#handleLine(job, line);
    });

    child.stderr.on('data', (chunk) => {
      for (const line of stderrDecoder.push(chunk)) {
        stderrBuf += `${line}\n`;
        // yt-dlp also writes progress to stderr in some versions.
        this.#handleLine(job, line);
      }
    });

    child.on('error', (err) => {
      this.#fail(job, explainYtDlpError(err));
    });

    child.on('close', (code) => {
      job.child = null;
      if (job.cancelled) {
        this.#settle(job, 'cancelled');
        return;
      }
      if (code === 0) {
        job.progress = 100;

        // Prefer the path yt-dlp reported. Verify it exists: if the path was
        // mangled (or --print did not fire at all, as in thumbnail mode) we
        // fall back to locating the newest matching file on disk, otherwise
        // the UI would show a completed job with no file and a 0-byte size.
        if (job.filePath && !fs.existsSync(job.filePath)) {
          job.filePath = null;
        }
        if (!job.filePath) {
          job.filePath = this.#guessOutputFile(job);
        }

        if (job.filePath) {
          try {
            job.fileSize = fs.statSync(job.filePath).size;
          } catch {
            job.fileSize = null;
          }
        }
        this.#settle(job, 'done');
      } else {
        this.#fail(job, explainYtDlpError({ stderr: stderrBuf }) || `yt-dlp exited with code ${code}`);
      }
    });
  }

  #handleLine(job, rawLine) {
    const line = rawLine.trim();
    if (!line) return;

    if (line.startsWith('@@PROGRESS@@')) {
      this.#parseProgressTemplate(job, line.slice('@@PROGRESS@@'.length));
      return;
    }

    if (line.startsWith('@@DONE@@')) {
      job.filePath = line.slice('@@DONE@@'.length).trim();
      return;
    }

    // Capture the destination early so a cancelled job still reports a path.
    const destMatch = line.match(/^\[download\] Destination:\s*(.+)$/);
    if (destMatch) {
      job.filePath = destMatch[1].trim();
      return;
    }

    // Fallback: parse a plain [download] line. This keeps the progress bar
    // working on yt-dlp builds whose progress-template fields differ.
    if (line.startsWith('[download]')) {
      this.#parsePlainProgress(job, line);
    }
  }

  /**
   * Parse our `--progress-template` output:
   *   percent|speed|eta|downloaded|total
   * Any field may be blank or "N/A" depending on the yt-dlp build and on
   * whether the total size is known yet, so every field is optional.
   */
  #parseProgressTemplate(job, body) {
    const parts = body.split('|');
    const [percent, speed, eta, downloaded, total] = parts;

    const pct = Number.parseFloat(String(percent).replace('%', '').trim());
    if (Number.isFinite(pct)) job.progress = Math.max(0, Math.min(100, pct));

    job.speed = cleanField(speed) ?? job.speed;
    job.eta = cleanField(eta) ?? job.eta;

    const down = Number.parseInt(downloaded, 10);
    if (Number.isFinite(down) && down >= 0) job.downloadedBytes = down;

    const tot = Number.parseInt(total, 10);
    if (Number.isFinite(tot) && tot > 0) job.totalBytes = tot;

    this.#emit('job:progress', job);
  }

  /**
   * Fallback parser for the default progress output:
   *   [download]  42.3% of   10.00MiB at  1.20MiB/s ETA 00:07
   *   [download] 100% of   10.00MiB in 00:08
   */
  #parsePlainProgress(job, line) {
    const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
    if (percentMatch) {
      const pct = Number.parseFloat(percentMatch[1]);
      if (Number.isFinite(pct)) job.progress = Math.max(0, Math.min(100, pct));
    }

    const speedMatch = line.match(/at\s+([\d.]+\s*[KMGT]?i?B\/s)/i);
    if (speedMatch) job.speed = speedMatch[1];

    const etaMatch = line.match(/ETA\s+([\d:]+)/);
    if (etaMatch) job.eta = etaMatch[1];

    const sizeMatch = line.match(/of\s+~?\s*([\d.]+\s*[KMGT]?i?B)/i);
    if (sizeMatch) {
      const bytes = parseSizeToBytes(sizeMatch[1]);
      if (bytes) job.totalBytes = bytes;
    }

    if (job.totalBytes && job.progress) {
      job.downloadedBytes = Math.round((job.totalBytes * job.progress) / 100);
    }

    this.#emit('job:progress', job);
  }

  /**
   * Work out which file a finished job produced.
   *
   * Used when yt-dlp's `--print after_move` output is unavailable or the
   * reported path does not exist. Picking simply the newest file is wrong:
   * while merging, the newest file is an intermediate video-only fragment
   * (`...f299.mp4`), not the finished video. So we exclude fragments and
   * prefer a file whose modification time is at or after the merge finished.
   */
  #guessOutputFile(job) {
    try {
      const since = job.startedAt ?? 0;

      const candidates = fs.readdirSync(config.downloadDir)
        .map((name) => {
          const full = path.join(config.downloadDir, name);
          try {
            const stat = fs.statSync(full);
            if (!stat.isFile()) return null;
            return { name, full, mtime: stat.mtimeMs, size: stat.size };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((f) => f.mtime >= since - 5000)
        // yt-dlp names intermediate streams "<title>.f<id>.<ext>"; these are
        // inputs to the merge, never the deliverable.
        .filter((f) => !/\.f\d+[-\w]*\.\w+$/.test(f.name))
        // Partially written files are not results either.
        .filter((f) => !/\.(part|ytdl|temp)$/i.test(f.name))
        // Prefer a file that belongs to this job (shares its title) so a sibling
        // job finishing at the same time cannot be mistaken for this one. Falls
        // back to mtime when no title matches, so the fallback still works when
        // the title is a generic default.
        .sort((a, b) => {
          const aMine = a.name.startsWith(job.title) ? 0 : 1;
          const bMine = b.name.startsWith(job.title) ? 0 : 1;
          if (aMine !== bMine) return aMine - bMine;
          return b.mtime - a.mtime;
        });

      return candidates[0]?.full ?? null;
    } catch {
      return null;
    }
  }

  #settle(job, status) {
    job.status = status;
    job.finishedAt = Date.now();
    this.running = Math.max(0, this.running - 1);
    this.#save();
    this.#emit(status === 'done' ? 'job:done' : `job:${status}`, job);
    this.#pump();
  }

  #fail(job, message) {
    job.status = 'failed';
    job.error = message;
    job.finishedAt = Date.now();
    this.running = Math.max(0, this.running - 1);
    this.#save();
    this.#emit('job:failed', job);
    this.#pump();
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.#save();
      this.#emit('job:cancelled', job);
      return true;
    }
    if (job.status === 'running' && job.child) {
      job.cancelled = true;
      killTree(job.child);
      return true;
    }
    return false;
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job || job.status === 'running' || job.status === 'queued') return null;
    // Re-queue the same specification as a brand new job.
    const spec = { ...job };
    delete spec.id;
    return this.enqueue(spec);
  }

  /** Remove a job row. `deleteFile` also removes the downloaded media. */
  remove(id, deleteFile = false) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: 'Job not found' };
    if (job.status === 'running' && job.child) {
      job.cancelled = true;
      killTree(job.child);
    }
    if (deleteFile && job.filePath) {
      try {
        fs.rmSync(job.filePath, { force: true });
        // Subtitles / thumbnails share the basename.
        const dir = path.dirname(job.filePath);
        const base = path.basename(job.filePath, path.extname(job.filePath));
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith(base) && name !== path.basename(job.filePath)) {
            fs.rmSync(path.join(dir, name), { force: true });
          }
        }
      } catch {
        /* file may already be gone */
      }
    }
    this.jobs.delete(id);
    this.#save();
    this.#emit('job:removed', job);
    return { ok: true };
  }

  clearFinished(deleteFiles = false) {
    let removed = 0;
    for (const job of [...this.jobs.values()]) {
      if (['done', 'failed', 'cancelled'].includes(job.status)) {
        this.remove(job.id, deleteFiles);
        removed += 1;
      }
    }
    return removed;
  }
}

function cleanField(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (!v || v === 'N/A' || v === 'Unknown' || v === 'NA' || v === 'None') return null;
  return v;
}

/** Convert a human size such as "10.00MiB" or "1.5 GB" into bytes. */
function parseSizeToBytes(text) {
  const match = String(text).match(/([\d.]+)\s*([KMGT]?)i?B/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || '').toUpperCase();
  const factor = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit] ?? 1;
  return Math.round(value * factor);
}

/**
 * Splits a byte stream into lines, decoding each one correctly.
 *
 * Why not `stream.setEncoding('utf8')`: on Windows, yt-dlp emits its `--print`
 * output — which includes the file path — in the console's ANSI/OEM codepage,
 * not UTF-8. Forcing UTF-8 turns every non-ASCII character into U+FFFD, so a
 * Chinese filename reaches us already corrupted and can never be recovered.
 *
 * Strategy: keep the raw bytes, and try UTF-8 first (correct on Linux/macOS and
 * for yt-dlp builds that do emit UTF-8). If the bytes are not valid UTF-8, fall
 * back to the platform codepage, which is what Windows actually used.
 */
class LineDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.encoding = null;
  }

  /** @param {Buffer} chunk @returns {string[]} complete lines */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    const lines = [];
    let index;
    while ((index = this.buffer.indexOf(0x0a)) !== -1) {
      let lineBytes = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      // Trim a trailing CR so CRLF streams behave like LF ones.
      if (lineBytes.length && lineBytes[lineBytes.length - 1] === 0x0d) {
        lineBytes = lineBytes.subarray(0, lineBytes.length - 1);
      }
      lines.push(this.#decode(lineBytes));
    }
    return lines;
  }

  /** Decode buffered bytes as UTF-8 when possible, else the fallback codepage. */
  #decode(bytes) {
    if (bytes.length === 0) return '';

    // Pure ASCII is valid in every candidate encoding; skip the work.
    if (bytes.every((b) => b < 0x80)) return bytes.toString('ascii');

    // Round-trip through a strict UTF-8 decoder to detect invalid sequences.
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!utf8.includes('\uFFFD')) return utf8;

    // Not UTF-8: use the fallback codepage (Windows ANSI/OEM).
    if (!this.encoding) this.encoding = pickFallbackEncoding();
    if (this.encoding) {
      const decoded = new TextDecoder(this.encoding, { fatal: false }).decode(bytes);
      // Only prefer it when it is actually more successful.
      if (countReplacements(decoded) < countReplacements(utf8)) return decoded;
    }
    return utf8;
  }
}

function countReplacements(text) {
  let n = 0;
  for (const ch of text) if (ch === '\uFFFD') n += 1;
  return n;
}

/**
 * The codepage Windows would have used for console output.
 *
 * Detected once rather than hard-coded, so this works on non-Chinese Windows
 * too (cp1252, cp932, cp949, ...).
 *
 * Two detection routes, in order of reliability:
 *   1. `chcp` — authoritative, but spawning can be denied (locked-down or
 *      sandboxed environments), so it must not be the only route.
 *   2. The ANSI codepage reported by the OS environment. Windows exposes this
 *      without spawning anything, which keeps the fallback available even when
 *      `chcp` cannot run.
 *
 * Returning null means "no fallback known"; we then keep the UTF-8 result.
 */
let cachedFallback = null;
function pickFallbackEncoding() {
  if (cachedFallback !== null) return cachedFallback;

  if (process.platform === 'win32') {
    const fromChcp = detectViaChcp();
    if (fromChcp) {
      cachedFallback = fromChcp;
      return cachedFallback;
    }
    const fromEnv = detectViaEnvironment();
    if (fromEnv) {
      cachedFallback = fromEnv;
      return cachedFallback;
    }
  }

  cachedFallback = null;
  return cachedFallback;
}

/** Map a Windows code page number onto a WHATWG encoding label. */
const CODEPAGE_LABELS = {
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  54936: 'gb18030',
};

/**
 * Read the active console code page from the registry.
 *
 * Deliberately avoids spawning `chcp`: every child process on Windows can flash
 * a console window, and this runs while the user is watching the queue. The
 * registry holds the same value and costs nothing.
 *
 * HKCU\Console\CodePage is set when the user changed the code page; the machine
 * default under HKLM is the fallback.
 */
function detectViaChcp() {
  if (process.platform !== 'win32') return null;

  const probes = [
    ['HKCU\\Console', 'CodePage'],
    ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', 'ACP'],
  ];

  for (const [key, name] of probes) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', name], {
        encoding: 'ascii',
        timeout: 5000,
        windowsHide: true,
      });

      // Two shapes occur in practice:
      //   "    CodePage    REG_DWORD    0x3a8"   (HKCU\Console)
      //   "    ACP         REG_SZ       936"     (HKLM Nls\CodePage)
      // Accept either, in hex or decimal.
      const dword = out.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
      if (dword) {
        const label = CODEPAGE_LABELS[Number.parseInt(dword[1], 16)];
        if (label) return label;
      }

      const sz = out.match(/REG_SZ\s+(\d+)/i);
      if (sz) {
        const label = CODEPAGE_LABELS[Number.parseInt(sz[1], 10)];
        if (label) return label;
      }
    } catch {
      /* key absent, or spawning not permitted */
    }
  }
  return null;
}

/**
 * Infer the codepage from the environment without spawning a process.
 *
 * A Chinese Windows sets one of the locale variables to a value like
 * "zh_CN.GBK" or "Chinese (Simplified)_China.936", both of which name the
 * encoding, so a small amount of pattern matching is enough.
 */
function detectViaEnvironment() {
  const env = process.env;
  const probes = [
    env.LC_ALL, env.LC_CTYPE, env.LANG,
    env.USER_LOCALE, env.DOTNET_CLI_UI_LANGUAGE,
  ].filter(Boolean).join(' ');

  if (/gbk|936|gb2312|gb18030/i.test(probes)) return 'gbk';
  if (/big5|950/i.test(probes)) return 'big5';
  if (/shift_jis|932|japanese/i.test(probes)) return 'shift_jis';
  if (/euc-?kr|949|korean/i.test(probes)) return 'euc-kr';

  // No locale hint. Fall back to the reader's own locale, which Windows keeps
  // in sync with the system ANSI code page.
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    if (/^zh\b/i.test(locale)) return 'gbk';
    if (/^ja\b/i.test(locale)) return 'shift_jis';
    if (/^ko\b/i.test(locale)) return 'euc-kr';
  } catch {
    /* Intl unavailable */
  }

  return null;
}

/** Strip characters Windows forbids in file names. */
export function sanitiseForFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

/** Kill a child process and everything it spawned (ffmpeg, etc.). */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export const downloadManager = new DownloadManager();
export { sanitiseForFilename as sanitise };
