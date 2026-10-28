import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { DEFAULT_CACHE_LIMIT, type ContentUsage } from '../../../../shared/content'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { singleFlight } from '../../lib/singleFlight'
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
  /** 应用 has nothing to save (empty, invalid or the current limit) or something is saving. */
  const applyUnavailable = parsed === null || unchanged || busy !== null
  /** Taken synchronously: a second Enter or click before the busy state renders does nothing. */
  const [flight] = useState(singleFlight)

  const saveLimit = (bytes: number) =>
    flight.run(async () => {
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
    })

  // The button, Enter in the field and any other implicit submission all end here.
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!applyUnavailable && parsed !== null) void saveLimit(parsed)
  }

  const clear = () =>
    flight.run(async () => {
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
        setMessage({ error: false, text: left === 0 ? '普通缓存已清理' : `普通缓存已清理，${formatBytes(left)} 暂时无法删除` })
      } else {
        setMessage({ error: true, text: `清理未完成：${contentFailureText(result?.ok === false ? result : null)}` })
      }
    })

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
            <p className="notice-title">
              本地占用读取失败：{contentFailureText(state.refused)}
              <KaomojiDecor state="failure" />
            </p>
          </div>
          <button type="button" className="btn btn-small btn-page" onClick={() => void load()}>
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
                受保护的内容使占用无法回到上限以内
              </p>
            )}
          </div>

          <div className="usage-block">
            <span className="setting-label">受保护内容</span>
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
          </div>

          <div className="usage-block">
            <div className="usage-head">
              <span className="setting-label">数据库文件</span>
              <span className="usage-total" title={exactBytes(usage.databaseBytes)}>
                {formatBytes(usage.databaseBytes)}
              </span>
            </div>
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
              {/* 应用 stays focusable while unavailable (focus is kept while saving); the form's submit checks it. */}
              <button type="submit" className="btn btn-page" aria-disabled={applyUnavailable || undefined} aria-busy={busy === 'limit' || undefined}>
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
              <p className="history-confirm-impact">将删除约 {formatBytes(cacheBytes)} 普通缓存。</p>
              <div className="history-confirm-actions">
                <button ref={confirmRef} type="button" className="btn btn-small btn-danger btn-page" aria-busy={busy === 'clear' || undefined} onClick={() => void clear()}>
                  {busy === 'clear' ? '正在清理…' : '确认清理'}
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-page"
                  aria-disabled={busy === 'clear' || undefined}
                  onClick={() => {
                    if (busy !== 'clear') setConfirming(false)
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                ref={clearRef}
                type="button"
                className="btn btn-danger btn-page"
                aria-disabled={busy !== null || undefined}
                onClick={() => {
                  if (busy !== null) return
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
