/**
 * Renders a sample of every UI surface in both languages, so the wording can be
 * eyeballed without loading the extension in a browser.
 *
 *   node tools/preview-i18n.js
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const i18nPath = path.join(here, '..', 'extension', 'i18n.js');
const { t, setLanguage } = await import(pathToFileURL(i18nPath).href);

/** Keys grouped the way the user meets them. */
const SCREENS = {
  'Popup — status': ['bridge_connected', 'bridge_not_running', 'checking_bridge', 'bridge_ytdlp_missing'],
  'Popup — help': ['help_title', 'help_intro', 'help_step1', 'help_step3', 'retry_connection'],
  'Popup — tabs & queue': ['tab_queue', 'tab_history', 'tab_signin', 'queue_empty', 'queue_hint', 'clear_finished'],
  'Popup — job states': ['status_queued', 'status_running', 'status_done', 'status_failed', 'status_cancelled'],
  'Popup — actions': ['act_cancel', 'act_save', 'act_folder', 'act_remove', 'act_retry'],
  'Popup — counters': ['queue_none_active', 'queue_downloading', 'queue_queued_n', 'time_just_now', 'time_min_ago'],
  'Popup — cookies': ['cookies_title', 'cookies_send', 'cookies_sent', 'cookies_delete', 'cookies_none'],
  'Options — language': ['lang_section', 'lang_label', 'lang_hint', 'lang_auto'],
  'Options — connection': ['conn_section', 'bridge_url', 'access_token', 'token_auto', 'test_connection', 'connected', 'cannot_reach'],
  'Options — health': ['health_error', 'health_fix', 'health_downloads', 'health_ytdlp', 'health_available', 'health_missing'],
  'Options — defaults': ['preferred_format', 'fmt_video', 'fmt_audio', 'fmt_thumb', 'preferred_quality', 'quality_hint'],
  'Options — post': ['embed_metadata', 'embed_metadata_desc', 'write_subtitles', 'sponsorblock', 'sponsorblock_desc'],
  'Options — overlay': ['overlay_show', 'overlay_position', 'pos_bottom_right', 'pos_top_left'],
  'Page button': ['ov_download', 'ov_video', 'ov_audio', 'ov_cover', 'ov_quality', 'ov_options', 'ov_queued_ok'],
  'Notifications': ['bg_notification_queued', 'bg_notification_queued_body', 'bg_saved_audio', 'bg_saved_video'],
  'Errors': ['err_spawn_denied', 'err_age_restricted', 'err_bot_check', 'err_format_gone', 'err_ffmpeg_missing'],
};

/** Values needing a placeholder, so the row shows realistic text. */
const VARS = {
  queue_downloading: { n: 2 },
  queue_queued_n: { n: 5 },
  time_min_ago: { n: 3 },
  cookies_sent: { n: 14 },
  bg_saved_video: { quality: '1080p' },
  ov_queued_ok: { quality: '1080p' },
};

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

/** Strip the one tag the dictionaries are allowed to contain. */
const strip = (s) => s.replace(/<\/?code>/g, '');

async function render(lang) {
  await setLanguage(lang, false);
  console.log(`\n${BOLD}${CYAN}════ ${lang === 'zh' ? '简体中文' : 'English'} ════${RESET}\n`);

  for (const [screen, keys] of Object.entries(SCREENS)) {
    console.log(`${BOLD}${screen}${RESET}`);
    for (const key of keys) {
      const value = strip(t(key, VARS[key]));
      console.log(`  ${DIM}${key.padEnd(26)}${RESET} ${value}`);
    }
    console.log('');
  }
}

const only = process.argv[2];
if (only === 'zh' || only === 'en') {
  await render(only);
} else {
  await render('en');
  await render('zh');
}
