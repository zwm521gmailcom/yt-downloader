/**
 * Probe the Douyin video page inside an already-running browser.
 *
 * Unlike drive-douyin.mjs this attaches to a browser the user already has
 * open, over CDP on port 9222. That matters: the point of the exercise is to
 * use the real profile, which already carries the device identity, TLS
 * behaviour and login state that Douyin's risk control expects. A fresh
 * profile gets served "验证码中间页" instead of the video page.
 *
 * Launch the browser first, for example:
 *   QQBrowser.exe --remote-debugging-port=9222 --remote-allow-origins=* about:blank
 *
 * Usage:
 *   node tools/probe-douyin-live.mjs "https://www.douyin.com/video/<id>"
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const TARGET_URL = process.argv[2] || 'https://www.douyin.com/video/7696239495441044874';
const WARM_MS = Number(process.env.WARM_MS || 12000);
const PLAY_MS = Number(process.env.PLAY_MS || 25000);

const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method && this.#listeners.has(msg.method)) {
        for (const fn of this.#listeners.get(msg.method)) {
          try { fn(msg.params); } catch { /* listener must not break the run */ }
        }
      }
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CDP(ws);
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 60_000);
    });
  }

  close() { try { this.#ws.close(); } catch { /* ignore */ } }
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------

const stateExpr = `JSON.stringify({
  url: location.href,
  title: document.title,
  captcha: /验证码|captcha/i.test(document.title),
  renderData: typeof window.RENDER_DATA,
  bdms: typeof window.bdms,
  acrawler: typeof window.byted_acrawler,
  videos: document.querySelectorAll('video').length,
  fetchNative: String(window.fetch).includes('[native code]'),
})`;

let cdp;
try {
  const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  log(`  attached to: ${version.Browser}`);
  log(`  UA: ${version['User-Agent']}`);

  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target found');
  log(`  target: ${page.url || '(blank)'}`);

  cdp = await CDP.attach(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Runtime.enable');

  // Record every request; the player's media fetch is what we are after.
  const requests = [];
  const media = [];
  const api = [];
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    const u = request.url || '';
    if (requests.length < 3000) requests.push(u);
    if (/douyinvod\.com|idouyinvod|\/video\/tos\/|mime_type=video|\.mp4(\?|$)/i.test(u)) {
      if (!media.includes(u)) media.push(u);
    }
    if (/\/aweme\/v1\/web\//.test(u)) {
      if (!api.includes(u)) api.push(u);
    }
  });

  const state = async (label) => {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: stateExpr, returnByValue: true,
      });
      const s = JSON.parse(r.result.value);
      log(`  [${label}] title=${JSON.stringify(s.title)} captcha=${s.captcha} `
        + `renderData=${s.renderData} bdms=${s.bdms} videos=${s.videos} fetchNative=${s.fetchNative}`);
      return s;
    } catch (e) { log(`  [${label}] state failed: ${e.message}`); return null; }
  };

  // ---- warm up on the homepage ------------------------------------------
  log('\n  warming up on the homepage...');
  await cdp.send('Page.navigate', { url: 'https://www.douyin.com/' });
  await sleep(WARM_MS);
  await state('home');

  // ---- the video page ----------------------------------------------------
  log(`\n  navigating to the video page...`);
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(6000);

  let s = await state('video');
  // Give the SPA time to boot its SDK.
  for (let i = 0; i < 12 && s && !(s.renderData === 'object' && s.bdms === 'object'); i += 1) {
    await sleep(3000);
    s = await state(`video+${(i + 1) * 3}s`);
  }

  // ---- start playback ----------------------------------------------------
  log('\n  starting playback...');
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const v = document.querySelector('video');
      if (!v) return 'no video';
      try { v.muted = true; } catch {}
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      return JSON.stringify({ src: String(v.src).slice(0, 200), blob: String(v.src).startsWith('blob:') });
    })()`,
    returnByValue: true,
  }).then((r) => log('    ' + r.result.value)).catch((e) => log('    ' + e.message));

  // Click the video area too: Douyin often needs a gesture.
  for (const [x, y] of [[700, 500], [700, 400]]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    }).catch(() => {});
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    }).catch(() => {});
    await sleep(1200);
  }

  const deadline = Date.now() + PLAY_MS;
  while (Date.now() < deadline && media.length === 0) await sleep(2000);

  // ---- extract page-side data -------------------------------------------
  const extract = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = { video: [], renderPaths: [], resourceMedia: [] };
      for (const v of document.querySelectorAll('video')) {
        out.video.push({
          src: String(v.src || '').slice(0, 300),
          currentSrc: String(v.currentSrc || '').slice(0, 300),
          blob: String(v.src || '').startsWith('blob:'),
          w: v.videoWidth, h: v.videoHeight, paused: v.paused,
        });
      }
      try {
        for (const e of performance.getEntriesByType('resource')) {
          if (/douyinvod\\.com|\\/video\\/tos\\/|mime_type=video/i.test(e.name)) {
            out.resourceMedia.push(e.name.slice(0, 300));
          }
        }
      } catch {}
      try {
        const raw = window.RENDER_DATA;
        const d = typeof raw === 'string' ? JSON.parse(decodeURIComponent(raw)) : raw;
        const walk = (n, p, depth) => {
          if (!n || depth > 10 || out.renderPaths.length > 40) return;
          if (typeof n === 'string') {
            if (/douyinvod|v0d00|\\/video\\/tos\\//.test(n)) out.renderPaths.push(p + ' = ' + n.slice(0, 150));
            return;
          }
          if (typeof n !== 'object') return;
          if (Array.isArray(n)) { n.slice(0, 2).forEach((x, i) => walk(x, p + '[' + i + ']', depth + 1)); return; }
          for (const k of Object.keys(n).slice(0, 30)) walk(n[k], p + '.' + k, depth + 1);
        };
        walk(d, 'RENDER_DATA', 0);
      } catch (e) { out.renderError = String(e).slice(0, 150); }
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  }).catch((e) => { log('  extract failed: ' + e.message); return null; });

  // ---- report ------------------------------------------------------------
  log('\n' + '='.repeat(70));
  log('  RESULT');
  log('='.repeat(70));
  log(`  requests seen   : ${requests.length}`);
  log(`  media requests  : ${media.length}`);
  log(`  aweme API calls : ${api.length}`);

  if (media.length) {
    log('\n  *** MEDIA URLS (these are the deliverable) ***');
    media.slice(0, 5).forEach((u, i) => {
      log(`  [${i}] ${u}`);
      log(`      length=${u.length}`);
    });
  }

  if (api.length) {
    log('\n  Aweme API endpoints the page called:');
    api.slice(0, 5).forEach((u) => log('  ' + u.slice(0, 320)));
  }

  if (extract?.result?.value) {
    const d = JSON.parse(extract.result.value);
    log('\n  <video> elements:');
    log('  ' + JSON.stringify(d.video, null, 2));
    if (d.resourceMedia?.length) {
      log('\n  media in resource timing:');
      d.resourceMedia.slice(0, 5).forEach((u) => log('  ' + u));
    }
    if (d.renderPaths?.length) {
      log('\n  video-ish fields inside RENDER_DATA:');
      d.renderPaths.slice(0, 10).forEach((p) => log('  ' + p));
    } else {
      log('\n  RENDER_DATA: no video fields found' + (d.renderError ? ` (${d.renderError})` : ''));
    }
  }

  log('\n  final page state:');
  await state('final');
} catch (err) {
  log(`  FAILED: ${err.message}`);
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
}
