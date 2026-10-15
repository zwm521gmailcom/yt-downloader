/**
 * End-to-end test of the direct-download path.
 *
 * Starts nothing itself: it expects the bridge to be running, posts a Douyin
 * job that carries a directUrl (as the extension would), waits for the job to
 * finish, and then checks the file that landed on disk is a real MP4.
 *
 * Usage:
 *   node tools/test-direct-download.mjs <mediaUrl> [referer]
 */
import fs from 'node:fs';
import path from 'node:path';

const mediaUrl = process.argv[2];
if (!mediaUrl) {
  console.error('usage: node test-direct-download.mjs <mediaUrl> [referer]');
  process.exit(1);
}
const referer = process.argv[3] || 'https://www.douyin.com/';
const PORT = process.env.YTD_PORT || 8765;

const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
console.log(`  bridge ${health.version}, token ${String(health.token).slice(0, 10)}…`);

const spec = {
  videoId: '7696239495441044874',
  url: 'https://www.douyin.com/video/7696239495441044874',
  title: '抖音直链下载测试',
  mode: 'video',
  qualityLabel: '抖音',
  directUrl: mediaUrl,
  referer,
};

const res = await fetch(`http://127.0.0.1:${PORT}/download`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-YTD-Token': health.token },
  body: JSON.stringify(spec),
}).then((r) => r.json());

// POST /download answers { job }, not { ok, id }.
const id = res?.job?.id ?? res?.id;
if (!id) {
  console.error('  enqueue failed:', JSON.stringify(res).slice(0, 400));
  process.exit(1);
}
console.log(`  job ${id} queued`);

// Poll until it settles.
let job = null;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  const j = await fetch(`http://127.0.0.1:${PORT}/jobs/${id}`, {
    headers: { 'X-YTD-Token': health.token },
  }).then((r) => r.json());
  job = j.job || j;
  const pct = job.progress != null ? `${job.progress.toFixed(1)}%` : '?';
  process.stdout.write(`\r  status=${job.status} ${pct} ${job.speed || ''} ${job.eta ? 'eta ' + job.eta : ''}      `);
  if (['done', 'failed', 'cancelled'].includes(job.status)) break;
}
console.log('\n');

console.log('  --- result ---');
console.log(`  status   : ${job.status}`);
console.log(`  filePath : ${job.filePath}`);
console.log(`  fileSize : ${job.fileSize}`);
if (job.error) console.log(`  error    : ${job.error}`);

if (job.status === 'done' && job.filePath && fs.existsSync(job.filePath)) {
  const stat = fs.statSync(job.filePath);
  const head = Buffer.alloc(16);
  const fd = fs.openSync(job.filePath, 'r');
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);

  const brand = head.subarray(4, 8).toString('ascii');
  console.log(`  on disk  : ${stat.size} bytes`);
  console.log(`  header   : ${head.toString('hex')}  (brand=${brand})`);
  console.log(`  is an mp4: ${brand === 'ftyp'}`);

  if (stat.size > 100_000 && brand === 'ftyp') {
    console.log('\n  ✅ DIRECT DOWNLOAD WORKS');
    // Leave the file for inspection but report where it is.
    console.log(`  file kept at: ${job.filePath}`);
    process.exit(0);
  }
  console.log('\n  ❌ file is not a usable mp4');
  process.exit(1);
}

console.log('\n  ❌ no file produced');
process.exit(1);
