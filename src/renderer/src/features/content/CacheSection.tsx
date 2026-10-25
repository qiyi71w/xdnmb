import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { DEFAULT_CACHE_LIMIT, type ContentUsage } from '../../../../shared/content'
import { Icon } from '../../components/Icon'
import { attempt, contentFailureText, exactBytes, formatBytes, limitToGbText, parseLimitGb, type Refused } from './contentText'
import './content.css'

type UsageState = { status: 'loading' } | { status: 'failed'; refused: Refused } | { status: 'ready'; usage: ContentUsage }

/**
 * 存储与缓存 settings: the ordinary cache limit (decimal GB), logical usage of evictable text and
 * images, protected content and personal records listed apart, and the database's physical size.
 * Clearing removes only evictable cache, after confirmation.
 */
export function CacheSection() {
  const headingId = useId()
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const [state, setState] = useState<UsageState>({ status: 'loading' })
  const [limitText, setLimitText] = useState('')
  const [busy, setBusy] = useState<'limit' | 'clear' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const alive = useRef(true)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const clearRef = useRef<HTMLButtonElement>(null)

  const apply = useCallback((usage: ContentUsage) => {
    setState({ status: 'ready', usage })
    setLimitText(limitToGbText(usage.limitBytes))
  }, [])

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    const result = await attempt(() => window.xidao.content.usage())
    if (!alive.current) return
    if (result?.ok === true) apply(result.value)
    else setState({ status: 'failed', refused: result?.ok === false ? result : null })
  }, [apply])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  // The confirmation takes focus; leaving it returns focus to 清理普通缓存.
  const wasConfirming = useRef(false)
  useLayoutEffect(() => {
    if (confirming) confirmRef.current?.focus()
    else if (wasConfirming.current) clearRef.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  const parsed = parseLimitGb(limitText)
  const usage = state.status === 'ready' ? state.usage : null
  const unchanged = usage !== null && parsed === usage.limitBytes

  const saveLimit = async (bytes: number) => {
    if (busy !== null) return
    setBusy('limit')
    setMessage(null)
    const result = await attempt(() => window.xidao.content.setCacheLimit({ bytes }))
    if (!alive.current) return
    setBusy(null)
    if (result?.ok === true) {
      apply(result.value)
      setMessage({ error: false, text: `上限已设为 ${formatBytes(result.value.limitBytes)}（${exactBytes(result.value.limitBytes)}）` })
    } else {
      setMessage({ error: true, text: `上限未保存：${contentFailureText(result?.ok === false ? result : null)}` })
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (parsed !== null && !unchanged) void saveLimit(parsed)
  }

  const clear = async () => {
    if (busy !== null) return
    setBusy('clear')
    setMessage(null)
    const result = await attempt(() => window.xidao.content.clearCache())
    if (!alive.current) return
    setBusy(null)
    setConfirming(false)
    if (result?.ok === true) {
      apply(result.value)
      const left = result.value.cacheTextBytes + result.value.cacheImageBytes
      setMessage({
        error: false,
        text:
          left === 0
            ? '普通缓存已清理。数据库文件不一定立刻缩小。'
            : `普通缓存已清理，仍有 ${formatBytes(left)} 暂时无法删除（例如正在使用）。数据库文件不一定立刻缩小。`
      })
    } else {
      setMessage({ error: true, text: `清理未完成：${contentFailureText(result?.ok === false ? result : null)}，缓存保持原样或只清理了一部分` })
    }
  }

  const cacheBytes = usage === null ? 0 : usage.cacheTextBytes + usage.cacheImageBytes
  const ratio = usage === null || usage.limitBytes === 0 ? (cacheBytes > 0 ? 1 : 0) : Math.min(1, cacheBytes / usage.limitBytes)
  const invalid = limitText.trim() !== '' && parsed === null

  return (
    <section className="settings-section" aria-labelledby={headingId} aria-busy={state.status === 'loading' || undefined}>
      <h3 className="settings-section-title" id={headingId}>
        存储与缓存
      </h3>

      {state.status === 'failed' && (
        <div className="notice notice-error" role="alert">
          <Icon name="alert" className="notice-icon" />
          <div className="notice-text">
            <p className="notice-title">本地占用读取失败：{contentFailureText(state.refused)}</p>
          </div>
          <button type="button" className="btn btn-small" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {usage !== null && (
        <>
          <div className="usage-block">
            <div className="usage-head">
              <span className="setting-label">普通缓存</span>
              <span className="usage-total" title={`${exactBytes(cacheBytes)} / ${exactBytes(usage.limitBytes)}`}>
                {formatBytes(cacheBytes)} / {formatBytes(usage.limitBytes)}
              </span>
            </div>
            <div className={usage.overLimit ? 'usage-bar is-over' : 'usage-bar'} aria-hidden="true">
              <span style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
            </div>
            <dl className="usage-list">
              <div>
                <dt>文字</dt>
                <dd title={exactBytes(usage.cacheTextBytes)}>{formatBytes(usage.cacheTextBytes)}</dd>
              </div>
              <div>
                <dt>图片</dt>
                <dd title={exactBytes(usage.cacheImageBytes)}>{formatBytes(usage.cacheImageBytes)}</dd>
              </div>
            </dl>
            {usage.overLimit && !usage.protectedOverLimit && (
              <p className="notice-inline is-warning" role="status">
                <Icon name="alert" size={14} />
                普通缓存超过上限，会逐步删除较久未用的内容
              </p>
            )}
            {usage.protectedOverLimit && (
              <p className="notice-inline is-warning" role="status">
                <Icon name="alert" size={14} />
                受保护的内容让占用无法回到上限以内；汐岛不会为满足上限删除正在阅读的串、离线副本或草稿
              </p>
            )}
          </div>

          <div className="usage-block">
            <span className="setting-label">受保护内容（不会被清理）</span>
            <dl className="usage-list">
              <div>
                <dt>文字</dt>
                <dd title={exactBytes(usage.protectedTextBytes)}>{formatBytes(usage.protectedTextBytes)}</dd>
              </div>
              <div>
                <dt>图片</dt>
                <dd title={exactBytes(usage.protectedImageBytes)}>{formatBytes(usage.protectedImageBytes)}</dd>
              </div>
              <div>
                <dt>个人记录</dt>
                <dd title={exactBytes(usage.personalDataBytes)}>{formatBytes(usage.personalDataBytes)}</dd>
              </div>
            </dl>
            <p className="setting-help">正在打开的串、离线副本和草稿受保护，不随普通缓存清理。</p>
          </div>

          <div className="usage-block">
            <div className="usage-head">
              <span className="setting-label">数据库文件</span>
              <span className="usage-total" title={exactBytes(usage.databaseBytes)}>
                {formatBytes(usage.databaseBytes)}
              </span>
            </div>
            <p className="setting-help">磁盘上的实际大小，不含图片文件。</p>
          </div>

          <form className="limit-form" onSubmit={onSubmit}>
            <label className="field-label" htmlFor={inputId}>
              普通缓存上限（GB）
            </label>
            <div className="limit-row">
              <input
                id={inputId}
                className="text-input limit-input"
                inputMode="decimal"
                autoComplete="off"
                value={limitText}
                onChange={(event) => setLimitText(event.target.value)}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}
              />
              <button type="submit" className="btn" disabled={parsed === null || unchanged || busy !== null} aria-busy={busy === 'limit' || undefined}>
                {busy === 'limit' ? '正在保存…' : '应用'}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                disabled={usage.limitBytes === DEFAULT_CACHE_LIMIT || busy !== null}
                onClick={() => void saveLimit(DEFAULT_CACHE_LIMIT)}
              >
                恢复默认 2 GB
              </button>
            </div>
            <p className="field-hint" id={hintId}>
              填 0 表示不保留普通缓存。
            </p>
            {invalid && (
              <p className="field-warning" id={errorId}>
                <Icon name="alert" size={14} />
                请输入 0 到 1000000 之间的数字，最多 9 位小数
              </p>
            )}
          </form>

          {confirming ? (
            <div className="history-confirm" role="group" aria-label="确认清理普通缓存">
              <p className="history-confirm-title">清理普通缓存？</p>
              <p className="history-confirm-impact">
                将删除约 {formatBytes(cacheBytes)} 可清理的文字和图片缓存；之后再看这些内容需要重新从论坛读取。正在打开的串、离线副本、草稿、收藏、历史和阅读进度都不受影响。数据库文件不一定立刻缩小。
              </p>
              <div className="history-confirm-actions">
                <button ref={confirmRef} type="button" className="btn btn-small btn-danger" aria-busy={busy === 'clear' || undefined} onClick={() => void clear()}>
                  {busy === 'clear' ? '正在清理…' : '确认清理'}
                </button>
                <button type="button" className="btn btn-small" disabled={busy === 'clear'} onClick={() => setConfirming(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                ref={clearRef}
                type="button"
                className="btn btn-danger"
                disabled={busy !== null}
                onClick={() => {
                  setMessage(null)
                  setConfirming(true)
                }}
              >
                <Icon name="trash" />
                清理普通缓存…
              </button>
            </div>
          )}
        </>
      )}

      {message !== null && (
        <p className={message.error ? 'form-message is-error' : 'notice-inline'} role={message.error ? 'alert' : 'status'}>
          <Icon name={message.error ? 'alert' : 'check'} size={14} />
          {message.text}
        </p>
      )}
    </section>
  )
}
