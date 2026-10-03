# YouTube & X 视频下载器

本仓库实现了一个 Chrome Manifest V3 扩展，用于下载 YouTube 与 X（Twitter）的视频、音频、字幕。扩展本身只负责 UI 与桥接本地 Bridge，所有实际下载、合并、签名解密等工作均交由本地 Node 服务（Bridge）完成。

## 项目结构
```
yt-downloader/
├─ .gitattributes
├─ .gitignore
├─ README.md
├─ extension/      # Chrome 扩展源码
├─ server/         # 本地 Bridge（Node.js）
├─ launcher/       # 启动 Bridge 的回环服务
├─ tools/          # 辅助脚本
├─ start-bridge.*  # 启动脚本（sh / cmd）
├─ stop-bridge.cmd
└─ install-autostart.cmd
```

## 快速上手
1. **环境准备**：确保机器上已安装 Node 18+、yt‑dlp、ffmpeg。
2. **检查环境**：`node server/doctor.js`（应输出 `OK`）
3. **开机自启（只需一次）**：`./install-autostart.sh`（macOS）或 `install-autostart.cmd`（Windows）。之后登录会拉起启动器，打开扩展弹窗时若下载服务没在跑，会自动把它拉起来。
4. **加载扩展**：在 Chrome `chrome://extensions` 页面打开 *开发者模式*，点击 *加载已解压的扩展*，选择 `yt-downloader/extension` 目录。
5. 打开任意 YouTube 或 X 视频页面，右下角会出现红色下载按钮，点击后选择画质即可开始下载。

也可以不装自启，每次手动运行 `./start-bridge.sh`（mac/linux）或 `start-bridge.cmd`（Windows）。

## 常见问题：下载报 `HTTP Error 403: Forbidden`

403 通常不是软件问题，而是本机出口 IP（常见于代理/机场共享 IP）被 Google 视频服务器拒绝，旧版 yt-dlp 的播放器客户端最容易被拒。处理方式（按顺序尝试）：

- **升级 yt-dlp（首选，实测有效）**：`brew upgrade yt-dlp`（mac）、`winget upgrade yt-dlp.yt-dlp`（Windows）或 `pip install -U yt-dlp`，然后重启 Bridge。升级后画质阶梯与下载均恢复正常。
- 仍 403 时，用浏览器风格客户端启动：`YTD_PLAYER_CLIENT=mweb ./start-bridge.sh`（注意 mweb 只有 ≤360p 画质）。
- 或在扩展设置中开启 *使用浏览器 cookies* 后重试；或更换代理出口节点。
- 终端/服务通过 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量继承代理；经 `start-bridge.sh` 或已设置代理的终端启动即可。

## 常见问题：字幕下载报 `HTTP Error 429: Too Many Requests`

下载面板勾选 *保存字幕* 后可选择字幕语言（下拉列表自动把中文、英文排在最前）。YouTube 自 2025 年起对**匿名自动字幕（ASR）**接口限流：

- **人工字幕不受影响**，实测可正常导出 `.srt`。选好语言后扩展会自动区分「人工/自动」轨，人工轨不会触发自动字幕请求。
- **自动字幕（如多数中文视频的 zh-Hans）匿名请求可能被 429 拒绝**。解决：在扩展设置中开启 *使用浏览器 cookies* 后重试（登录态可正常取自动字幕）；或选择该视频的人工字幕轨。
- 字幕文件与视频同目录，命名形如 `视频标题 [720p].zh-Hans.srt`；在设置页可改字幕格式（srt/vtt 等），勾选嵌入时还会封装进 mp4/音频容器。

更多细节请阅读 `extension/manifest.json`、`server/server.js` 与 `tools/` 中的注释。
