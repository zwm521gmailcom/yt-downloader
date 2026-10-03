/**
 * Bridge launcher service.
 *
 * A Chrome extension cannot start a local process, so this tiny service is the
 * one thing the user has to launch. It listens on loopback and starts the real
 * bridge on request, which lets the extension offer a "Start bridge" button
 * that works from a completely fresh install.
 *
 * WHY A SEPARATE PERSISTENT PROCESS
 * ---------------------------------
 * An earlier design used a ytdl:// protocol handler, which required the
 * extension to already know a shared token before it could ask for a launch —
 * a deadlock on first run. Serving a loopback port removes that: the extension
 * just connects, and nothing secret has to be known in advance.
 *
 * SECURITY
 * --------
 *  - Binds 127.0.0.1 only, so it is unreachable from the network.
 *  - `POST /start` requires an Origin of chrome-extension://, moz-extension://
 *    or a localhost page. A random website therefore cannot trigger it: the
 *    browser always attaches the real Origin, and a cross-origin POST from a
 *    web page carries that page's origin instead.
 *  - It never accepts commands beyond "start" / "stop" / "status".
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const PORT = Number(process.env.YTD_LAUNCHER_PORT || 8766);
const HOST = '127.0.0.1';
const BRIDGE_PORT = Number(process.env.YTD_PORT || 8765);

const BRIDGE_ENTRY = path.join(root, 'server', 'server.js');
const STATE_FILE = path.join(here, '.launcher-state.json');

// ---------------------------------------------------------------------------
// Bridge control
// ---------------------------------------------------------------------------

/** @type {import('node:child_process').ChildProcess|null} */
let bridge = null;

/**
 * Is something already listening on the bridge port?
 *
 * We ask over HTTP rather than tracking our own child handle, because the
 * bridge may have been started by start-bridge.cmd instead of by us.
 */
async function bridgeIsUp() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: BRIDGE_PORT, path: '/health', timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * How long to wait for the bridge to answer after starting it.
 *
 * Generous: the bridge resolves yt-dlp and ffmpeg at startup, which can take a
 * few seconds on a cold filesystem cache.
 */
const START_TIMEOUT_MS = 25_000;

/** Poll until the bridge answers, or the deadline passes. */
async function waitForBridge(timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await bridgeIsUp()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Start the bridge so it outlives this request and shows no window.
 *
 * HOW THE CONSOLE INHERITANCE WORKS
 * ---------------------------------
 * The chain is launcher -> bridge -> yt-dlp -> ffmpeg, and we only control the
 * first hop. What decides whether ffmpeg pops a window is the console yt-dlp
 * inherits:
 *
 *   windowsHide: true   passes CREATE_NO_WINDOW. The child owns a console that
 *                       is hidden, and passes it on — so ffmpeg stays hidden.
 *   detached: true      passes DETACHED_PROCESS. The child has NO console, so
 *                       when it starts a console program Windows allocates a
 *                       fresh VISIBLE one — that was the flash.
 *
 * So: windowsHide on, detached off.
 *
 * WHY NOT `cmd /c start /b`
 * -------------------------
 * An earlier version wrapped the call in `cmd /c start /b "" <command>` to get
 * process independence. That is unreliable when spawned without a shell: `start`
 * treats its first quoted argument as a window title, so the real command line
 * ends up mis-parsed and the bridge silently fails to launch.
 *
 * Spawning node directly with `stdio: 'ignore'` is both simpler and correct: no
 * pipes tie it to this process, and it keeps the hidden console.
 */
function startBridge() {
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    cwd: path.join(root, 'server'),
    // Hidden console, inherited by yt-dlp and by the ffmpeg below it.
    windowsHide: true,
    // Windows must stay attached: detached allocates a visible console.
    // On macOS/Linux, detach so the bridge keeps running if this launcher restarts.
    detached: process.platform !== 'win32',
    // No pipes of our own, so the bridge is not tied to this request's lifetime.
    stdio: 'ignore',
    env: { ...process.env, YTD_LAUNCHED_BY: 'launcher' },
  });

  child.unref();
  bridge = child;
  writeState({ lastStart: Date.now(), pid: child.pid });
  return child.pid;
}

/**
 * Stop the bridge.
 *
 * We ask our own child first. If the bridge was started another way (by
 * start-bridge.cmd, or an earlier launcher run) we have no handle, so we fall
 * back to finding whatever owns the port.
 *
 * The fallback deliberately avoids `netstat` via cmd.exe: spawning a shell
 * flashes a console window on Windows, and parsing its output is fragile. A
 * plain TCP connect tells us whether anything is listening, and if a handle
 * exists we can signal it directly.
 */
