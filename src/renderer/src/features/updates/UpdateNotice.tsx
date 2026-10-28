import { useState } from 'react'
import type { UpdateState } from '../../../../shared/updates'
import { BottomNotice, type BottomNoticeAction } from '../../components/BottomNotice'
import { useSettings } from '../../lib/settingsContext'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { useUpdates } from './updatesState'
import { actionFailedText, readyActionLabel, readyLaterText, readyNoticeText } from './updateText'

type Notice = NonNullable<UpdateState['notice']>

/** The ready notice's own action for `version`: under way, or why it did not start. */
interface Attempt {
  version: string
  pending: boolean
  failure: string | null
}

/**
 * The one-time bottom notice the main process owes for a release (`state.notice`). Never a dialog
 * and never takes focus; an unanswered notice changes nothing.
 *
 * - `available`: 查看更新 opens 设置 › 关于 and focuses it; 知道了 just closes.
 * - `ready` (a verified package, after a download or found at launch): 立即安装并重启 (Windows) /
 *   打开安装包 (Mac) runs the About section's own action; 稍后 just closes and says what happens
 *   instead. A failed action keeps the notice with the reason; when it also discarded the package,
 *   the notice turns into that failure with 查看更新 / 知道了.
 *
 * Every way of closing acknowledges the notice for its version and kind, and it stays gone at once,
 * before the main process reports it cleared.
 */
export function UpdateNotice({ fallbackFocus }: { fallbackFocus: () => HTMLElement | null }) {
  const { state } = useUpdates()
  const { settings } = useSettings()
  const openSettings = useSettingsOpener()
  /** Notices acknowledged in this run, as `version:kind`. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set())
  const [attempt, setAttempt] = useState<Attempt | null>(null)

  const notice = state !== null && state.unavailable === null ? state.notice : null
  const key = notice === null ? null : `${notice.version}:${notice.kind}`
  const release = state?.release?.info.version === notice?.version ? (state?.release ?? null) : null
  const status = release?.download.status
  const platform = state?.platform ?? 'none'
  const own = attempt !== null && notice?.kind === 'ready' && attempt.version === notice.version ? attempt : null
  const pending = own?.pending === true
  const packageReady = status === 'ready'
  // A ready notice whose package went away elsewhere has nothing left to offer (About says why).
  const open = notice !== null && key !== null && !acknowledged.has(key) && (notice.kind === 'available' || packageReady || own !== null)

  const acknowledge = (shown: Notice) => {
    setAcknowledged((set) => new Set(set).add(`${shown.version}:${shown.kind}`))
    window.xidao.updates.acknowledgeNotice({ version: shown.version, kind: shown.kind }).catch(() => undefined)
  }

  const viewUpdate = (shown: Notice): BottomNoticeAction[] =>
    openSettings === null
      ? []
      : [
          {
            label: '查看更新',
            leaves: true,
            onAction: () => {
              openSettings('about')
              acknowledge(shown)
            }
          }
        ]

  /** The same call as the About section's 安装并重启 / 打开安装包, with the same gate in the main process. */
  const runPackage = async (shown: Notice) => {
    setAttempt({ version: shown.version, pending: true, failure: null })
    let failure: string | null
    try {
      const result = platform === 'mac' ? await window.xidao.updates.openInstaller() : await window.xidao.updates.installAndRestart()
      failure = result.started ? null : actionFailedText(result.failure, platform)
    } catch {
      failure = actionFailedText('install', platform)
    }
    if (failure === null) {
      setAttempt(null)
      acknowledge(shown)
    } else {
      setAttempt({ version: shown.version, pending: false, failure })
    }
  }

  let message = ''
  let icon: 'download' | 'alert' = 'download'
  let tone: 'neutral' | 'warning' = 'neutral'
  let context: string | null = null
  let detail: string | null = null
  let actions: BottomNoticeAction[] = []
  if (notice?.kind === 'available') {
    const autoDownload = platform === 'mac' ? settings.updateAutoDownload : platform === 'windows' && settings.updateAutoInstall
    message =
      autoDownload && (status === 'downloading' || status === 'verifying')
        ? `发现新版本 ${notice.version}，正在自动下载`
        : `发现新版本 ${notice.version}`
    actions = [...viewUpdate(notice), { label: '知道了', onAction: () => acknowledge(notice) }]
  } else if (notice?.kind === 'ready' && (packageReady || pending)) {
    message = readyNoticeText(platform, notice.version)
    context = readyLaterText(platform, state?.installOnQuit === true)
    detail = own?.failure ?? null
    actions = [
      { label: readyActionLabel(platform), busy: pending, onAction: () => void runPackage(notice) },
      { label: '稍后', busy: pending, onAction: () => acknowledge(notice) }
    ]
  } else if (notice?.kind === 'ready' && own?.failure != null) {
    // The action's own check found the package unusable and removed it.
    message = own.failure
    icon = 'alert'
    tone = 'warning'
    actions = [...viewUpdate(notice), { label: '知道了', onAction: () => acknowledge(notice) }]
  }

  return (
    <BottomNotice open={open} icon={icon} tone={tone} context={context} detail={detail} actions={actions} fallbackFocus={fallbackFocus}>
      {message}
    </BottomNotice>
  )
}
