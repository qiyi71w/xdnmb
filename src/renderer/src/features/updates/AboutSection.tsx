// 设置 › 系统 › 关于: the app's identity (icon, name, the running version, shown only here) and
// every software-update control: check, the found release with its notes, download / install,
// and the update settings. Unavailable buttons stay focusable (aria-disabled) and ignore presses;
// the download / install action keeps one button across its states so focus stays on it.

import { useId, useState } from 'react'
import type { AppSettings } from '../../../../shared/settings'
import {
  UPDATE_AUTHOR_URL,
  UPDATE_NETWORKS,
  UPDATE_REPOSITORY_URL,
  type UpdateDownload,
  type UpdateNetwork,
  type UpdateState
} from '../../../../shared/updates'
import appIcon from '../../../../../resources/icons/xidao-icon-512.png'
import { Choice, Section, SettingRow, Switch, type Write } from '../../app/settingsSections'
import { Icon, Spinner } from '../../components/Icon'
import { formatRecordTime } from '../../lib/time'
import { formatBytes } from '../content/contentText'
import { ReleaseNotes } from './ReleaseNotes'
import { useUpdates } from './updatesState'
import {
  actionFailedText,
  checkFailedText,
  downloadFailedText,
  packageActionLabel,
  startupFailedText,
  UNAVAILABLE_NEXT,
  UNAVAILABLE_TEXT
} from './updateText'
import './updates.css'

const NETWORK_LABEL: Record<UpdateNetwork, string> = {
  system: '系统代理',
  direct: '直连'
}

function openExternal(url: string) {
  window.xidao.links.openExternal({ url }).catch(() => undefined)
}

