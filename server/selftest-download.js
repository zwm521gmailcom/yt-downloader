/**
 * End-to-end download check.
 *
 * Run this from a NORMAL terminal (not a sandboxed one):
 *
 *   node server/selftest-download.js
 *
 * It talks to a running bridge, downloads the smallest video and an MP3, and
 * reports whether the resulting files exist on disk with a plausible size.
 * That last part matters: earlier the bridge reported "done" with a 0-byte
 * size and a path that did not exist, because the filename had been corrupted
 * during decoding.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.YTD_PORT || 8765);
const VIDEO = process.argv[2] || 'RJj9JxH4Mu4';

function request(method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers: {
          ...(token ? { 'X-YTD-Token': token } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runJob(token, spec, label) {
  const { body } = await request('POST', '/download', { token, body: spec });
  const id = body?.job?.id;
  if (!id) throw new Error(`could not queue ${label}: ${JSON.stringify(body)}`);

  const deadline = Date.now() + 15 * 60 * 1000;
  let job = null;
  let last = '';

  while (Date.now() < deadline) {
    await sleep(2000);
    const { body: polled } = await request('GET', `/jobs/${id}`, { token });
    job = polled?.job;
    if (!job) continue;

    const line = `${job.status} ${Math.round(job.progress || 0)}% ${job.speed || ''}`;
    if (line !== last) {
      process.stdout.write(`\r    ${label}: ${line}`.padEnd(70));
      last = line;
    }
    if (['done', 'failed', 'cancelled'].includes(job.status)) break;
  }
  process.stdout.write('\n');

  return job;
}

function verify(job, label) {
  const problems = [];

  if (!job) {
    problems.push('no job returned');
    return problems;
  }
  if (job.status !== 'done') {
    problems.push(`status is "${job.status}"${job.error ? `: ${job.error}` : ''}`);
    return problems;
  }
  if (!job.filePath) {
    problems.push('no file path reported');
    return problems;
  }
  // The original bug: the path existed as a string but the file did not.
  if (!fs.existsSync(job.filePath)) {
    problems.push(`reported path does not exist on disk:\n      ${job.filePath}`);
    return problems;
  }

  const stat = fs.statSync(job.filePath);
  if (stat.size === 0) problems.push('file is 0 bytes');
  if (!job.fileSize) problems.push('fileSize is not reported to the UI');
  if (job.fileSize && job.fileSize !== stat.size) {
    problems.push(`fileSize ${job.fileSize} != actual ${stat.size}`);
  }
  if (/\uFFFD/.test(job.fileName || '')) {
    problems.push(`filename contains replacement characters (encoding bug): ${job.fileName}`);
  }

  console.log(`    -> ${job.fileName}`);
  console.log(`       ${(stat.size / 1024 / 1024).toFixed(2)} MB at ${job.filePath}`);
  return problems;
}

(async () => {
  console.log('\n  YouTube Downloader — download self-test\n');

  // 1. Bridge reachable?
  let health;
  try {
    ({ body: health } = await request('GET', '/health'));
  } catch (err) {
    console.error(`  Cannot reach the bridge on port ${PORT}: ${err.message}`);
    console.error('  Start it first:  start-bridge.cmd\n');
    process.exit(1);
  }

  const token = health.token;
  const bins = health.binaries || {};
  console.log(`  bridge        : ok (v${health.version})`);
  console.log(`  downloads to  : ${health.downloadDir}`);
  console.log(`  yt-dlp        : ${bins.ytDlp?.ok ? bins.ytDlp.version || 'present' : 'MISSING'}`);
  console.log(`  ffmpeg        : ${bins.ffmpeg?.ok ? bins.ffmpeg.version || 'present' : 'MISSING'}`);
  console.log('');

  const failures = [];

  // 2. Smallest video. 144p keeps the test quick while still exercising the
  //    download -> merge path when only a progressive stream exists.
  console.log('  [1/2] smallest video ...');
  const videoArgs = [
    '--ignore-config', '--no-warnings', '--dump-single-json', '--no-download',
    `https://www.youtube.com/watch?v=${VIDEO}`,
  ];
  // Probe through the bridge so we use the same extraction path as a download.
  const probe = await request('GET', `/probe?videoId=${encodeURIComponent(VIDEO)}`, { token });
  if (probe.body?.error) {
    console.error(`  probe failed: ${probe.body.error}`);
    process.exit(1);
  }
  const ladder = probe.body.formats?.ladder || [];
  const smallest = ladder.slice().sort((a, b) => a.height - b.height)[0];
  console.log(`    "${probe.body.title}"`);
  console.log(`    smallest quality: ${smallest ? smallest.label : 'unknown'}`);

  if (smallest) {
    const job = await runJob(token, {
      videoId: VIDEO,
      title: probe.body.title,
      mode: 'video',
      height: smallest.height,
      selector: smallest.selector,
      container: 'mp4',
    }, 'video');
    const problems = verify(job, 'video');
    if (problems.length) failures.push(['video', problems]);
  } else {
    failures.push(['video', ['no downloadable video format found']]);
  }

  // 3. MP3. This exercises ffmpeg's audio conversion rather than a plain copy.
  console.log('\n  [2/2] mp3 audio ...');
  const audioJob = await runJob(token, {
    videoId: VIDEO,
    title: probe.body.title,
    mode: 'audio',
    audioFormat: 'mp3',
  }, 'audio');
  const audioProblems = verify(audioJob, 'audio');
  if (audioProblems.length) failures.push(['audio', audioProblems]);

  // 4. Report.
  console.log('\n  ' + '-'.repeat(58));
  if (!failures.length) {
    console.log('  ALL CHECKS PASSED — both files downloaded and verified on disk.\n');
    process.exit(0);
  }

  console.log('  FAILURES:\n');
  for (const [label, problems] of failures) {
    console.log(`  ${label}:`);
    for (const p of problems) console.log(`    - ${p}`);
    console.log('');
  }
  process.exit(1);
})();
