// User-facing words of the About section's update area and the update notices. Nothing here may
// say an update was installed: only the running version (`currentVersion`) is installed.

import type { InstallFailure, InstallResult, UpdateFailure, UpdatePlatform, UpdateUnavailable } from '../../../../shared/updates'

export const UNAVAILABLE_TEXT: Record<UpdateUnavailable, string> = {
  'not-installed': '当前不是安装版，不能在应用内更新',
  platform: '这个系统暂不支持在应用内更新'
}

/** After the reason: where a newer version can still be had. */
export const UNAVAILABLE_NEXT = '可在仓库的 Releases 页面获取新版本'

const REASON: Record<Exclude<UpdateFailure, 'install'>, string> = {
  network: '连不上 GitHub，请检查网络或“更新网络”设置',
  source: '未取得更新信息',
  integrity: '下载的文件校验未通过，已删除',
  storage: '无法在本机保存或读取安装包，请检查磁盘空间和权限',
  incomplete: '安装没有完成'
}

export function failureReason(failure: UpdateFailure, platform: UpdatePlatform): string {
  if (failure === 'install') return platform === 'mac' ? '安装包未能打开' : '安装程序未能启动'
  return REASON[failure]
}

export function checkFailedText(failure: UpdateFailure | null, platform: UpdatePlatform): string {
  return failure === null ? '检查失败' : `检查失败：${failureReason(failure, platform)}`
}

export function downloadFailedText(failure: UpdateFailure, platform: UpdatePlatform): string {
  return `下载失败：${failureReason(failure, platform)}`
}

/** `installAndRestart` / `openInstaller` resolved without starting. */
export function actionFailedText(failure: Extract<InstallResult, { started: false }>['failure'], platform: UpdatePlatform): string {
  if (failure === 'install') return failureReason(failure, platform)
  const reason = failure === 'not-ready' ? '安装包还没有准备好' : failureReason(failure, platform)
  return platform === 'mac' ? `未能打开安装包：${reason}` : `未能开始安装：${reason}`
}

/** The action that uses a verified package on this platform. */
export function packageActionLabel(platform: UpdatePlatform): string {
  return platform === 'mac' ? '打开安装包' : '安装并重启'
}

/** The ready notice's action: the same step as `packageActionLabel`, taken now. */
export function readyActionLabel(platform: UpdatePlatform): string {
  return platform === 'mac' ? '打开安装包' : '立即安装并重启'
}

export function readyNoticeText(platform: UpdatePlatform, version: string): string {
  return platform === 'mac' ? `新版本 ${version} 的安装包已下载` : `新版本 ${version} 已下载`
}

/**
 * What 稍后 leaves to happen. `installOnQuit` (Windows, automatic install on): a quit installs it,
 * and a session ended by shutting the system down installs it at the next start.
 */
export function readyLaterText(platform: UpdatePlatform, installOnQuit: boolean): string {
  if (platform === 'mac') return '稍后可在“设置 › 系统 › 关于”中打开'
  if (installOnQuit) return '退出汐岛时安装'
  return '稍后可在“设置 › 系统 › 关于”中安装'
}

/** The last installation attempt did not install: at this start (not tried again) or when the app last quit. */
export function installFailedText({ when, failure }: InstallFailure, platform: UpdatePlatform): string {
  const reason = failureReason(failure, platform)
  return when === 'start' ? `启动时未能安装新版本：${reason}` : `上次退出时未能安装新版本：${reason}`
}

export const EMPTY_NOTES_TEXT = '此版本未提供更新说明'
/** The notes of exactly this release could not be obtained; 「在 GitHub 查看」 right below has them. */
export const UNKNOWN_NOTES_TEXT = '未能取得此版本的更新说明'
