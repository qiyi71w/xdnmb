import type { ReactNode } from 'react'
import type { ReadError } from '../../../shared/api'
import { describeFailure, describeReadError, formatLocalTime, identityErrorOf, serverMessageOf } from '../lib/format'
import type { Failure, Source } from '../lib/operations'
import { useSettingsOpener } from '../lib/settingsOpener'
import { Icon, Spinner } from './Icon'
import './notices.css'

/**
 * "打开设置" for a read that failed because of the browse identity (the read was never sent).
 * Renders nothing for any other error or outside the settings provider.
 */
export function IdentitySettingsAction({ error }: { error: Failure | ReadError | null }) {
  const openSettings = useSettingsOpener()
  if (openSettings === null || identityErrorOf(error) === null) return null
  return (
    <button type="button" className="btn btn-small" onClick={() => openSettings('cookies')}>
      打开设置
    </button>
  )
}

/** Inline progress line. Lives inside a polite live region owned by the caller or itself. */
export function Loading({ children, live = true }: { children: ReactNode; live?: boolean }) {
  return (
    <p className="loading" role={live ? 'status' : undefined}>
      <Spinner />
      <span>{children}</span>
    </p>
  )
}

/** Failure with a reason and a retry button. `title` names what failed. */
export function FailureNotice({
  title,
  failure,
  onRetry,
  retryLabel = '重试',
  compact = false
}: {
  title: string
  failure: Failure
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
}) {
  const serverMessage = serverMessageOf(failure)
  return (
    <div className={compact ? 'notice notice-error is-compact' : 'notice notice-error'} role="alert">
      <Icon name="alert" className="notice-icon" />
      <div className="notice-text">
        <p className="notice-title">
          {title}：{describeFailure(failure)}
        </p>
        {serverMessage !== null && <p className="notice-detail">论坛提示：{serverMessage}</p>}
      </div>
      <IdentitySettingsAction error={failure} />
      {onRetry !== undefined && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  )
}

/**
 * Data-origin notice. Fresh and saved data shows nothing; fresh but unsaved is a subtle hint;
 * cached data always says so, with the fetch time and why the network was not used.
 */
export function SourceNotice({ source, subject }: { source: Source; subject?: string }) {
  const prefix = subject === undefined ? '' : `${subject}：`
  if (source.status === 'fresh') {
    if (source.saved) return null
    return (
      <p className="notice-inline" role="status">
        <Icon name="info" size={14} />
        {prefix}未保存到本地
      </p>
    )
  }
  const time = formatLocalTime(source.fetchedAt)
  const error = source.networkError
  return (
    <div className="notice notice-cached" role="status">
      <Icon name="archive" className="notice-icon" />
      <div className="notice-text">
        <p className="notice-title">
          {prefix}
          {error === null ? `本地缓存（${time} 获取）` : `网络读取失败，显示 ${time} 获取的本地缓存`}
        </p>
        {error !== null && (
          <p className="notice-detail">
            原因：{describeReadError(error)}
            {error.serverMessage !== undefined && `；论坛提示：${error.serverMessage}`}
          </p>
        )}
      </div>
      <IdentitySettingsAction error={error} />
    </div>
  )
}

export function PartialNotice({ skipped, subject }: { skipped: number; subject?: string }) {
  if (skipped <= 0) return null
  return (
    <p className="notice-inline is-warning" role="status">
      <Icon name="alert" size={14} />
      {subject === undefined ? '' : `${subject}：`}部分条目无法解析，{skipped} 条未显示
    </p>
  )
}
