import { useState } from 'react'
import { BottomNotice } from '../../components/BottomNotice'
import { useSettings } from '../../lib/settingsContext'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { useUpdates } from './updatesState'

/**
 * The one-time bottom notice of a found or waiting release (`state.notice`). 查看更新 opens
 * 设置 › 关于 and focuses it; both actions acknowledge the notice, which then stays gone for that
 * version even before the main process reports it cleared. Never a dialog.
 */
export function UpdateNotice({ fallbackFocus }: { fallbackFocus: () => HTMLElement | null }) {
  const { state } = useUpdates()
  const { settings } = useSettings()
  const openSettings = useSettingsOpener()
  /** Notices acknowledged in this run, as `version:kind`. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set())

  const notice = state !== null && state.unavailable === null ? state.notice : null
  const key = notice === null ? null : `${notice.version}:${notice.kind}`
  const open = key !== null && !acknowledged.has(key)

  const acknowledge = () => {
    if (notice === null || key === null) return
    setAcknowledged((set) => new Set(set).add(key))
    window.xidao.updates.acknowledgeNotice({ version: notice.version }).catch(() => undefined)
  }

  const release = state?.release?.info.version === notice?.version ? (state?.release ?? null) : null
  const status = release?.download.status
  const platform = state?.platform
  const version = notice?.version ?? ''
  const autoDownload = platform === 'mac' ? settings.updateAutoDownload : platform === 'windows' && settings.updateAutoInstall

  let message: string
  if (notice?.kind === 'ready' || status === 'ready') {
    if (platform === 'mac') message = `新版本 ${version} 的安装包已下载，可以打开`
    else if (state?.installOnQuit === true) message = `新版本 ${version} 已下载，退出汐岛时安装`
    else message = `新版本 ${version} 已下载，可以安装`
  } else if (autoDownload && (status === 'downloading' || status === 'verifying')) {
    message = `发现新版本 ${version}，正在自动下载`
  } else {
    message = `发现新版本 ${version}`
  }

  const actions = [
    ...(openSettings === null
      ? []
      : [
          {
            label: '查看更新',
            onAction: () => {
              openSettings('about')
              acknowledge()
            }
          }
        ]),
    { label: '知道了', onAction: acknowledge }
  ]

  return (
    <BottomNotice open={open} icon="download" tone="neutral" actions={actions} fallbackFocus={fallbackFocus}>
      {message}
    </BottomNotice>
  )
}
