/**
 * Finds anything that can flash a console window on Windows.
 *
 * Two very different mechanisms produce the same symptom:
 *
 *   1. Node spawning a child without `windowsHide: true`.
 *   2. A .cmd / .bat file being run — Windows executes batch files through
 *      cmd.exe, which creates a console at process start. Nothing in the batch
 *      file can prevent that; the fix is to not use a batch file on that path
 *      (use a .vbs host, which is GUI-subsystem).
 *
 * The second case is why a "protocol handler" registered as .cmd always flashed
 * a window no matter what the script did.
 *
 * Run with:  node tools/check-spawn-windows.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/** Directories that never run on the user's machine. */
const SKIP_DIRS = new Set(['tests', 'tools', 'downloads', 'node_modules', '.tmp']);

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const SPAWN_RE = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;

/** Opening a file manager must show a window: that is the feature. */
const INTENTIONALLY_VISIBLE = /spawn\(\s*['"](explorer\.exe|open|xdg-open)['"]/;

/** `pattern.exec(` is a regex call; the slice ends just before `exec`. */
const REGEX_EXEC = /\.\s*$/;

function callText(src, from) {
  let depth = 0;
  let i = src.indexOf('(', from);
  for (; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(from, i + 1);
}

let problems = 0;
let checked = 0;

// ---------------------------------------------------------------------------
// 1. Node spawn sites
// ---------------------------------------------------------------------------

for (const file of collect(root).filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);

  SPAWN_RE.lastIndex = 0;
  let match;
  while ((match = SPAWN_RE.exec(src)) !== null) {
    const start = match.index;
    if (REGEX_EXEC.test(src.slice(0, start))) continue;
    if (/import\s*$/.test(src.slice(Math.max(0, start - 8), start))) continue;

    const call = callText(src, start);
    checked += 1;
    if (INTENTIONALLY_VISIBLE.test(call)) continue;

    const line = src.slice(0, start).split('\n').length;

    if (!/windowsHide\s*:\s*true/.test(call)) {
      console.log(`  ${rel}:${line}  ${match[1]}(...)  -- no windowsHide: true`);
      problems += 1;
      continue;
    }

    // windowsHide + detached cancel each other out. DETACHED_PROCESS gives the
    // child no console, so anything IT starts must allocate a new (visible) one.
    // That is how ffmpeg ended up flashing even though yt-dlp was hidden.
    if (/detached\s*:\s*true/.test(call)) {
      console.log(`  ${rel}:${line}  ${match[1]}(...)  -- windowsHide AND detached: true`);
      console.log('      DETACHED_PROCESS defeats CREATE_NO_WINDOW: children of this');
      console.log('      process will allocate a visible console. Drop `detached`.');
      problems += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Batch files invoked from a hidden context
// ---------------------------------------------------------------------------

/**
 * A .cmd invoked by the browser, by a scheduled task, or by a VBS with a hidden
 * window style will still flash. We look for those invocations specifically:
 * `wscript`/`cscript` running a .cmd, or a registry command pointing at one.
 */
const BATCH_HOST_RE = /(?:wscript|cscript|wscript\.exe)\s+[^\r\n]*\.(?:cmd|bat)\b/i;

/** Strip VBScript comments so we test code, not prose describing the fix. */
function stripVbsComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("'")) return ''; // whole-line comment
      const idx = line.indexOf(" '"); // trailing comment after code
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

for (const file of collect(root).filter((f) => /\.(cmd|bat|vbs)$/i.test(f))) {
  const raw = fs.readFileSync(file);
  // .cmd files may be stored in the console codepage; latin1 keeps them readable
  // enough for the ASCII patterns we search for.
  const isVbs = /\.vbs$/i.test(file);
  const text = isVbs ? stripVbsComments(raw.toString('utf8')) : raw.toString('latin1');
  const rel = path.relative(root, file);
  checked += 1;

  if (BATCH_HOST_RE.test(text)) {
    console.log(`  ${rel}  -- a .cmd/.bat is launched via wscript/cscript`);
    console.log('      cmd.exe always creates a console; use a .vbs entry point instead.');
    problems += 1;
  }

  // A VBS that shells out to cmd /c <script>.cmd also flashes.
  if (isVbs && /shell\.Run\s+"cmd\.exe\s+\/c[^"]*\.(cmd|bat)/i.test(text)) {
    console.log(`  ${rel}  -- VBS delegates to a .cmd (cmd.exe will flash a console)`);
    problems += 1;
  }
}

// ---------------------------------------------------------------------------
// 3. The registered protocol handler
// ---------------------------------------------------------------------------

const installer = path.join(root, 'install-autostart.cmd.utf8');
if (fs.existsSync(installer)) {
  const src = fs.readFileSync(installer, 'utf8');

  // The registration spans two lines because of the caret continuation, and the
  // inner quotes are backslash-escaped:
  //   reg add "...\shell\open\command" /ve ^
  //     /d "wscript.exe \"%ROOT%ytdl-handler.vbs\" \"%%1\"" /f
  // Capture the whole /d value, stopping at the first quote that is not escaped.
  const registered = src.match(/shell\\open\\command"[\s\S]{0,400}?\/d\s+"((?:\\"|[^"])*)"/);
  checked += 1;

  const value = registered ? registered[1] : '';

  if (!value) {
    console.log('  install-autostart.cmd  -- could not find the protocol registration');
    problems += 1;
  } else if (/\.cmd/i.test(value)) {
    console.log('  install-autostart.cmd  -- registers a .cmd as the URL protocol handler');
    console.log('      Every ytdl:// launch will flash a console. Register a .vbs instead.');
    problems += 1;
  } else if (!/\.vbs/i.test(value)) {
    console.log('  install-autostart.cmd  -- protocol handler is not a .vbs');
    console.log(`      found: ${value}`);
    problems += 1;
  }
}

console.log('');
if (problems === 0) {
  console.log(`  OK  ${checked} check(s) passed; nothing can flash a console window.`);
  process.exit(0);
}
console.log(`  ${problems} problem(s) found.`);
process.exit(1);
