# YouTube & X & 抖音 视频下载器

[English](#english) · [中文](#中文)

Chrome 扩展负责页面上的按钮和设置，真正的下载由本机上的 yt-dlp 完成。支持 YouTube、X（Twitter）与抖音的视频、音频、封面和字幕。

---

## 中文

### 能做什么

- 在 YouTube、YouTube Music、X / Twitter、抖音视频页显示下载按钮，扩展弹窗也能直接下载当前标签页。
- 按分辨率选择画质。每个档位会显示大约的文件大小（估算值前面带 `~`）。
- 下载视频、仅音频（MP3 / M4A / Opus / WAV / FLAC）、封面图。
- YouTube 可勾选保存字幕，并选择语言。人工字幕和自动字幕会分开标出，中文和英文排在前面。
- 下载队列、进度、历史，以及取消、重试、打开所在文件夹。
- 需要登录的视频（年龄限制、会员、私享）可以使用浏览器 cookies。
- 打开扩展弹窗时，如果本机服务没在跑，会自动把它拉起来。

文件默认保存到 `~/Downloads/YouTube`。

### 环境

- Node.js 18 或更高
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [ffmpeg](https://ffmpeg.org/)（合并高清视频与音频、抽取音频）

macOS 可以用 Homebrew：

```bash
brew install node yt-dlp ffmpeg
```

### 安装

1. 检查环境，输出 `OK` 即可：

   ```bash
   node server/doctor.js
   ```

2. 安装一次登录自启。之后打开扩展就会启动下载服务，不用每次手动跑脚本。

   ```bash
   ./install-autostart.sh          # macOS
   install-autostart.cmd           # Windows
   ```

   不想装自启时，每次在这个目录执行 `./start-bridge.sh`（macOS / Linux）或 `start-bridge.cmd`（Windows），并保持窗口开着。

3. 打开 Chrome 的 `chrome://extensions`，打开开发者模式，选择「加载已解压的扩展程序」，指向本仓库的 `extension` 目录。

4. 打开一个 YouTube、X 或抖音视频。页面上会出现红色下载按钮；也可以点工具栏图标，在弹窗里选画质后下载。快捷键是 `Alt+D`（抖音除外，见下）。

> **抖音：必须在视频页面上用页面里的按钮下载。**
>
> 抖音的接口要求每个请求带一个 `a_bogus` 签名，这个签名只有**页面自己的风控 SDK** 能生成；而且它还校验 TLS 指纹和设备身份。yt-dlp 三项都过不了，所以直接拿到的是 `403`（[yt-dlp issue #9667](https://github.com/yt-dlp/yt-dlp/issues/9667) 自 2024 年 4 月开启至今未修）。
>
> 但**你的浏览器三项全过**。所以本扩展换个做法：直接读取播放器里**已经签好名的视频直链**，交给本机服务下载。因此：
>
> - 抖音**不需要发送 cookies** —— 走的是页面已经协商好的地址
> - 必须**在那个视频的页面上**点按钮；弹窗的「下载当前标签页」和 `Alt+D` 对抖音无效（它们拿不到页面里的地址）
> - 如果页面上的按钮提示「请先播放视频」，让它播放一两秒再点
> - 直链有**时效**（约 1–2 小时），过期后刷新页面重新获取即可

### 各站点支持情况

| 站点 | 视频 | 画质可选 | 字幕 | 需要 cookies | 下载方式 |
| --- | --- | --- | --- | --- | --- |
| YouTube | 最高 4K | ✅ | ✅ | 可选（年龄限制 / 会员 / 机器人校验时需要） | yt-dlp |
| X（Twitter） | ✅ | 单一文件 | — | 多数视频需要 | yt-dlp |
| 抖音 | ✅ | 单一文件 | — | **不需要** | 读取页面直链 |

### 怎么配合

扩展不能自己抓视频，也不能自己拉起进程。

| 部分 | 作用 |
| --- | --- |
| `extension/` | 页面按钮、弹窗、设置。只把请求发给本机。 |
| `server/` | 下载服务，默认只监听 `127.0.0.1:8765`，调用 yt-dlp 和 ffmpeg。 |
| `launcher/` | 登录后常驻的小启动器（`127.0.0.1:8766`）。弹窗发现服务没开时，由它来启动。 |

服务只绑定本机回环地址，不对外网开放。访问令牌写在 `server/.token`，已被 git 忽略，不要提交。

### 常用设置

扩展设置页可以改默认画质、容器（mp4 / mkv / webm）、音频格式、字幕格式（srt / vtt / ass）、是否嵌入封面和元数据，以及是否用 SponsorBlock 去掉赞助片段（仅 YouTube）。界面语言可选简体中文或 English。

### 环境变量

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `YTD_PORT` | 下载服务端口 | `8765` |
| `YTD_DOWNLOAD_DIR` | 保存目录 | `~/Downloads/YouTube` |
| `YTD_YTDLP` | yt-dlp 可执行文件 | `yt-dlp` |
| `YTD_FFMPEG` | ffmpeg 可执行文件 | `ffmpeg` |
| `YTD_CONCURRENCY` | 同时下载数 | `2` |
| `YTD_PLAYER_CLIENT` | 强制 yt-dlp 的播放器客户端 | 空（用 yt-dlp 默认） |

### 下载报 HTTP 403

多半是出口 IP 被 Google 拒绝，旧版 yt-dlp 更容易碰到。按这个顺序试：

1. 升级 yt-dlp 后重启服务：`brew upgrade yt-dlp`、`winget upgrade yt-dlp.yt-dlp` 或 `pip install -U yt-dlp`。
2. 仍被拒绝时，用浏览器风格客户端启动。这个客户端最高只有 360p：`YTD_PLAYER_CLIENT=mweb ./start-bridge.sh`。
3. 在扩展设置里打开「使用浏览器 cookies」，或换一个代理出口。

经 `start-bridge.sh` 启动时，会继承当前终端里的 `HTTP_PROXY` / `HTTPS_PROXY`。

### 字幕报 HTTP 429

YouTube 会限流**未登录的自动字幕**。人工字幕一般不受影响。

- 下拉列表里标成「人工」的轨道可以匿名下载。
- 标成「自动」的轨道（很多中文视频的 zh-Hans）被拒绝时，在设置里打开「使用浏览器 cookies」再试。
- 字幕和视频在同一目录，文件名类似 `视频标题 [720p].zh-Hans.srt`。

### 目录

```
yt-downloader/
├─ extension/          Chrome 扩展
├─ server/             本机下载服务
├─ launcher/           登录自启用的启动器
├─ tools/              辅助脚本
├─ install-autostart.sh
├─ install-autostart.cmd
├─ start-bridge.sh
└─ start-bridge.cmd
```

---

## English

A Chrome extension for the buttons and settings. The actual download is done on your machine by yt-dlp. It saves video, audio, cover art, and subtitles from YouTube, X (Twitter) and Douyin.

### What it does

- A download button on YouTube, YouTube Music, X / Twitter and Douyin video pages. The toolbar popup can download the current tab as well.
- A quality picker. Each resolution shows an approximate file size (`~` means the size was estimated).
- Video, audio only (MP3, M4A, Opus, WAV, FLAC), or a cover image.
- Optional YouTube subtitles, with a language list. Manual and automatic tracks are labeled separately. Chinese and English are listed first.
- A queue with progress and history, plus cancel, retry, and reveal-in-folder.
- Browser cookies for videos that need a signed-in session (age-restricted, members-only, private).
- Opening the extension popup starts the local service when it is not already running.

Files are saved to `~/Downloads/YouTube` by default.

### Requirements

- Node.js 18 or newer
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [ffmpeg](https://ffmpeg.org/) (needed to merge high-resolution video with audio, and to extract audio)

On macOS with Homebrew:

```bash
brew install node yt-dlp ffmpeg
```

### Install

1. Check the toolchain. The command should print `OK`.

   ```bash
   node server/doctor.js
   ```

2. Install the login helper once. After that, opening the extension starts the download service. You do not need to run a script each time.

   ```bash
   ./install-autostart.sh          # macOS
   install-autostart.cmd           # Windows
   ```

   To skip the helper, run `./start-bridge.sh` (macOS / Linux) or `start-bridge.cmd` (Windows) in this folder and leave that window open.

3. Open `chrome://extensions`, turn on Developer mode, choose “Load unpacked”, and select the `extension` directory in this repo.

4. Open a YouTube, X or Douyin video. A red download button appears on the page. You can also use the toolbar icon and pick a quality in the popup. The shortcut is `Alt+D` (not for Douyin — see below).

> **Douyin: use the button on the video page itself.**
>
> Douyin's API requires a per-request `a_bogus` signature that only its own page's risk SDK can produce, and it also checks the TLS fingerprint and device identity. yt-dlp fails all three and gets `403` ([yt-dlp issue #9667](https://github.com/yt-dlp/yt-dlp/issues/9667) has been open since April 2024).
>
> Your browser, however, already passes all three. So the extension takes a different route: it reads the **already-signed media URL** out of the player and hands it to the local bridge. That means:
>
> - Douyin needs **no cookies** — the URL is already negotiated
> - You must click the button **on that video's page**. The popup's "download this tab" and `Alt+D` do not work for Douyin, because they cannot see the page's URL
> - If the button says the video is not ready, let it play for a second and try again
> - The URL expires after roughly 1–2 hours; reload the page to get a fresh one

### Site support

| Site | Video | Quality choice | Subtitles | Cookies | How it downloads |
| --- | --- | --- | --- | --- | --- |
| YouTube | up to 4K | yes | yes | optional (needed for age-gated, members-only, bot check) | yt-dlp |
| X (Twitter) | yes | single file | — | needed for most videos | yt-dlp |
| Douyin | yes | single file | — | **not needed** | URL read from the page |

### How the pieces fit

The extension does not fetch the media itself, and it cannot start a process on its own.

| Piece | Role |
| --- | --- |
| `extension/` | Page button, popup, and settings. It only talks to localhost. |
| `server/` | Download service. Listens on `127.0.0.1:8765` and runs yt-dlp and ffmpeg. |
| `launcher/` | Small helper that stays up after you sign in (`127.0.0.1:8766`). The popup asks it to start the download service. |

The service binds to loopback only. Its access token is written to `server/.token`, which is gitignored. Do not commit that file.

### Settings

The options page sets the default quality, container (mp4, mkv, webm), audio format, subtitle format (srt, vtt, ass), whether to embed the thumbnail and metadata, and whether to cut sponsor segments with SponsorBlock (YouTube only). The interface language can be Simplified Chinese or English.

### Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `YTD_PORT` | Download service port | `8765` |
| `YTD_DOWNLOAD_DIR` | Output folder | `~/Downloads/YouTube` |
| `YTD_YTDLP` | yt-dlp executable | `yt-dlp` |
| `YTD_FFMPEG` | ffmpeg executable | `ffmpeg` |
| `YTD_CONCURRENCY` | Parallel downloads | `2` |
| `YTD_PLAYER_CLIENT` | Force a yt-dlp player client | empty (yt-dlp default) |

### HTTP 403 while downloading

The exit IP is usually blocked by Google. Older yt-dlp builds hit this more often. Try, in order:

1. Upgrade yt-dlp and restart the service: `brew upgrade yt-dlp`, `winget upgrade yt-dlp.yt-dlp`, or `pip install -U yt-dlp`.
2. If it still fails, start with a browser-style client. That client tops out at 360p: `YTD_PLAYER_CLIENT=mweb ./start-bridge.sh`.
3. Turn on “Use browser cookies” in the extension settings, or switch to another proxy exit.

`start-bridge.sh` inherits `HTTP_PROXY` and `HTTPS_PROXY` from the terminal that launched it.

### HTTP 429 on subtitles

YouTube throttles **anonymous automatic captions**. Human-written subtitles are usually fine.

- Tracks labeled “manual” can be downloaded without signing in.
- Tracks labeled “auto” (often `zh-Hans` on Chinese videos) may be rejected. Turn on “Use browser cookies” and try again.
- The subtitle file is saved next to the video, for example `Video title [720p].zh-Hans.srt`.

### Layout

```
yt-downloader/
├─ extension/          Chrome extension
├─ server/             Local download service
├─ launcher/           Login helper that starts the service
├─ tools/              Helper scripts
├─ install-autostart.sh
├─ install-autostart.cmd
├─ start-bridge.sh
└─ start-bridge.cmd
```
