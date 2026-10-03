/**
 * Internationalisation for the extension UI.
 *
 * We use our own dictionary rather than chrome.i18n because chrome.i18n
 * resolves the locale once at startup from the browser UI language and cannot
 * be switched at runtime. A user who wants English UI on a Chinese browser
 * (or vice versa) must be able to flip a setting and see it apply immediately.
 *
 * Usage:
 *   import { t, applyTo, setLanguage, getLanguage } from './i18n.js';
 *   t('popup_queue')                    -> 'Queue'
 *   applyTo(document)                   -> fills every [data-i18n] node
 *
 * Markup convention:
 *   data-i18n="key"          sets textContent
 *   data-i18n-title="key"    sets the title attribute
 *   data-i18n-placeholder="" sets the placeholder attribute
 *   data-i18n-aria="key"     sets aria-label
 */

export const LANGUAGES = [
  { code: 'auto', label: '跟随浏览器 / Auto' },
  { code: 'zh', label: '简体中文' },
  { code: 'en', label: 'English' },
];

export const DEFAULT_LANGUAGE = 'auto';

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

const en = {
  // ---- common ----------------------------------------------------------
  app_name: 'YouTube Downloader',
  save: 'Save',
  cancel: 'Cancel',
  retry: 'Retry',
  remove: 'Remove',
  close: 'Close',
  download: 'Download',
  queuing: 'Queuing…',
  queued: 'Queued',
  retry_connection: 'Retry connection',

  // ---- popup: header / status -----------------------------------------
  settings: 'Settings',
  checking_bridge: 'Checking bridge…',
  bridge_connected: 'Bridge connected',
  bridge_not_running: 'Bridge not running',
  bridge_ytdlp_missing: 'Bridge is running but yt-dlp was not found',
  bridge_ffmpeg_missing: 'ffmpeg missing (no merging or MP3)',
  how_to_start: 'How to start',
  reconnecting: 'Reconnecting…',

  // ---- popup: help box -------------------------------------------------
  help_title: 'The local bridge is not running',
  help_intro: 'Opening this popup starts the download service. If it does not come up, install the login helper once:',
  help_step1: 'Open the <code>yt-downloader</code> folder',
  help_step2: 'Run <code>{install}</code> once',
  help_step3: 'Reopen this popup — it will start the service by itself',
  launch_start: 'Start bridge',
  launch_starting: 'Starting the local bridge…',
  launch_waiting: 'Waiting for the bridge to come up…',
  launch_ok: 'Bridge started ✓',
  launch_failed: 'Could not start the bridge',
  launch_timeout: 'The bridge did not respond in time. Start it manually.',
  launch_no_token: 'No launch token yet. Run install-autostart.cmd once, then retry.',
  launch_unsupported: 'The launcher is not running. Run install-autostart once, then reopen this popup.',

  // ---- popup: current tab ---------------------------------------------
  reading_formats: 'Reading formats…',
  audio_only: 'Audio only',
  cover: 'Cover',
  no_formats: 'No downloadable formats found.',
  queued_see_tab: 'Queued {quality} — see the Queue tab.',
  failed_short: 'Failed',

  // ---- popup: tabs -----------------------------------------------------
  tab_queue: 'Queue',
  tab_history: 'History',
  tab_signin: 'Sign-in',

  // ---- popup: queue ----------------------------------------------------
  queue_empty: 'Nothing in the queue.',
  queue_hint: 'Open a YouTube video and click the red Download button on the page.',
  queue_none_active: 'No active downloads',
  queue_downloading: '{n} downloading',
  queue_queued_n: '{n} queued',
  clear_finished: 'Clear finished',
  history_subtitle: 'Completed and failed downloads',
  history_empty: 'No history yet.',
  open_folder: 'Open folder',

  // ---- popup: cookies --------------------------------------------------
  cookies_title: 'Signed-in downloads',
  cookies_body:
    'Some videos (age-restricted, private, members-only) and YouTube\'s ' +
    '"confirm you\'re not a bot" check require your browser session. ' +
    'Send your YouTube cookies to the local bridge so yt-dlp can use them.',
  cookies_send: 'Send my YouTube cookies',
  cookies_sending: 'Sending…',
  cookies_sent: 'Sent {n} cookies. Signed-in videos will now work.',
  cookies_privacy_title: 'Privacy',
  cookies_privacy_body:
    'Cookies are written to a local temp file readable only by the bridge, ' +
    'and are sent nowhere except to yt-dlp on this machine.',
  cookies_delete: 'Delete stored cookies',
  cookies_deleted: 'Stored cookies deleted.',
  cookies_none: 'No cookies stored',
  cookies_anonymous: 'anonymous',

  // ---- job states / actions -------------------------------------------
  status_queued: 'queued',
  status_running: 'running',
  status_done: 'done',
  status_failed: 'failed',
  status_cancelled: 'cancelled',
  act_cancel: 'Cancel',
  act_save: 'Save with browser',
  act_folder: 'Show in folder',
  act_remove: 'Remove from list',
  act_retry: 'Retry',
  folder_fell_back: 'That file is no longer at its recorded path — opened the downloads folder instead.',
  folder_failed: 'Could not open the folder.',
  eta: 'ETA',
  audio_label: 'audio',
  time_just_now: 'just now',
  time_min_ago: '{n} min ago',
  time_hours_ago: '{n} h ago',

  // ---- options: header -------------------------------------------------
  options_subtitle: 'Settings for downloads, quality defaults and sign-in.',
  welcome_banner:
    'Almost ready. Start the local service (<code>{script}</code>) ' +
    'and keep its window open, then verify the connection below.',

  // ---- options: language ----------------------------------------------
  lang_section: 'Language',
  lang_label: 'Interface language',
  lang_hint: 'Applies immediately to the popup, the page button and this page.',
  lang_auto: 'Follow browser',

  // ---- options: connection --------------------------------------------
  conn_section: 'Bridge connection',
  conn_body: 'The extension asks a small local service to run yt-dlp on your machine.',
  bridge_url: 'Bridge URL',
  access_token: 'Access token',
  token_hint: 'Printed in the bridge window on startup. Leave empty to detect it automatically.',
  test_connection: 'Test connection',
  testing: 'Testing…',
  connected: 'Connected',
  cannot_reach: 'Cannot reach the bridge',
  test_fix: 'Run {script} and keep the window open',
  health_downloads: 'downloads',
  health_ytdlp: 'yt-dlp',
  health_ffmpeg: 'ffmpeg',
  health_concurrency: 'concurrency',
  health_token: 'token',
  health_configured: 'configured',
  health_none: 'none',
  health_available: 'available',
  health_missing: 'missing',
  health_error: 'error',
  health_fix: 'fix',
  token_auto: 'auto-detected',
  sub_kind_auto: 'auto',
  sub_kind_manual: 'manual',
  chip_has_audio: '+ audio',
  chip_best_audio: '+ best audio',

  // ---- options: defaults ----------------------------------------------
  defaults_section: 'Download defaults',
  preferred_format: 'Preferred format',
  fmt_video: 'Video + audio',
  fmt_audio: 'Audio only',
  fmt_thumb: 'Cover image',
  preferred_quality: 'Preferred video quality',
  quality_hint: 'If unavailable, the next lower quality is used.',
  container: 'Container',
  container_mp4: 'MP4 (most compatible)',
  container_mkv: 'MKV (keeps any codec)',
  container_webm: 'WebM',
  audio_format: 'Audio format',

  // ---- options: post-processing ---------------------------------------
  post_section: 'Post-processing',
  embed_metadata: 'Embed metadata',
  embed_metadata_desc: 'Write title, channel and description into the file.',
  embed_thumbnail: 'Embed thumbnail',
  embed_thumbnail_desc: "Set the video's cover art as the file icon.",
  write_subtitles: 'Download subtitles',
  write_subtitles_desc: 'Save a subtitle file next to the video.',
  subtitle_format: 'Subtitle format',
  sub_srt: 'SRT (universal)',
  sub_vtt: 'VTT (web)',
  sub_ass: 'ASS (styled)',
  sponsorblock: 'Remove sponsor segments',
  sponsorblock_desc: 'Cut sponsored and self-promo sections using SponsorBlock.',

  // ---- options: overlay ------------------------------------------------
  overlay_section: 'Page button',
  overlay_show: 'Show a Download button on YouTube pages',
  overlay_show_desc: 'Floating button with a quality picker.',
  overlay_position: 'Button position',
  pos_bottom_right: 'Bottom right',
  pos_bottom_left: 'Bottom left',
  pos_top_right: 'Top right',
  pos_top_left: 'Top left',

  // ---- options: cookies ------------------------------------------------
  signin_section: 'Sign-in & cookies',
  signin_body:
    'Age-restricted, private and members-only videos — and YouTube\'s ' +
    '"confirm you\'re not a bot" check — need your signed-in browser session.',
  use_cookies: 'Use my YouTube cookies',
  use_cookies_desc: 'Let the bridge read the cookie file below.',
  cookie_profile: 'Cookie file name',
  cookie_send_now: 'Send my YouTube cookies now',
  cookie_delete: 'Delete stored cookies',
  cookie_fail: 'Failed to send cookies.',

  // ---- options: advanced / footer -------------------------------------
  advanced_section: 'Advanced',
  notify_complete: 'Notify when a download finishes',
  notify_complete_desc: 'Desktop notification with the file name.',
  save_settings: 'Save settings',
  saved: 'Saved ✓',
  save_failed: 'Could not save',
  saved_cookies_hint: 'Sent {n} cookies to the bridge. Signed-in downloads will now work.',

  // ---- overlay (page button) ------------------------------------------
  ov_download: 'Download',
  ov_video: 'Video',
  ov_audio: 'Audio',
  ov_cover: 'Cover',
  ov_quality: 'Quality',
  ov_options: 'Options',
  ov_save_subs: 'Save subtitles',
  ov_embed_thumb: 'Embed thumbnail',
  ov_sponsor: 'Remove sponsor segments',
  ov_sub_lang: 'Subtitle language',
  ov_audio_format: 'Audio format',
  ov_source_stream: 'Source stream',
  ov_cover_note: 'Saves the highest-resolution cover image as JPG.',
  ov_single_format: 'This site provides a single video file — the best quality is used automatically.',
  ov_no_media: 'No downloadable video found on this page.',
  ov_adding: 'Adding to queue…',
  ov_queued_ok: 'Queued: {quality} — track progress in the extension popup.',
  ov_queued_btn: 'Queued ✓',
  ov_reading: 'Reading available formats…',
  ov_no_video: 'No video found on this page.',
  ov_no_video_formats: 'No video formats found.',

  // ---- background messages --------------------------------------------
  bg_notification_queued: 'Download queued',
  bg_notification_queued_body: 'The default quality has been added to the queue.',
  bg_notification_failed: 'Download failed',
  bg_saved_audio: 'Audio saved',
  bg_saved_video: '{quality} saved',
  bg_saved_generic: 'Download finished',
  bg_bridge_unreachable:
    'Cannot reach the download bridge at {url}. Make sure the bridge is running (start-bridge script) and try again.',
  bg_no_video: 'No YouTube video was detected on this page.',
  bg_live_stream: 'Live streams cannot be downloaded until the broadcast ends.',
  bg_no_cookies: 'No YouTube cookies found. Open youtube.com and sign in, then try again.',
  bg_no_file: 'The bridge has no finished file for this download.',

  // ---- bridge errors (surfaced verbatim in the queue) ------------------
  err_spawn_denied:
    'The bridge could not start yt-dlp (permission denied). If you are running inside a restricted or sandboxed shell, run the bridge normally instead. Otherwise check that yt-dlp is not blocked by antivirus, and set YTD_YTDLP to its full path.',
  err_ytdlp_missing:
    'yt-dlp was not found. Install it (winget install yt-dlp.yt-dlp) and restart the bridge, or set YTD_YTDLP to the full path of yt-dlp.exe.',
  err_age_restricted:
    'This video is age-restricted. Send your YouTube cookies from the extension and retry.',
  err_bot_check:
    'YouTube asked this request to prove it is not a bot. Open the extension settings and enable "Use browser cookies", then retry.',
  err_unavailable: 'This video is unavailable (removed, region-locked, or private).',
  err_private: 'This is a private video. Sign in via browser cookies to download it.',
  err_members_only:
    'This video is members-only. Browser cookies from a subscribed account are required.',
  err_format_gone:
    'The requested quality is no longer available for this video. Pick a different quality.',
  err_ffmpeg_missing:
    'ffmpeg was not found, so separate video and audio streams cannot be merged. Install ffmpeg and restart the bridge service.',
  err_unsupported_url: 'That URL is not a supported YouTube video link.',
  err_unknown: 'Unknown yt-dlp failure',
};

