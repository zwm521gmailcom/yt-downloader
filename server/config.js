import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/**
 * Central configuration for the local bridge service.
 *
 * Every value can be overridden with an environment variable so the service can
 * be launched from the bundled start scripts without editing code.
 */

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function defaultDownloadDir() {
  // Keep downloads inside the user's normal Downloads folder unless told otherwise.
  const home = os.homedir();
  return path.join(home, 'Downloads', 'YouTube');
}

/**
 * Fall back to a writable location when the preferred download folder cannot
 * be created. This matters in sandboxed or locked-down environments where
 * writing to the user's Downloads folder is denied.
 */
function resolveDownloadDir() {
  const preferred = process.env.YTD_DOWNLOAD_DIR || defaultDownloadDir();
  const candidates = [preferred];

  // Next to the service itself, then the OS temp dir.
  candidates.push(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'downloads'));
  candidates.push(path.join(os.tmpdir(), 'ytd-downloads'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      if (dir !== preferred) {
        console.warn(`[bridge] Cannot write to "${preferred}" — using "${dir}" instead.`);
        console.warn(`[bridge] 无法写入 "${preferred}"，已改用 "${dir}"。`);
        console.warn('[bridge] Set YTD_DOWNLOAD_DIR to choose a different folder.');
        console.warn('[bridge] 可通过设置 YTD_DOWNLOAD_DIR 指定其他目录。');
      }
      return dir;
    } catch {
      /* try the next candidate */
    }
  }
  // Give up gracefully; ensureRuntimeDirs will surface the real error.
  return preferred;
}

export const config = {
  /** Reported by /health so the extension can detect an outdated bridge. */
  version: '1.1.0',

  /** Port the HTTP + SSE server listens on. The extension hard-codes this too. */
  port: envInt('YTD_PORT', 8765),

  /** Bind address. 127.0.0.1 keeps the service off the local network. */
  host: process.env.YTD_HOST || '127.0.0.1',

  /** Where finished files are written. Falls back to a writable path. */
  downloadDir: resolveDownloadDir(),

  /**
   * Optional absolute path to the yt-dlp binary. When empty we rely on PATH
   * lookup, which is what the WinGet / Homebrew / pip installs give you.
   */
  ytDlpPath: process.env.YTD_YTDLP || 'yt-dlp',

  /** Optional absolute path to ffmpeg. Used for merging and audio extraction. */
  ffmpegPath: process.env.YTD_FFMPEG || 'ffmpeg',

  /** How many downloads may run at the same time. */
  maxConcurrent: envInt('YTD_CONCURRENCY', 2),

  /** Directory for browser cookie exports dropped by the extension. */
  cookieDir: process.env.YTD_COOKIE_DIR || path.join(os.tmpdir(), 'ytd-bridge-cookies'),

  /** Shared secret. Generated on first boot and written next to this file. */
  token: process.env.YTD_TOKEN || readOrCreateToken(),

  /** Set to 1 to log every request. */
  verbose: process.env.YTD_VERBOSE === '1',
};

function readOrCreateToken() {
  const tokenFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.token');
  try {
    if (fs.existsSync(tokenFile)) {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (existing) return existing;
    }
    const fresh = randomBytes(24).toString('hex');
    fs.writeFileSync(tokenFile, fresh, { encoding: 'utf8', mode: 0o600 });
    return fresh;
  } catch {
    // If we cannot persist a token, fall back to a per-run random value.
    return randomBytes(24).toString('hex');
  }
}

export function ensureRuntimeDirs() {
  for (const dir of [config.downloadDir, config.cookieDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  syncLaunchToken();
}

/**
 * Mirror the access token into server/.start-token.
 *
 * ytdl-handler.cmd reads that file to authenticate a ytdl:// launch before
 * starting the bridge. Writing it from here means the two can never drift:
 * whichever token the bridge is using is exactly the one the handler accepts.
 *
 * Written last, and best-effort: if it fails the launcher simply refuses to
 * start (fail closed) rather than accepting unauthenticated launches.
 */
function syncLaunchToken() {
  try {
    const launchFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.start-token');
    fs.writeFileSync(launchFile, config.token, { encoding: 'ascii', mode: 0o600 });
  } catch {
    /* the launcher will report a missing token; downloading still works */
  }
}
