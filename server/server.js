import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureRuntimeDirs } from './config.js';
import { checkBinaries, probeVideo } from './ytdlp.js';
import { downloadManager } from './queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

ensureRuntimeDirs();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Origins allowed to call this service. Chrome extension pages use the
 *  chrome-extension:// scheme; the ID varies per install so we accept any. */
function applyCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed =
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin.startsWith('safari-web-extension://') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1');

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (origin) {
    // A real web page reached us: deliberately omit ACAO so its browser cannot
    // read the response — the access token then cannot be scraped off it.
  } else {
    // No Origin (e.g. curl): echo * to keep manual testing easy.
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-YTD-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The service listens only on 127.0.0.1, so the practical threat is another
 * local process or a malicious web page reaching it. A shared token plus an
 * origin check closes both.
 */
function isAuthorised(req) {
  if (!config.token) return true;
  const header = req.headers['x-ytd-token'];
  if (header && header === config.token) return true;
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('token') === config.token;
}

function log(...args) {
  if (config.verbose) console.log('[bridge]', ...args);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/health$/, async (req, res) => {
  const bins = await checkBinaries();
  sendJson(res, 200, {
    ok: true,
    service: 'yt-downloader-bridge',
    version: config.version,
    token: config.token,
    platform: process.platform,
    downloadDir: config.downloadDir,
    concurrency: config.maxConcurrent,
    binaries: bins,
    queue: downloadManager.stats(),
    // Whether this platform can be started from the browser via the custom
    // protocol. The extension uses it to decide if the button is offered.
    canLaunch: process.platform === 'win32',
  });
});

route('GET', /^\/probe$/, async (req, res, { query }) => {
  const videoId = query.get('videoId');
  const url = query.get('url');
  if (!videoId && !url) return sendJson(res, 400, { error: 'videoId or url is required' });

  try {
    const info = await probeVideo(videoId || url, { cookieFile: resolveCookieFile(query.get('cookieProfile')) });
    sendJson(res, 200, info);
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
});

route('POST', /^\/download$/, async (req, res) => {
  const body = await readJsonBody(req);
  if (!body.videoId && !body.url) return sendJson(res, 400, { error: 'videoId or url is required' });

  const cookieFile = resolveCookieFile(body.cookieProfile);

  const spec = {
    ...body,
    cookieFile,
    playlistTitle: body.playlistTitle ?? null,
  };

  // If the caller did not resolve a title yet, fetch it so the queue looks good.
  if (!spec.title && spec.videoId) {
    try {
      const info = await probeVideo(spec.videoId, { cookieFile });
      spec.title = info.title;
      spec.thumbnail = spec.thumbnail || info.thumbnail;
      spec.duration = spec.duration || info.duration;
    } catch {
      /* a probe failure should not block the download attempt */
    }
  }

  const job = downloadManager.enqueue(spec);
  sendJson(res, 202, { job });
});

route('GET', /^\/jobs$/, async (req, res) => {
  sendJson(res, 200, { jobs: downloadManager.list(), stats: downloadManager.stats() });
});

route('GET', /^\/jobs\/([^/]+)$/, async (req, res, { params }) => {
  const job = downloadManager.get(params[0]);
  if (!job) return sendJson(res, 404, { error: 'Job not found' });
  sendJson(res, 200, { job });
});

route('POST', /^\/jobs\/([^/]+)\/cancel$/, async (req, res, { params }) => {
  const ok = downloadManager.cancel(params[0]);
  sendJson(res, ok ? 200 : 409, { ok });
});

route('POST', /^\/jobs\/([^/]+)\/retry$/, async (req, res, { params }) => {
  const job = downloadManager.retry(params[0]);
  if (!job) return sendJson(res, 409, { error: 'Job cannot be retried' });
  sendJson(res, 202, { job });
});

route('DELETE', /^\/jobs\/([^/]+)$/, async (req, res, { params, query }) => {
  const deleteFile = query.get('deleteFile') === '1';
  const result = downloadManager.remove(params[0], deleteFile);
  sendJson(res, result.ok ? 200 : 404, result);
});

route('POST', /^\/jobs\/clear$/, async (req, res, { query }) => {
  const removed = downloadManager.clearFinished(query.get('deleteFiles') === '1');
  sendJson(res, 200, { removed });
});

route('GET', /^\/events$/, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ jobs: downloadManager.list(), stats: downloadManager.stats() })}\n\n`);

  const unsubscribe = downloadManager.subscribe((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // Keep intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

route('GET', /^\/file$/, async (req, res, { query }) => {
  const jobId = query.get('jobId');
  const job = jobId ? downloadManager.get(jobId) : null;
  if (!job || !job.filePath) return sendJson(res, 404, { error: 'No file for this job' });

  // Guard against path traversal: the file must live strictly inside downloadDir.
  // Use path.relative (not a string prefix check) so a sibling directory whose
  // name merely shares a prefix (e.g. "YouTube-evil") cannot slip through.
  const baseDir = path.resolve(config.downloadDir);
  const resolved = path.resolve(job.filePath);
  const rel = path.relative(baseDir, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return sendJson(res, 403, { error: 'Refusing to serve a file outside the download directory' });
  }
  if (!fs.existsSync(resolved)) return sendJson(res, 404, { error: 'File no longer exists' });

  // A file can be deleted between the check above and the stat below, so treat
  // any failure here as "not available" rather than letting it throw.
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return sendJson(res, 404, { error: 'File no longer exists' });
  }

  const name = path.basename(resolved);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    // Without this header Chrome cannot produce a real "save as" name.
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Access-Control-Expose-Headers': 'Content-Disposition',
  });
  fs.createReadStream(resolved).pipe(res);
});

route('POST', /^\/cookies$/, async (req, res) => {
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  if (!body.cookieHeader && !body.cookies) {
    return sendJson(res, 400, { error: 'cookieHeader or cookies is required' });
  }
  const profile = sanitiseProfile(body.domain || 'youtube');
  const file = path.join(config.cookieDir, `${profile}.txt`);

  const lines = [
    '# Netscape HTTP Cookie File',
    '# Generated by the YouTube Downloader extension',
    `# ${new Date().toISOString()}`,
    '',
  ];

  if (body.cookieHeader) {
    for (const pair of String(body.cookieHeader).split(';')) {
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=').trim();
      if (!name || !name.trim() || !value) continue;
      // domain  includeSubdomains  path  secure  expires  name  value
      lines.push([
        '.youtube.com', 'TRUE', '/', 'TRUE', '0', name.trim(), value,
      ].join('\t'));
      lines.push([
        '.google.com', 'TRUE', '/', 'TRUE', '0', name.trim(), value,
      ].join('\t'));
    }
  } else {
    for (const c of body.cookies) {
      const domain = c.domain?.startsWith('.') ? c.domain : `.${c.domain || 'youtube.com'}`;
      lines.push([
        domain,
        'TRUE',
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        String(c.expirationDate ? Math.floor(c.expirationDate) : 0),
        c.name,
        c.value,
      ].join('\t'));
    }
  }

  fs.writeFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  const count = lines.filter((l) => !l.startsWith('#') && l.trim()).length;
  sendJson(res, 200, { ok: true, profile, count, path: file });
});

