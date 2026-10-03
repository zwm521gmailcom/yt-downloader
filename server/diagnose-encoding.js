/**
 * Diagnostic: what encoding does yt-dlp actually write to a pipe?
 *
 * Run this from a NORMAL terminal (not a sandbox) to see the raw bytes:
 *
 *   node server/diagnose-encoding.js
 *
 * It prints the same title decoded several ways, so we can tell which one is
 * correct instead of guessing.
 */
import { spawn } from 'node:child_process';
import { getYtDlpPath } from './ytdlp.js';

const VIDEO = process.argv[2] || 'RJj9JxH4Mu4';

const child = spawn(getYtDlpPath(), [
  '--ignore-config',
  '--no-warnings',
  '--skip-download',
  '--print', '%(title)s',
  `https://www.youtube.com/watch?v=${VIDEO}`,
], { windowsHide: true });

const chunks = [];
child.stdout.on('data', (d) => chunks.push(d));
child.stderr.on('data', () => { /* ignore */ });

child.on('close', (code) => {
  const raw = Buffer.concat(chunks);
  const line = raw.subarray(0, raw.length - 1); // drop trailing newline

  console.log('');
  console.log('  exit code      :', code);
  console.log('  raw byte length:', raw.length);
  console.log('  first 24 bytes :', line.subarray(0, 24).toString('hex'));
  console.log('');

  const asUtf8 = new TextDecoder('utf-8').decode(line);
  const asGbk = new TextDecoder('gbk').decode(line);
  const repl = (s) => (s.match(/\uFFFD/g) || []).length;

  console.log('  UTF-8 decode :', JSON.stringify(asUtf8));
  console.log('    replacement chars:', repl(asUtf8));
  console.log('');
  console.log('  GBK decode   :', JSON.stringify(asGbk));
  console.log('    replacement chars:', repl(asGbk));
  console.log('');

  if (repl(asUtf8) === 0 && repl(asGbk) > 0) {
    console.log('  => yt-dlp writes UTF-8. LineDecoder will pick UTF-8. Correct.');
  } else if (repl(asGbk) === 0 && repl(asUtf8) > 0) {
    console.log('  => yt-dlp writes the ANSI codepage (GBK). LineDecoder falls back. Correct.');
  } else if (repl(asUtf8) === 0 && repl(asGbk) === 0) {
    console.log('  => both decode cleanly (pure ASCII, or ambiguous).');
  } else {
    console.log('  => NEITHER decodes cleanly. The bytes are already corrupted upstream,');
    console.log('     e.g. by console redirection in the launching shell.');
  }
  console.log('');
});