/** An address opened in the system browser; named by what it is, showing where it goes. */
function ExternalLink({ name, url }: { name: string; url: string }) {
  const shown = url.replace(/^https:\/\//, '')
  return (
    <button
      type="button"
      className="btn btn-page about-link"
      aria-label={`${name}：${shown}`}
      title={`在系统浏览器中打开：${url}`}
      onClick={() => openExternal(url)}
    >
      <Icon name="external" size={14} />
      {shown}
    </button>
  )
}

export function AboutSection({ settings, write }: { settings: AppSettings; write: Write }) {
  const { state } = useUpdates()
  return (
    <Section id="settings-about" title="关于">
      <div className="about-identity">
        <img className="about-icon" src={appIcon} alt="" width={64} height={64} draggable={false} />
        <div className="about-name-block">
          <p className="about-name">汐岛</p>
          {state !== null && <p className="about-version">版本 {state.currentVersion}</p>}
        </div>
      </div>
      <dl className="about-links">
        <div>
          <dt>仓库</dt>
          <dd>
            <ExternalLink name="仓库" url={UPDATE_REPOSITORY_URL} />
          </dd>
        </div>
        <div>
          <dt>作者</dt>
          <dd>
            <ExternalLink name="作者" url={UPDATE_AUTHOR_URL} />
          </dd>
        </div>
      </dl>
      <UpdateArea settings={settings} write={write} />
    </Section>
  )
}

function UpdateArea({ settings, write }: { settings: AppSettings; write: Write }) {
  const { state, failed } = useUpdates()
  const statusId = useId()
  const [checkRequested, setCheckRequested] = useState(false)

  const status = state?.release?.download.status
  const transferring = status === 'downloading' || status === 'verifying'
  const working = state !== null && state.unavailable === null && (state.checking || checkRequested || transferring)
  const checkBlocked = state === null || state.unavailable !== null || working

  // A check, download or verification under way: the button keeps focus and ignores presses.
  const check = () => {
    if (checkBlocked) return
    setCheckRequested(true)
    window.xidao.updates
      .check()
      .catch(() => undefined)
      .finally(() => setCheckRequested(false))
  }

  const release = state !== null && state.unavailable === null ? state.release : null
  const platform = state?.platform ?? null

  return (
    <div className="about-update" role="group" aria-labelledby="settings-about-update">
      <h4 className="about-group-title" id="settings-about-update">
        软件更新
      </h4>
      <div className="about-check">
        <div className="about-check-status" id={statusId} role="status">
          <CheckStatus state={state} failed={failed} checking={checkRequested} />
          {state !== null && state.startupFailure !== null && (
            <p className="notice-inline is-warning about-status-line">
              <Icon name="alert" size={14} />
              <span>{startupFailedText(state.startupFailure, state.platform)}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-page"
          aria-disabled={checkBlocked || undefined}
          aria-busy={working || undefined}
          aria-describedby={statusId}
          onClick={check}
        >
          <Icon name="refresh" size={14} />
          检查更新
        </button>
      </div>

      {state !== null && release !== null && (
        <div className="about-release" role="group" aria-labelledby="settings-about-release">
          <div className="about-release-head">
            <h5 className="about-release-title" id="settings-about-release">
              新版本 {release.info.version}
            </h5>
            {release.info.releaseDate !== null && <span className="about-release-date">发布于 {formatRecordTime(release.info.releaseDate)}</span>}
          </div>
          <ReleaseNotes key={release.info.version} notes={release.info.notes} />
          <div className="about-release-page">
            <button type="button" className="btn btn-small btn-page" title={`在系统浏览器中打开：${release.info.pageUrl}`} onClick={() => openExternal(release.info.pageUrl)}>
              <Icon name="external" size={14} />
              在 GitHub 查看
            </button>
          </div>
          <PackageActions key={release.info.version} state={state} download={release.download} />
        </div>
      )}

      <SettingRow
        labelId="setting-update-auto-check"
        label="自动检查更新"
        help="启动时及运行中每 24 小时检查，关闭后仍可手动检查"
        helpId="setting-update-auto-check-help"
      >
        <Switch
          labelledBy="setting-update-auto-check"
          describedBy="setting-update-auto-check-help"
          checked={settings.updateAutoCheck}
          onToggle={() => write({ updateAutoCheck: !settings.updateAutoCheck })}
        />
      </SettingRow>
      {platform === 'windows' && (
        <SettingRow
          labelId="setting-update-auto-install"
          label="退出时自动安装更新"
          help="发现新版后自动下载，主动退出汐岛时安装，安装后不自动重新打开；收进托盘时不安装，直接关机或重启的，下次启动时先安装"
          helpId="setting-update-auto-install-help"
        >
          <Switch
            labelledBy="setting-update-auto-install"
            describedBy="setting-update-auto-install-help"
            checked={settings.updateAutoInstall}
            onToggle={() => write({ updateAutoInstall: !settings.updateAutoInstall })}
          />
        </SettingRow>
      )}
      {platform === 'mac' && (
        <SettingRow
          labelId="setting-update-auto-download"
          label="自动下载更新"
          help="下载后由你打开安装包手动替换"
          helpId="setting-update-auto-download-help"
        >
          <Switch
            labelledBy="setting-update-auto-download"
            describedBy="setting-update-auto-download-help"
            checked={settings.updateAutoDownload}
            onToggle={() => write({ updateAutoDownload: !settings.updateAutoDownload })}
          />
        </SettingRow>
      )}
      <SettingRow labelId="setting-update-network" label="更新网络" help="只用于检查和下载更新，不影响论坛、图片和搜索" helpId="setting-update-network-help">
        <Choice<UpdateNetwork>
          labelledBy="setting-update-network"
          describedBy="setting-update-network-help"
          options={UPDATE_NETWORKS.map((value) => ({ value, label: NETWORK_LABEL[value] }))}
          value={settings.updateNetwork}
          onChange={(updateNetwork) => write({ updateNetwork })}
        />
      </SettingRow>
    </div>
  )
}

/** The check's state: why this build cannot update, a running check, or the last result of this run. */
function CheckStatus({ state, failed, checking }: { state: UpdateState | null; failed: boolean; checking: boolean }) {
  if (state === null) {
    return failed ? (
      <p className="notice-inline is-warning">
        <Icon name="alert" size={14} />
        未能读取更新状态
      </p>
    ) : (
      <p className="about-status-line">正在读取更新状态…</p>
    )
  }
  if (state.unavailable !== null) {
    return (
      <>
        <p className="about-status-line">{UNAVAILABLE_TEXT[state.unavailable]}</p>
        <p className="setting-help">{UNAVAILABLE_NEXT}</p>
      </>
    )
  }
  if (state.checking || checking) {
    return (
      <p className="about-status-line">
        <Spinner />
        正在检查更新…
      </p>
    )
  }
  const last = state.lastCheck
  if (last === null) return <p className="about-status-line">本次启动后尚未检查更新</p>
  const at = <span className="about-check-time">{formatRecordTime(last.at)} 检查</span>
  switch (last.outcome) {
    case 'failed':
      return (
        <p className="notice-inline is-warning about-status-line">
          <Icon name="alert" size={14} />
          <span>
            {checkFailedText(last.failure, state.platform)} {at}
          </span>
        </p>
      )
    case 'up-to-date':
      return (
        <p className="about-status-line">
          已是最新版本 {at}
        </p>
      )
    case 'available':
      return (
        <p className="about-status-line">
          发现新版本 {at}
        </p>
      )
  }
}

/**
 * Download, cancel, verification and the package action of the found release. One button serves
 * every state (下载更新／重试 → 取消下载 → unavailable while verifying → 安装并重启／打开安装包),
 * so a keyboard user's focus stays on it as the state moves on.
 */
function PackageActions({ state, download }: { state: UpdateState; download: UpdateDownload }) {
  const statusId = useId()
  const { platform } = state
  /**
   * The download state a press was made in, until its call returns. The button is busy only while
   * the state is still that one: a download that runs on after `download()` returned, or a state
   * pushed before it returned, makes the next action (取消下载) available at once.
   */
  const [pressedIn, setPressedIn] = useState<UpdateDownload['status'] | null>(null)
  const pending = pressedIn === download.status
  /** What the last 安装并重启／打开安装包 press came to, when it did not hand over to the installer. */
  const [outcome, setOutcome] = useState<{ kind: 'failed'; text: string } | { kind: 'opened' } | null>(null)

  const run = async () => {
    setPressedIn('ready')
    setOutcome(null)
    try {
      const result = platform === 'mac' ? await window.xidao.updates.openInstaller() : await window.xidao.updates.installAndRestart()
      if (!result.started) setOutcome({ kind: 'failed', text: actionFailedText(result.failure, platform) })
      else if (platform === 'mac') setOutcome({ kind: 'opened' })
    } catch {
      setOutcome({ kind: 'failed', text: actionFailedText('install', platform) })
    } finally {
      setPressedIn(null)
    }
  }

  const call = (action: () => Promise<void>) => {
    setPressedIn(download.status)
    action()
      .catch(() => undefined)
      .finally(() => setPressedIn(null))
  }

  let label = ''
  let primary = true
  let available = !pending
  let onPress: () => void = () => undefined
  switch (download.status) {
    case 'none':
      label = download.failure === null ? '下载更新' : '重试'
      onPress = () => call(() => window.xidao.updates.download())
      break
    case 'downloading':
      label = '取消下载'
      primary = false
      onPress = () => call(() => window.xidao.updates.cancelDownload())
      break
    case 'verifying':
      label = packageActionLabel(platform)
      available = false
      break
    case 'ready':
      label = packageActionLabel(platform)
      onPress = () => void run()
      break
  }

  const percent =
    download.status === 'downloading' && download.total !== null && download.total > 0
      ? Math.min(100, Math.floor((download.transferred / download.total) * 100))
      : null
  const progressText =
    download.status !== 'downloading'
      ? ''
      : download.total === null
        ? `已下载 ${formatBytes(download.transferred)}`
        : `${formatBytes(download.transferred)} / ${formatBytes(download.total)}（${percent ?? 0}%）`

  return (
    <div className="about-package">
      <div className="about-package-status" id={statusId} role="status">
        {download.status === 'none' && download.failure !== null && (
          <p className="notice-inline is-warning">
            <Icon name="alert" size={14} />
            {downloadFailedText(download.failure, platform)}
          </p>
        )}
        {download.status === 'downloading' && <p className="about-status-line">正在下载更新</p>}
        {download.status === 'verifying' && (
          <p className="about-status-line">
            <Spinner />
            正在校验安装包…
          </p>
        )}
        {download.status === 'ready' && (
          <>
            <p className="about-status-line">安装包已下载并通过校验</p>
            {platform === 'mac' ? (
              <p className="setting-help">打开安装包后，请先退出汐岛，再把新版汐岛拖到“应用程序”文件夹替换旧版</p>
            ) : (
              <>
                <p className="setting-help">安装并重启会正常退出汐岛，安装完成后重新打开</p>
                {state.installOnQuit && <p className="setting-help">已开启退出时自动安装：退出汐岛时安装，安装后不自动重新打开；直接关机的，下次启动时安装</p>}
              </>
            )}
          </>
        )}
        {outcome?.kind === 'failed' && (
          <p className="notice-inline is-warning">
            <Icon name="alert" size={14} />
            {outcome.text}
          </p>
        )}
        {outcome?.kind === 'opened' && <p className="setting-help">已打开安装包</p>}
      </div>
      {download.status === 'downloading' && (
        <div
          className="about-progress"
          role="progressbar"
          aria-label="下载进度"
          aria-valuemin={percent === null ? undefined : 0}
          aria-valuemax={percent === null ? undefined : 100}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={progressText}
        >
          {percent !== null && (
            <span className="about-progress-bar" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </span>
          )}
          <span className="about-progress-text" aria-hidden="true">
            {progressText}
          </span>
        </div>
      )}
      <div className="about-package-actions">
        <button
          type="button"
          className={primary ? 'btn btn-primary' : 'btn btn-page'}
          aria-disabled={!available || undefined}
          aria-busy={pending || download.status === 'verifying' || undefined}
          aria-describedby={statusId}
          onClick={() => {
            if (available) onPress()
          }}
        >
          {label}
        </button>
      </div>
    </div>
  )
}