const zh = {
  // ---- common ----------------------------------------------------------
  app_name: 'YouTube 视频下载器',
  save: '保存',
  cancel: '取消',
  retry: '重试',
  remove: '移除',
  close: '关闭',
  download: '下载',
  queuing: '正在加入队列…',
  queued: '已排队',
  retry_connection: '重新连接',

  // ---- popup: header / status -----------------------------------------
  settings: '设置',
  checking_bridge: '正在检测本地服务…',
  bridge_connected: '本地服务已连接',
  bridge_not_running: '本地服务未运行',
  bridge_ytdlp_missing: '本地服务已运行，但未找到 yt-dlp',
  bridge_ffmpeg_missing: '缺少 ffmpeg（无法合并或转 MP3）',
  how_to_start: '如何启动',
  reconnecting: '正在重新连接…',

  // ---- popup: help box -------------------------------------------------
  help_title: '本地下载服务未运行',
  help_intro: '打开本弹窗时会自动启动下载服务。如果没有起来，安装一次登录自启：',
  help_step1: '打开 <code>yt-downloader</code> 文件夹',
  help_step2: '执行一次 <code>{install}</code>',
  help_step3: '重新打开本弹窗，服务会自己启动',
  launch_start: '启动服务',
  launch_starting: '正在启动本地服务…',
  launch_waiting: '正在等待服务就绪…',
  launch_ok: '服务已启动 ✓',
  launch_failed: '无法启动服务',
  launch_timeout: '服务未在规定时间内响应，请手动启动。',
  launch_no_token: '尚无启动令牌。请先运行一次 install-autostart.cmd 再重试。',
  launch_unsupported: '启动器未在运行。请在项目目录执行一次安装脚本（macOS 用 ./install-autostart.sh），之后打开插件会自动启动服务。',

  // ---- popup: current tab ---------------------------------------------
  reading_formats: '正在读取可用格式…',
  audio_only: '仅音频',
  cover: '封面',
  no_formats: '未找到可下载的格式。',
  queued_see_tab: '已加入队列：{quality} — 可在「队列」中查看进度。',
  failed_short: '失败',

  // ---- popup: tabs -----------------------------------------------------
  tab_queue: '队列',
  tab_history: '历史',
  tab_signin: '登录',

  // ---- popup: queue ----------------------------------------------------
  queue_empty: '队列为空。',
  queue_hint: '打开一个 YouTube 视频，点击页面上的红色「下载」按钮。',
  queue_none_active: '当前没有下载任务',
  queue_downloading: '{n} 个下载中',
  queue_queued_n: '{n} 个排队中',
  clear_finished: '清除已完成',
  history_subtitle: '已完成与失败的下载',
  history_empty: '暂无历史记录。',
  open_folder: '打开文件夹',

  // ---- popup: cookies --------------------------------------------------
  cookies_title: '登录后才能下载的视频',
  cookies_body:
    '部分视频（年龄限制、私享、会员专属）以及 YouTube 的' +
    '「确认你不是机器人」验证需要你的浏览器登录状态。' +
    '把 YouTube cookies 发送给本地服务，yt-dlp 就能使用它。',
  cookies_send: '发送我的 YouTube cookies',
  cookies_sending: '正在发送…',
  cookies_sent: '已发送 {n} 条 cookies，现在可以下载需要登录的视频了。',
  cookies_privacy_title: '隐私说明',
  cookies_privacy_body:
    'cookies 只会写入一个仅本地服务可读的临时文件，' +
    '除了本机的 yt-dlp 之外不会发送到任何地方。',
  cookies_delete: '删除已保存的 cookies',
  cookies_deleted: '已删除保存的 cookies。',
  cookies_none: '尚未保存 cookies',
  cookies_anonymous: '匿名',

  // ---- job states / actions -------------------------------------------
  status_queued: '排队中',
  status_running: '下载中',
  status_done: '已完成',
  status_failed: '失败',
  status_cancelled: '已取消',
  act_cancel: '取消',
  act_save: '用浏览器保存',
  act_folder: '在文件夹中显示',
  act_remove: '从列表中移除',
  act_retry: '重试',
  folder_fell_back: '该文件已不在原路径 — 已改为打开下载文件夹。',
  folder_failed: '无法打开文件夹。',
  eta: '剩余',
  audio_label: '音频',
  time_just_now: '刚刚',
  time_min_ago: '{n} 分钟前',
  time_hours_ago: '{n} 小时前',

  // ---- options: header -------------------------------------------------
  options_subtitle: '下载、默认清晰度与登录相关设置。',
  welcome_banner:
    '即将完成。启动本地服务（<code>{script}</code>）' +
    '并保持窗口开启，然后在下方检测连接。',

  // ---- options: language ----------------------------------------------
  lang_section: '语言',
  lang_label: '界面语言',
  lang_hint: '立即对弹窗、页面按钮和本页生效。',
  lang_auto: '跟随浏览器',

  // ---- options: connection --------------------------------------------
  conn_section: '本地服务连接',
  conn_body: '扩展会请求你电脑上的一个小服务来运行 yt-dlp。',
  bridge_url: '服务地址',
  access_token: '访问令牌',
  token_hint: '启动服务时会在窗口中显示。留空则自动检测。',
  test_connection: '检测连接',
  testing: '正在检测…',
  connected: '已连接',
  cannot_reach: '无法连接到本地服务',
  test_fix: '请运行 {script} 并保持窗口开启',
  health_downloads: '下载目录',
  health_ytdlp: 'yt-dlp',
  health_ffmpeg: 'ffmpeg',
  health_concurrency: '并发数',
  health_token: '令牌',
  health_configured: '已配置',
  health_none: '无',
  health_available: '可用',
  health_missing: '缺失',
  health_error: '错误',
  health_fix: '解决方法',
  token_auto: '自动检测',
  sub_kind_auto: '自动',
  sub_kind_manual: '人工',
  chip_has_audio: '+ 音频',
  chip_best_audio: '+ 最佳音频',

  // ---- options: defaults ----------------------------------------------
  defaults_section: '下载默认值',
  preferred_format: '默认格式',
  fmt_video: '视频 + 音频',
  fmt_audio: '仅音频',
  fmt_thumb: '封面图片',
  preferred_quality: '默认视频清晰度',
  quality_hint: '若该清晰度不可用，会自动选择更低一档。',
  container: '封装格式',
  container_mp4: 'MP4（兼容性最好）',
  container_mkv: 'MKV（保留任意编码）',
  container_webm: 'WebM',
  audio_format: '音频格式',

  // ---- options: post-processing ---------------------------------------
  post_section: '下载后处理',
  embed_metadata: '写入元数据',
  embed_metadata_desc: '把标题、频道和简介写入文件。',
  embed_thumbnail: '嵌入封面',
  embed_thumbnail_desc: '把视频封面设为文件图标。',
  write_subtitles: '下载字幕',
  write_subtitles_desc: '在视频旁保存字幕文件。',
  subtitle_format: '字幕格式',
  sub_srt: 'SRT（通用）',
  sub_vtt: 'VTT（网页）',
  sub_ass: 'ASS（带样式）',
  sponsorblock: '移除赞助片段',
  sponsorblock_desc: '通过 SponsorBlock 剪掉赞助与自我推广片段。',

  // ---- options: overlay ------------------------------------------------
  overlay_section: '页面按钮',
  overlay_show: '在 YouTube 页面显示下载按钮',
  overlay_show_desc: '带清晰度选择的悬浮按钮。',
  overlay_position: '按钮位置',
  pos_bottom_right: '右下角',
  pos_bottom_left: '左下角',
  pos_top_right: '右上角',
  pos_top_left: '左上角',

  // ---- options: cookies ------------------------------------------------
  signin_section: '登录与 cookies',
  signin_body:
    '年龄限制、私享和会员专属视频，以及 YouTube 的' +
    '「确认你不是机器人」验证，都需要你已登录的浏览器会话。',
  use_cookies: '使用我的 YouTube cookies',
  use_cookies_desc: '允许本地服务读取下方的 cookie 文件。',
  cookie_profile: 'cookie 文件名',
  cookie_send_now: '立即发送我的 YouTube cookies',
  cookie_delete: '删除已保存的 cookies',
  cookie_fail: '发送 cookies 失败。',

  // ---- options: advanced / footer -------------------------------------
  advanced_section: '高级',
  notify_complete: '下载完成时通知我',
  notify_complete_desc: '以桌面通知显示文件名。',
  save_settings: '保存设置',
  saved: '已保存 ✓',
  save_failed: '保存失败',
  saved_cookies_hint: '已向本地服务发送 {n} 条 cookies，现在可以下载需要登录的视频了。',

  // ---- overlay (page button) ------------------------------------------
  ov_download: '下载',
  ov_video: '视频',
  ov_audio: '音频',
  ov_cover: '封面',
  ov_quality: '清晰度',
  ov_options: '选项',
  ov_save_subs: '保存字幕',
  ov_embed_thumb: '嵌入封面',
  ov_sponsor: '移除赞助片段',
  ov_sub_lang: '字幕语言',
  ov_audio_format: '音频格式',
  ov_source_stream: '来源音轨',
  ov_cover_note: '以 JPG 保存最高分辨率的封面图片。',
  ov_single_format: '该站点只提供单一视频文件，将自动使用最佳画质。',
  ov_no_media: '当前页面未找到可下载的视频。',
  ov_adding: '正在加入队列…',
  ov_queued_ok: '已加入队列：{quality} — 可在扩展弹窗中查看进度。',
  ov_queued_btn: '已排队 ✓',
  ov_reading: '正在读取可用格式…',
  ov_no_video: '当前页面未找到视频。',
  ov_no_video_formats: '未找到视频格式。',

  // ---- background messages --------------------------------------------
  bg_notification_queued: '已加入下载队列',
  bg_notification_queued_body: '已按默认清晰度加入队列。',
  bg_notification_failed: '下载失败',
  bg_saved_audio: '音频已保存',
  bg_saved_video: '已保存 {quality}',
  bg_saved_generic: '下载完成',
  bg_bridge_unreachable:
    '无法连接到本地下载服务（{url}）。请确认服务已启动（start-bridge 脚本），然后重试。',
  bg_no_video: '当前页面未检测到 YouTube 视频。',
  bg_live_stream: '直播视频需等直播结束后才能下载。',
  bg_no_cookies: '未找到 YouTube cookies。请打开 youtube.com 并登录后重试。',
  bg_no_file: '本地服务中不存在该下载的文件。',

  // ---- bridge errors ---------------------------------------------------
  err_spawn_denied:
    '本地服务无法启动 yt-dlp（权限不足）。如果你正在受限或沙箱环境中运行，请改为在普通终端中启动服务。否则请检查 yt-dlp 是否被杀毒软件拦截，并把 YTD_YTDLP 设为它的完整路径。',
  err_ytdlp_missing:
    '未找到 yt-dlp。请安装（winget install yt-dlp.yt-dlp）后重启本地服务，或把 YTD_YTDLP 设为 yt-dlp.exe 的完整路径。',
  err_age_restricted: '该视频有年龄限制。请在扩展中发送 YouTube cookies 后重试。',
  err_bot_check:
    'YouTube 要求验证本次请求不是机器人。请打开扩展设置启用「使用浏览器 cookies」，然后重试。',
  err_unavailable: '该视频不可用（已删除、地区限制或私享）。',
  err_private: '该视频为私享视频，需要通过浏览器 cookies 登录后下载。',
  err_members_only: '该视频为会员专属，需要已订阅账号的浏览器 cookies。',
  err_format_gone: '该视频已不再提供所选清晰度，请改选其他清晰度。',
  err_ffmpeg_missing:
    '未找到 ffmpeg，因此无法合并分离的视频与音频流。请安装 ffmpeg 并重启本地服务。',
  err_unsupported_url: '该链接不是受支持的 YouTube 视频地址。',
  err_unknown: '未知的 yt-dlp 错误',
};

