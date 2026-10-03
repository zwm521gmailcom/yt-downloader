/**
 * Pre-flight check. Run this if the extension says the bridge is unreachable.
 *
 *   node doctor.js
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
import { checkBinaries, getYtDlpPath } from './ytdlp.js';

const execFileAsync = promisify(execFile);
const results = [];
let failures = 0;

function pass(label, detail) {
  results.push({ ok: true, label, detail });
}
function fail(label, detail, hint) {
  failures += 1;
  results.push({ ok: false, label, detail, hint });
}

// 1. Node version -----------------------------------------------------------
const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major >= 18) pass('Node.js', `v${process.versions.node}`);
else fail('Node.js', `v${process.versions.node} is too old`, 'Install Node.js 18 or newer from https://nodejs.org');

// 2 + 3. yt-dlp and ffmpeg ---------------------------------------------------
// Use the same resolver the download path uses, so this report can never claim
// ffmpeg is available while downloads fail to find it.
const bins = await checkBinaries();

let ytDlpVersion = null;
if (bins.ytDlp.ok) {
  ytDlpVersion = bins.ytDlp.version;
  const label = ytDlpVersion || (bins.ytDlp.inconclusive ? '(version check skipped)' : 'found');
  pass('yt-dlp', `${label}  (${bins.ytDlp.path})`);
} else {
  fail('yt-dlp', bins.ytDlp.error || 'not runnable',
    'Install it:  winget install yt-dlp.yt-dlp   |   pip install -U yt-dlp');
}

if (bins.ffmpeg.ok) {
  const label = bins.ffmpeg.version || (bins.ffmpeg.inconclusive ? '(version check skipped)' : 'found');
  pass('ffmpeg', `${label}  (${bins.ffmpeg.path})`);
} else {
  fail('ffmpeg', bins.ffmpeg.error || 'not runnable',
    'Install it:  winget install Gyan.FFmpeg   |   brew install ffmpeg');
}

// 4. Download directory -----------------------------------------------------
try {
  fs.mkdirSync(config.downloadDir, { recursive: true });
  fs.accessSync(config.downloadDir, fs.constants.W_OK);
  pass('Download folder', `${config.downloadDir} (writable)`);
} catch (err) {
  fail('Download folder', String(err.message), `Set a different folder:  set YTD_DOWNLOAD_DIR=D:\\Videos`);
}

// 5. Cookie dir -------------------------------------------------------------
try {
  fs.mkdirSync(config.cookieDir, { recursive: true });
  pass('Cookie folder', config.cookieDir);
} catch (err) {
  fail('Cookie folder', String(err.message), 'Set YTD_COOKIE_DIR to a writable path');
}

// 6. Port availability ------------------------------------------------------
try {
  const net = await import('node:net');
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.once('listening', () => srv.close(resolve));
    srv.listen(config.port, config.host);
  });
  pass('Port', `${config.host}:${config.port} is free`);
} catch {
  // A used port is not fatal — the bridge may already be running.
  pass('Port', `${config.host}:${config.port} is in use (bridge probably already running)`);
}

// 7. Live extraction test ---------------------------------------------------
if (ytDlpVersion) {
  try {
    const { stdout } = await execFileAsync(
      getYtDlpPath(),
      ['--ignore-config', '--no-warnings', '--dump-single-json', '--no-download',
       'https://www.youtube.com/watch?v=aqz-KE-bpKQ'],
      { timeout: 90000, maxBuffer: 32 * 1024 * 1024 },
    );
    const info = JSON.parse(stdout);
    const heights = [...new Set((info.formats || []).map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);
    pass('YouTube extraction', `OK — "${info.title}" — qualities: ${heights.slice(0, 6).join('p, ')}p`);
  } catch (err) {
    const message = String(err.stderr || err.message || err).split('\n').filter(Boolean).slice(-1)[0];
    fail(
      'YouTube extraction',
      message,
      'If this mentions "not a bot", enable browser cookies in the extension settings.',
    );
  }
}

// 8. Report -----------------------------------------------------------------
console.log('');
console.log('  YouTube Downloader bridge — diagnostics');
console.log('  YouTube 下载器本地服务 — 环境诊断');
console.log('  ' + '─'.repeat(58));
for (const r of results) {
  console.log(`  ${r.ok ? '[ OK ]' : '[FAIL]'}  ${r.label.padEnd(18)} ${r.detail ?? ''}`);
  if (!r.ok && r.hint) console.log(`          -> ${r.hint}`);
}
console.log('  ' + '─'.repeat(58));
console.log(`  Platform: ${process.platform} ${os.arch()}   Node: ${process.versions.node}`);
console.log(
  failures === 0
    ? '  All checks passed. Start the bridge with:  node server.js\n    全部检查通过。启动服务：node server.js\n'
    : `  ${failures} check(s) failed. Fix the items above, then re-run:  node doctor.js\n` +
      `  ${failures} 项检查未通过。请先解决上述问题，然后重新运行：node doctor.js\n`,
);
process.exit(failures === 0 ? 0 : 1);