async function stopBridge() {
  if (bridge && !bridge.killed && bridge.exitCode === null) {
    try {
      bridge.kill();
      bridge = null;
      return true;
    } catch {
      /* handle was stale; fall through */
    }
  }

  // On Windows, ask the OS for the owning PID without starting a shell.
  if (process.platform === 'win32') {
    const pid = await findPidOnPort(BRIDGE_PORT);
    if (pid) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // POSIX: find the listener via lsof, then signal it.
  return new Promise((resolve) => {
    const finder = spawn('lsof', ['-ti', `tcp:${BRIDGE_PORT}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    finder.stdout?.on('data', (d) => { out += d; });
    finder.on('close', () => {
      const pid = Number(out.trim().split('\n')[0]);
      if (!Number.isFinite(pid) || pid <= 0) return resolve(false);
      try {
        process.kill(pid, 'SIGTERM');
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    finder.on('error', () => resolve(false));
  });
}

/**
 * Find the PID listening on a local port, without spawning a shell.
 *
 * Uses PowerShell's Get-NetTCPConnection through a hidden window. We keep the
 * PowerShell call (rather than a native module) so there is no build step, but
 * we always pass windowsHide so no console appears.
 */
function findPidOnPort(port) {
  return new Promise((resolve) => {
    const script =
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -First 1 -ExpandProperty OwningProcess)';

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );

    let out = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.on('close', () => {
      const pid = Number.parseInt(out.trim(), 10);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
    child.on('error', () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// State (so the extension can show what happened)
// ---------------------------------------------------------------------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Only extension pages and localhost pages may drive the launcher.
 *
 * The browser sets Origin itself and a web page cannot forge it, so this stops
 * a random site from starting or stopping the user's bridge.
 */
function originAllowed(origin, req) {
  if (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin.startsWith('safari-web-extension://') ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return true;
  }
  // A service worker fetch to loopback sometimes omits Origin. Sec-Fetch-Site
  // is set by the browser and a web page cannot forge it; pages that POST
  // always send their own Origin, so a missing Origin plus "none" is the extension.
  const site = req?.headers?.['sec-fetch-site'];
  return !origin && site === 'none';
}

function cors(res, origin) {
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  cors(res, origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Unauthenticated liveness probe so the extension can tell "launcher is
  // installed and running" from "not installed at all".
  if (url.pathname === '/ping') {
    return json(res, 200, {
      ok: true,
      service: 'yt-downloader-launcher',
      version: '1.0.0',
      bridgePort: BRIDGE_PORT,
      bridgeUp: await bridgeIsUp(),
      platform: process.platform,
    });
  }

  // Everything below changes state, so it requires an allowed origin.
  if (!originAllowed(origin, req)) {
    return json(res, 403, { error: 'Origin not allowed' });
  }

  if (url.pathname === '/status') {
    return json(res, 200, {
      ok: true,
      bridgeUp: await bridgeIsUp(),
      ...readState(),
    });
  }

  if (url.pathname === '/start' && req.method === 'POST') {
    if (await bridgeIsUp()) {
      return json(res, 200, { ok: true, alreadyRunning: true });
    }

    let pid;
    try {
      pid = startBridge();
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }

    // Do not report success just because a process was spawned. An earlier
    // version did exactly that and returned ok:true while the bridge silently
    // failed to launch, so the extension said "started" and then could not
    // connect. Wait for it to actually answer before claiming anything.
    const ready = await waitForBridge(START_TIMEOUT_MS);
    if (ready) {
      return json(res, 200, { ok: true, pid });
    }

    return json(res, 502, {
      ok: false,
      pid,
      error:
        `The bridge did not start within ${Math.round(START_TIMEOUT_MS / 1000)}s. ` +
        'Run start-bridge.sh or start-bridge.cmd in a terminal to see the error.',
    });
  }

  if (url.pathname === '/stop' && req.method === 'POST') {
    const stopped = await stopBridge();
    return json(res, 200, { ok: stopped });
  }

  return json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, HOST, () => {
  writeState({ startedAt: Date.now(), pid: process.pid, port: PORT });
  // Bring the bridge up with the launcher, so opening the extension finds it
  // already running. If it is down later, the popup asks /start again.
  bridgeIsUp().then((up) => {
    if (!up) {
      try { startBridge(); } catch (err) {
        console.error('  Could not start bridge:', err.message);
      }
    }
  });
  console.log('');
  console.log('  YouTube Downloader launcher is running  /  启动器已就绪');
  console.log(`  Listening    http://${HOST}:${PORT}`);
  console.log(`  Bridge port  ${BRIDGE_PORT}`);
  console.log('');
  console.log('  The extension can now start the bridge by itself.');
  console.log('  扩展现在可以自行启动下载服务了。');
  console.log('');
  console.log('  Keep this window open.  /  请保持本窗口开启。');
  console.log('  Press Ctrl+C to stop.   /  按 Ctrl+C 停止。');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — the launcher is probably already running.`);
    console.error(`  端口 ${PORT} 已被占用，启动器可能已在运行。\n`);
  } else {
    console.error('\n  Launcher error  /  启动器错误:', err.message, '\n');
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  });
}
