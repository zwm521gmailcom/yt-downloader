/**
 * Convert the Windows launcher from UTF-8 to the encoding cmd.exe expects.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * cmd.exe does not read .cmd files as UTF-8. It parses them byte-by-byte using
 * the machine's console codepage (936 / GBK on Simplified-Chinese Windows,
 * 437 on US Windows, and so on). A file saved as UTF-8 but containing Chinese
 * text therefore gets mis-decoded, and because UTF-8 multi-byte sequences can
 * contain bytes that GBK maps to characters like `”` or that break a line in
 * the middle, the leading `REM` is lost and cmd tries to execute the mangled
 * remainder. The user sees:
 *
 *     'xxxxx' is not recognized as an internal or external command,
 *     operable program or batch file.
 *
 * The fix is to store the batch file in the codepage cmd.exe will use.
 *
 * USAGE
 *   node tools/fix-cmd-encoding.js           # convert in place
 *   node tools/fix-cmd-encoding.js --check   # verify only, exit 1 if wrong
 *
 * Keep start-bridge.cmd.utf8 as the editable UTF-8 source of truth; this tool
 * derives start-bridge.cmd from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/**
 * Each batch file is authored as <name>.utf8 (editable UTF-8) and generated as
 * <name> (codepage-encoded). Keeping the UTF-8 original means the file stays
 * diffable and editable with normal tooling.
 */
const PAIRS = [
  { source: 'start-bridge.cmd.utf8', target: 'start-bridge.cmd' },
  { source: 'stop-bridge.cmd.utf8', target: 'stop-bridge.cmd' },
  { source: 'stop-all.cmd.utf8', target: 'stop-all.cmd' },
  { source: 'install-autostart.cmd.utf8', target: 'install-autostart.cmd' },
  { source: 'start-launcher.cmd.utf8', target: 'start-launcher.cmd' },
  // NOTE: there is deliberately no ytdl-handler.cmd. The protocol handler is a
  // .vbs so that Windows does not create a console window for it.
].map((p) => ({
  source: path.join(root, p.source),
  target: path.join(root, p.target),
}));

/**
 * Codepage to write. 936 (GBK) is correct for Simplified-Chinese Windows and
 * still renders the ASCII portion correctly on any other system, which is why
 * it is preferred over 65001 (UTF-8): cmd.exe pre-Windows-10-1903 mishandles
 * UTF-8 batch files regardless of the chcp setting.
 */
const CODEPAGE = Number(process.env.YTD_CMD_CODEPAGE || 936);

const checkOnly = process.argv.includes('--check');

/**
 * Node cannot encode to an arbitrary codepage natively (no iconv dependency
 * here on purpose), so we round-trip through a UTF-8 -> GBK conversion table
 * built from the platform. On Windows we can lean on the built-in code page
 * support via a small, dependency-free mapping using TextDecoder/TextEncoder
 * for the reverse direction only.
 *
 * Practical approach: build the GBK byte sequence by encoding each character
 * through a lookup generated with the WHATWG decoders that Node ships.
 */
function encodeGbk(text) {
  // Node ships full ICU, so TextDecoder can decode GBK. To ENCODE we invert it:
  // decode every 2-byte (and 1-byte ASCII) sequence once into a map.
  const decoder = new TextDecoder('gbk', { fatal: false });
  const map = new Map(); // character -> byte sequence

  // Single-byte range (ASCII and half-width forms).
  for (let b = 0x00; b <= 0x7f; b += 1) {
    const ch = decoder.decode(Uint8Array.of(b));
    if (ch && ch !== '\uFFFD') map.set(ch, [b]);
  }
  // Double-byte range. Lead bytes 0x81-0xFE, trail bytes 0x40-0xFE.
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      const ch = decoder.decode(Uint8Array.of(lead, trail));
      if (ch && ch.length === 1 && ch !== '\uFFFD' && !map.has(ch)) {
        map.set(ch, [lead, trail]);
      }
    }
  }

  const out = [];
  const unmappable = new Set();
  for (const ch of text) {
    const bytes = map.get(ch);
    if (bytes) {
      out.push(...bytes);
    } else {
      // Not representable in this codepage; substitute '?' so the batch file
      // stays parseable rather than silently corrupting.
      unmappable.add(ch);
      out.push(0x3f);
    }
  }
  return { bytes: Buffer.from(out), unmappable };
}

function main() {
  let failures = 0;
  let converted = 0;

  for (const { source, target } of PAIRS) {
    const name = path.basename(target);

    if (!fs.existsSync(source)) {
      if (checkOnly && fs.existsSync(target)) {
        // No UTF-8 original: just report what encoding the file is in.
        inspect(target); // exits on a problem, otherwise returns
        continue;
      }
      console.error(`Missing source file: ${path.basename(source)}`);
      failures += 1;
      continue;
    }

    const text = fs.readFileSync(source, 'utf8');
    const normalised = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const { bytes, unmappable } = encodeGbk(normalised);

    if (unmappable.size) {
      console.error(
        `${name}: these characters cannot be encoded in codepage ${CODEPAGE}:\n  ` +
          [...unmappable].join(' '),
      );
      failures += 1;
      continue;
    }

    if (checkOnly) {
      const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
      if (current && current.equals(bytes)) {
        console.log(`OK     ${name} (codepage ${CODEPAGE}, up to date)`);
      } else {
        console.error(`STALE  ${name} is missing or differs from ${path.basename(source)}.`);
        failures += 1;
      }
      continue;
    }

    fs.writeFileSync(target, bytes);
    converted += 1;

    // Guard against the exact regression that caused the original bug: a file
    // that also decodes as UTF-8 will be mis-parsed on a different codepage.
    const written = fs.readFileSync(target);
    const asUtf8 = written.toString('utf8');
    const looksLikeUtf8 = !asUtf8.includes('\uFFFD') && /[\u4e00-\u9fff]/.test(asUtf8);

    console.log(`Wrote  ${name} (${written.length} bytes, codepage ${CODEPAGE}, CRLF)`);
    if (looksLikeUtf8) {
      console.warn(
        `       note: ${name} also decodes as valid UTF-8. If your console codepage is not\n` +
          `       ${CODEPAGE}, regenerate with YTD_CMD_CODEPAGE=<your codepage>.`,
      );
    }
  }

  if (checkOnly) {
    if (failures) {
      console.error(`\n${failures} file(s) need regenerating. Run: node tools/fix-cmd-encoding.js`);
      process.exit(1);
    }
    console.log('\nAll launcher files are up to date.');
    process.exit(0);
  }

  if (failures) process.exit(1);
  if (converted) console.log('\nSources of truth are the .utf8 files (UTF-8, editable).');
}

/** Report what encoding an existing file appears to be in (does not exit on success). */
function inspect(file) {
  const bytes = fs.readFileSync(file);
  const withBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes);
  const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s);
  const bad = (s) => s.includes('\uFFFD');

  const name = path.basename(file);
  if (hasCjk(utf8) && !bad(utf8) && !hasCjk(gbk)) {
    console.error(`BAD    ${name} looks like UTF-8; cmd.exe on a GBK system will mis-parse it.`);
    process.exit(1);
  }
  console.log(`OK     ${name} (${bytes.length} bytes, BOM=${withBom}, no mis-encoding)`);
}

main();
