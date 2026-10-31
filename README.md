<div align="center">

<img src="resources/icons/xidao-icon-512.png" alt="汐岛图标" width="112">

# 汐岛

[X 岛匿名版](https://www.nmbxd1.com/)的第三方桌面客户端，支持 Windows 与 macOS。

[![最新版本](https://img.shields.io/github/v/release/qiyi71w/xdnmb?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/qiyi71w/xdnmb/releases/latest)
[![许可证](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[功能](#功能) · [安装](#安装) · [快捷键](#快捷键) · [数据与隐私](#数据与隐私) · [从源码构建](#从源码构建)

</div>

## 功能

- **多标签阅读**：每个标签有独立的前进后退，可分栏或整页阅读，重启后恢复标签和阅读位置。
- **串阅读**：在“全部”和“只看 PO”之间切换，两种模式分别记住阅读位置，滚到底部自动加载下一页。
- **引用**：悬停预览，单击跳转，“返回引用处”回到原位。
- **发串与回复**：浮动编辑器，自动存草稿，支持附图、水印和自定义颜文字。
- **多饼干**：导入官网导出的饼干或 userhash，也可登录官网后选择导入；浏览、发言、网页同步可各用一块饼干。
- **订阅**：管理 App UUID 订阅和网页订阅，并在两端之间同步。
- **提醒**：每个串可单独开启“全串更新”“PO 追更”“引用我的发言”，后台检查并发系统通知。
  全串／PO 提醒会排除本机已确认、且能从现有页面证明计数位置的回复；长串、删除留下的缺口或确认较晚时，仍可能提醒自己的回复。不会为此扫描整串，也不会按饼干 ID 抵扣其他客户端的发言。
- **离线保存**：把整串文字和原图存到本机，断网也能看。
- **搜索**：本机搜索已读过的内容，或选择 [XDS](https://xds.wol.moe/)／[nmb-search](https://nmb-search.166666666.xyz/) 联网搜索；也可独立按串号打开。
- **屏蔽与饼干颜色**：在本机屏蔽串号或饼干，给饼干 ID 选颜色。
- **外观**：浅色、深色、跟随系统或自定义主题；正文字体、字号、阅读宽度、密度和界面缩放可调。
- **公告**：冷启动读取 X 岛公告，避开编辑和其他弹窗后提示；可按公告选择“不再提示”，或在“设置 › 公告”随时查看、重新获取。
- **使用统计（自愿）**：首次启动询问是否开启，默认关闭；可在“设置 › 系统 › 使用统计”随时关闭。详见[数据与隐私](#数据与隐私)。

## 安装

从 [Releases](https://github.com/qiyi71w/xdnmb/releases/latest) 下载对应的安装包：

| 系统 | 文件 |
| --- | --- |
| Windows 10／11 x64 | `xidao-<版本>-win-x64.exe` |
| macOS 13+，Apple Silicon | `xidao-<版本>-mac-arm64.dmg` |
| macOS 13+，Intel | `xidao-<版本>-mac-x64.dmg` |

**macOS**：打开 DMG，把“汐岛”拖进“应用程序”。

> [!NOTE]
> 首次打开若被系统阻止，到“系统设置 › 隐私与安全性”允许打开。更换版本后钥匙串可能再次请求授权，选择允许即可。

### 更新

在“设置 › 系统 › 关于”检查更新。

- **Windows**：下载完成后选择“安装并重启”，或开启“退出时自动安装更新”。
- **macOS**：下载 DMG 后，先退出汐岛，再把新版拖进“应用程序”覆盖旧版。

## 快捷键

macOS 上用 Cmd 代替 Ctrl。

| 操作 | 快捷键 |
| --- | --- |
| 新标签／关闭标签 | Ctrl+T／Ctrl+W |
| 切换标签 | Ctrl+Tab／Ctrl+Shift+Tab（macOS 为 Control） |
| 后退／前进 | Alt+←／Alt+→（macOS 为 Cmd+[／Cmd+]） |
| 刷新当前内容 | Ctrl+R |
| 串内搜索／本机搜索 | Ctrl+F／Ctrl+Shift+F |
| 发送 | 编辑器内 Ctrl+Enter |
| 保存草稿 | Ctrl+S |
| 打开设置 | Ctrl+, |
| 放大／缩小／还原界面 | Ctrl+=／Ctrl+-／Ctrl+0 |

## 数据与隐私

除自愿开启的使用统计外，数据都保存在本机，升级和卸载不会删除：

- Windows：`%APPDATA%\汐岛`
- macOS：`~/Library/Application Support/汐岛`

饼干和 App UUID 用系统凭据保护加密（Windows DPAPI，macOS 钥匙串）。联网查询会交给所选的 XDS 或 nmb-search 及其上游，主动所属串反查会把串号交给 XDS；请求不携带论坛饼干凭据、官网会话或 App UUID。第三方收录可能不完整或过时。“打开搜索网站”只会外开当前渠道，不是自动备用服务。浏览缓存默认上限 2 GB，可在“设置 › 存储与缓存”调整或清理。

公告从 `https://nmb.ovear.info/nmb-notice.json` 匿名读取，不携带论坛身份。每次冷启动自动读取一次；恢复窗口不会重复读取。最近取得的公告和“不再提示”选择保存在本机，普通缓存清理不会删除该选择；日期或正文变化后可再次提示。网络失败时仅在设置中展示已有副本，不用旧公告自动弹窗。

### 使用统计

使用统计默认关闭。新安装和从旧版本升级后首次启动各询问一次：选“开启”才会参与；选“关闭”、点 × 或按 Esc 都保存为关闭，之后不再询问。询问内容不需要联网。开启并保存成功之前，汐岛不会连接统计服务。

开启后，每个北京时间自然日里第一次在前台使用汐岛（窗口有焦点、未最小化、屏幕未锁定）时，向汐岛作者在甲骨文云上运营的统计服务发送一次：开启时由统计服务生成的随机统计标识与凭证、汐岛版本号、系统类别（Windows 或 macOS）。不发送饼干、串号、阅读／搜索／发言内容、使用时长或具体时间；后台驻留、最小化和锁屏期间不发送，离线或关闭期间的使用不会补报。统计凭证用系统凭据保护加密保存，系统保护不可用时不会开启。

- 统计服务地址为 `https://xidao-stats.qiyi71w.com`，服务器在甲骨文云加拿大多伦多区域。HTTPS 直接在这台服务器上终止，中间不经过 CDN 或其他代理。
- 与统计标识关联的每日记录保留 31 天，不含标识的每日汇总保留 12 个月。服务器不为统计数据做额外的文件或磁盘备份。
- 统计标识会把同一安装不同日期的使用关联起来，所以不是完全匿名。连接时统计服务和网络运营方能看到你的 IP 地址；服务不把 IP 存进统计数据，反向代理也不为统计地址记录访问日志或错误日志。例外是在 TLS 握手阶段就失败的连接：服务器的共享日志可能记下它的来源 IP，但不含地址、路径或任何统计内容。
- 统计的是参与统计的安装数，不是准确的用户人数：多台设备、重装系统或删除汐岛数据目录后再开启，都会被算作不同的安装。
- “关闭”停止以后的发送，已经发送的记录不会撤回，也没有单独的删除操作。服务器上与统计标识关联的记录在最后一次上报 31 天后自动清除；不含标识的每日汇总按上面的期限保留。关闭后本机仍保留统计标识，再次开启时继续使用它。
- 正式发布的 Windows 与 macOS 版本，以及按仓库默认配置用 `npm run build` 构建的版本，都连接上述统计服务，仍需你明确开启才会发送。开发模式（`npm run dev`）和 Linux 不提供此功能。派生构建可以在构建时设置空的 `MAIN_VITE_XIDAO_ANALYTICS_ORIGIN=` 关闭此功能，或改成自己的服务。服务端协议、保留规则与部署方式见 [docs/analytics-service.md](docs/analytics-service.md)。

## 从源码构建

需要 Node.js 24 与 npm。

```bash
npm ci
npm run dev    # 开发模式
npm test
```

打包、代码结构和数据库迁移说明见 [docs/development.md](docs/development.md)。

## 致谢

- 协议参考：[TransparentLC/xdcmd 的 API 整理](https://github.com/TransparentLC/xdcmd/wiki/自己整理的-X-岛匿名版-API-文档)、[X 岛原始 API 文档](https://www.zybuluo.com/ovear/note/151481)、[orzogc/xdnmb](https://github.com/orzogc/xdnmb) 与 [orzogc/xdnmb_api](https://github.com/orzogc/xdnmb_api)（AGPL-3.0）。
- 预设颜文字取自 [xdnmb_api](https://github.com/orzogc/xdnmb_api/blob/28fdba53031a15e0de88954679afe91b9308f71a/lib/src/xdnmb.dart#L1780-L1889) 中的 X 岛官方颜文字列表。
- 联网搜索使用 [XDS](https://xds.wol.moe/)（[公开 API](https://xds.wol.moe/api/docs)）与 [nmb-search](https://nmb-search.166666666.xyz/)（[API 与使用条款](https://nmb-search.166666666.xyz/api.txt)）；后者基于 [4get](https://git.lolcat.ca/lolcat/4get)。
- 第三方依赖的许可说明见 [docs/development.md](docs/development.md#第三方许可)。
