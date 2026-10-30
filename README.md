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
- **图片**：在应用内缩放、拖动、保存或复制原图。
  原图显示后，用工具栏“复制图片”、Ctrl+C 或在图片上右键复制。静态图复制完整原图，保留透明部分，不按窗口裁切；动图按原文件复制，保留全部帧，粘贴到其他软件时可能作为文件附件出现。复制后关闭查看器或清理缓存不影响粘贴。粘贴效果取决于接收软件，尚未在 QQ、微信中验证。
- **发串与回复**：浮动编辑器，自动存草稿，支持附图、水印和自定义颜文字。
- **多饼干**：导入官网导出的饼干或 userhash，也可登录官网后选择导入；浏览、发言、网页同步可各用一块饼干。
- **订阅**：管理 App UUID 订阅和网页订阅，并在两端之间同步。
- **提醒**：每个串可单独开启“全串更新”“PO 追更”“引用我的发言”，后台检查并发系统通知。
  全串／PO 提醒会排除本机已确认、且能从现有页面证明计数位置的回复；长串、删除留下的缺口或确认较晚时，仍可能提醒自己的回复。不会为此扫描整串，也不会按饼干 ID 抵扣其他客户端的发言。
- **离线保存**：把整串文字和原图存到本机，断网也能看。
- **搜索**：本机搜索已读过的内容，或通过 [nmb-search](https://nmb-search.166666666.xyz/) 联网搜索。
- **屏蔽与饼干颜色**：在本机屏蔽串号或饼干，给饼干 ID 标颜色。
- **外观**：浅色、深色、跟随系统或自定义主题；正文字体、字号、阅读宽度、密度和界面缩放可调。

## 订阅

- **列表刷新**：每次打开或回到订阅页、切换 App／网页时，先显示上次读完的完整列表，同时在后台读取新一轮；读到结束页后才整体替换。读取失败或中途停止时保留旧列表，并注明它的读取时间。还没有完整列表时逐页显示已读到的部分，并注明尚未读完。
- **读取不随页面中断**：离开订阅页或切到其他串，正在进行的读取会继续。读取中可点“停止读取”，已读到的内容保留。不定时轮询，失败也不自动重试，可用刷新按钮手动再读。其他客户端增删的订阅，要等下一轮读完才会反映。
- **串内订阅状态**：App 和网页分别判断。既没有完整列表、已读到的部分也没有这个串时，按钮显示“读取状态”，点按会读取该端的订阅列表，不会把未知当成未订阅。
- **结果未确认**：加入或取消后若无法确认结果，可点“核对订阅”。核对只读取原来那个 App UUID 或网页饼干的订阅列表，不会重发；提示会写明本次回读的结果：看到了这个串、读取失败、没读完，或读完了也没有。
- **关闭提示**：不想再核对时，点提示旁的 × 关闭；在串内则从订阅按钮旁的下拉菜单关闭。关闭只记录在本机，不修改远端订阅，也不代表已订阅或未订阅，之后可以重新加入或取消。写入或核对进行中不能关闭；关闭没能保存时，提示会保留。

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

数据都保存在本机，升级和卸载不会删除：

- Windows：`%APPDATA%\汐岛`
- macOS：`~/Library/Application Support/汐岛`

饼干和 App UUID 用系统凭据保护加密（Windows DPAPI，macOS 钥匙串）。联网搜索的搜索词会发送给 nmb-search。浏览缓存默认上限 2 GB，可在“设置 › 存储与缓存”调整或清理。

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
- 联网搜索使用 [nmb-search](https://nmb-search.166666666.xyz/)（[API 与使用条款](https://nmb-search.166666666.xyz/api.txt)），该服务基于 [4get](https://git.lolcat.ca/lolcat/4get)。
- 第三方依赖的许可说明见 [docs/development.md](docs/development.md#第三方许可)。
