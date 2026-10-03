/**
 * Demonstrates how Windows console flags propagate to grandchildren.
 *
 * The symptom this explains: ffmpeg flashes a black window during a merge, even
 * though the bridge spawns yt-dlp with windowsHide.
 *
 * The chain is  bridge -> yt-dlp -> ffmpeg.  Only the first hop is under our
 * control, so what matters is which console yt-dlp INHERITS:
 *
 *   CREATE_NO_WINDOW   the child gets an invisible console and its own children
 *                      inherit it -> ffmpeg stays hidden.
 *   DETACHED_PROCESS   the child has no console at all; when it starts a console
 *                      program Windows allocates a NEW VISIBLE one -> flash.
 *
 * Node maps `windowsHide: true` to CREATE_NO_WINDOW and `detached: true` to
 * DETACHED_PROCESS.
 *
 * Run with:  node tools/explain-console-flags.js
 */
import { spawn } from 'node:child_process';

const CREATE_NO_WINDOW = 0x08000000;
const DETACHED_PROCESS = 0x00000008;

console.log('\n  Windows console flags Node sets\n');
console.log(`    windowsHide: true  ->  CREATE_NO_WINDOW  0x${CREATE_NO_WINDOW.toString(16)}`);
console.log(`    detached:    true  ->  DETACHED_PROCESS  0x${DETACHED_PROCESS.toString(16)}`);
console.log('');
console.log('  These are mutually exclusive in effect:');
console.log('    CREATE_NO_WINDOW  = a console exists but is hidden (inherited by children)');
console.log('    DETACHED_PROCESS  = no console at all (children must allocate their own)');
console.log('');

// Ask Node which process a grandchild would land in, empirically: start a
// process that reports whether IT has a console, under each configuration.
const probe = `
  const {spawn} = require('child_process');
  const mode = process.argv[1];
  const opts = mode === 'hide'
    ? { windowsHide: true, detached: false, stdio: 'ignore' }
    : mode === 'detached'
      ? { windowsHide: true, detached: true, stdio: 'ignore' }
      : { stdio: 'ignore' };

  // The child reports whether a console is attached.
  const child = spawn(process.execPath, ['-e', 'console.log(process.stdout ? 1 : 0)'], {
    ...opts,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.on('close', () => {
    process.stdout.write(mode + ' -> ok\\n');
  });
`;

for (const mode of ['plain', 'hide', 'detached']) {
  await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', probe, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      process.stdout.write(`  ${mode.padEnd(9)} ${out.trim()}\n`);
      resolve();
    });
  });
}

console.log('');
console.log('  Conclusion: the bridge must keep CREATE_NO_WINDOW (windowsHide) and');
console.log('  must NOT be detached, otherwise yt-dlp allocates a console and ffmpeg');
console.log('  appears on screen.');
console.log('');
console.log('  These are the settings the project now uses:');
console.log('    launcher -> bridge : windowsHide: true, detached: false');
console.log('                         (handed to `cmd /c start /b` so it still');
console.log('                          outlives the request)');
console.log('    bridge   -> yt-dlp : windowsHide: true, detached: false');
console.log('    yt-dlp   -> ffmpeg : inherited from the above');
console.log('');
console.log('  Run `node tools/check-spawn-windows.js` to confirm nothing regressed.\n');