const DICTS = { en, zh };

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

let current = DEFAULT_LANGUAGE;
/** Cached resolved language code ("en" / "zh"), never "auto". */
let resolved = 'en';

/** Work out which dictionary "auto" should use. */
function resolveAuto() {
  const uiLang = (typeof navigator !== 'undefined' && (navigator.language || navigator.languages?.[0])) || 'en';
  return uiLang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** @returns {"en"|"zh"} the language actually in use */
export function getLanguage() {
  return resolved;
}

/**
 * Switch language and persist the choice.
 * @param {"auto"|"en"|"zh"} code
 * @param {boolean} persist write the preference to chrome.storage.sync
 */
export async function setLanguage(code, persist = true) {
  current = code || DEFAULT_LANGUAGE;
  resolved = current === 'auto' ? resolveAuto() : current;
  if (persist && typeof chrome !== 'undefined' && chrome.storage?.sync) {
    await chrome.storage.sync.set({ language: current }).catch(() => {});
  }
  return resolved;
}

/** Load the saved preference and resolve it. Call once before rendering. */
export async function initLanguage() {
  let stored = DEFAULT_LANGUAGE;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
      ({ language: stored = DEFAULT_LANGUAGE } = await chrome.storage.sync.get({ language: DEFAULT_LANGUAGE }));
    }
  } catch {
    /* storage unavailable: fall back to auto */
  }
  return setLanguage(stored, false);
}