route('GET', /^\/cookies$/, async (req, res) => {
  // A file can disappear between readdir and stat, so never let statSync throw
  // out of a listing: skip the entry instead of failing the whole request.
  const profiles = [];
  if (fs.existsSync(config.cookieDir)) {
    for (const f of fs.readdirSync(config.cookieDir)) {
      if (!f.endsWith('.txt')) continue;
      try {
        profiles.push({
          profile: f.replace(/\.txt$/, ''),
          updatedAt: fs.statSync(path.join(config.cookieDir, f)).mtimeMs,
        });
      } catch {
        /* removed while we were listing it */
      }
    }
  }
  sendJson(res, 200, { profiles });
});

route('DELETE', /^\/cookies$/, async (req, res, { query }) => {
  const profile = sanitiseProfile(query.get('profile') || 'youtube');
  const file = path.join(config.cookieDir, `${profile}.txt`);
  fs.rmSync(file, { force: true });
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/open-folder$/, async (req, res) => {
  const { spawn } = await import('node:child_process');
  const body = await readJsonBody(req).catch(() => ({}));

  // Resolve what to reveal. A missing file must never abort the whole action:
  // fs.statSync throws on a nonexistent path, and previously that turned
  // "show me this download" into a 500 that the UI silently swallowed. Falling
  // back to the download folder is always a useful answer.
  let target = config.downloadDir;
  let fellBack = false;

  if (body.jobId) {
    const job = downloadManager.get(body.jobId);
    if (job?.filePath) {
      if (fs.existsSync(job.filePath)) {
        target = job.filePath;
      } else {
        // The file was moved, deleted, or the path is stale.
        fellBack = true;
      }
    } else {
      fellBack = true;
    }
  }

  let isDirectory = true;
  try {
    isDirectory = fs.statSync(target).isDirectory();
  } catch {
    // Download folder itself is unavailable; fall back to the user's home so
    // the click still does something visible.
    target = os.homedir();
    isDirectory = true;
    fellBack = true;
  }
  if (target.endsWith(path.sep)) isDirectory = true;

  try {
    if (process.platform === 'win32') {
      if (isDirectory) {
        spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
      } else {
        // explorer's /select, needs the switch and path as ONE argument or it
        // opens My Documents instead of the folder.
        spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref();
      }
    } else if (process.platform === 'darwin') {
      spawn('open', isDirectory ? [target] : ['-R', target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [isDirectory ? target : path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
    }
    sendJson(res, 200, { ok: true, target, isDirectory, fellBack });
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

function sanitiseProfile(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'youtube';
}

function resolveCookieFile(profile) {
  const name = sanitiseProfile(profile || 'youtube');
  const file = path.join(config.cookieDir, `${name}.txt`);
  return fs.existsSync(file) ? file : null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  // /health must stay reachable without a token so the extension can discover one.
  if (pathname !== '/health' && !isAuthorised(req)) {
    sendJson(res, 401, { error: 'Missing or invalid X-YTD-Token header' });
    return;
  }

  log(req.method, pathname);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.pattern.exec(pathname);
    if (!match) continue;
    try {
      await r.handler(req, res, {
        params: match.slice(1).map(decodeURIComponent),
        query: url.searchParams,
      });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(err?.message || err) });
      } else {
        res.end();
      }
    }
    return;
  }

  sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
});

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('  YouTube Downloader bridge is running  /  本地下载服务已启动');
  console.log(`  URL          http://${config.host}:${config.port}`);
  console.log(`  Downloads    ${config.downloadDir}`);
  console.log(`  yt-dlp       ${config.ytDlpPath}`);
  console.log(`  Token        ${config.token}`);
  console.log('');
  console.log('  Keep this window open while downloading.');
  console.log('  下载期间请保持本窗口开启。');
  console.log('  Press Ctrl+C to stop.  /  按 Ctrl+C 停止服务。');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use.`);
    console.error(`  端口 ${config.port} 已被占用。`);
    console.error('  Either the bridge is already running, or another app uses that port.');
    console.error('  可能是服务已在运行，或其他程序占用了该端口。');
    console.error('  Start on another port:  set YTD_PORT=8766 && node server.js\n');
  } else {
    console.error('\n  Server error  /  服务错误:', err.message, '\n');
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  Shutting down bridge...  /  正在停止本地服务...');
    for (const job of downloadManager.jobs.values()) {
      if (job.child) {
        job.cancelled = true;
        try { job.child.kill(); } catch { /* ignore */ }
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

// ---------------------------------------------------------------------------
// Last-resort safety net
// ---------------------------------------------------------------------------
//
// An uncaught exception anywhere would take the whole bridge down, and the
// extension would then report "bridge not running" for what was really a bug in
// one request. Log loudly but stay up: a filesystem race or a malformed job
// must not cost the user their running service.
process.on('uncaughtException', (err) => {
  console.error('\n  [bridge] Uncaught exception (continuing):', err?.stack || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('\n  [bridge] Unhandled rejection (continuing):', reason?.stack || reason);
});
