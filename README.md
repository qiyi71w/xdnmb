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

饼干和 App UUID 用系统凭据保护加密（Windows DPAPI，macOS 钥匙串）。联网查询会交给所选的 XDS 或 nmb-search 及其上游，主动所属串反查会把串号交给 XDS；请求不携带论坛饼干凭据、官网会话或 App UUID。第三方收录可能不完整或过时。“打开搜索网站”只会外开当前渠道，不是自动备用服务。浏览缓存默认上限 2 GB，可在“设置 › 存储与缓存”调整或清理。

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