/**
 * Name of the launcher script for the machine the browser runs on.
 *
 * The bridge always runs on the same host as Chrome, so the browser's own
 * user-agent tells us which start script to advertise. Windows uses the
 * batch launcher; macOS/Linux use the shell script. Synchronous on purpose:
 * help text is rendered during applyTo() and must not flash a wrong value
 * while an async platform query resolves. Callers may still override via
 * t(key, { script }).
 */
let scriptCache = null;
export function startScript() {
  if (scriptCache) return scriptCache;
  let ua = '';
  try {
    ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  } catch {
    /* no navigator (plain node tooling): assume unix shell */
  }
  scriptCache = /Windows|Win32|Win64/i.test(ua) ? 'start-bridge.cmd' : './start-bridge.sh';
  return scriptCache;
}

/** One-time login helper. After this, opening the popup starts the bridge. */
export function installScript() {
  let ua = '';
  try {
    ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  } catch {
    /* plain node tooling */
  }
  return /Windows|Win32|Win64/i.test(ua) ? 'install-autostart.cmd' : './install-autostart.sh';
}

/**
 * Translate a key.
 * @param {string} key
 * @param {Record<string, string|number>} [vars] replaced into {placeholders}
 */
export function t(key, vars) {
  const dict = DICTS[resolved] || DICTS.en;
  let text = dict[key] ?? DICTS.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  // {script} defaults to the launcher name for the current OS; an explicit
  // vars.script above already replaced it, so anything left is a default.
  if (text.includes('{script}')) text = text.replaceAll('{script}', startScript());
  if (text.includes('{install}')) text = text.replaceAll('{install}', installScript());
  return text;
}

/**
 * Fill every marked node inside `root`.
 *
 * Text nodes support a restricted <code> tag so help steps can keep their
 * monospace styling while still being translated. Any other markup is escaped,
 * so dictionary content can never inject HTML.
 */
export function applyTo(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.innerHTML = renderRich(t(el.dataset.i18n));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  // Reflect the active language on <html> for CSS hooks and font selection.
  if (root === document || root.documentElement) {
    document.documentElement.lang = resolved === 'zh' ? 'zh-CN' : 'en';
  }
}

/** Escape everything except an intentional <code>...</code> wrapper. */
function renderRich(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/&lt;code&gt;(.*?)&lt;\/code&gt;/g, '<code>$1</code>');
}

/** Re-render after a language change. */
export async function switchLanguage(code) {
  await setLanguage(code);
  applyTo(document);
}

// Keep in sync when the preference changes in another view (popup vs options).
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.language) return;
    setLanguage(changes.language.newValue, false).then(() => applyTo(document));
  });
}
