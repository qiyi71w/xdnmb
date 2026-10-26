import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { SubscriptionOverview, SubscriptionResult } from '../../../../shared/subscriptions'
import { Icon } from '../../components/Icon'
import { FailureNotice } from '../../components/Notices'
import { failureText, webObjectText } from './subscriptionText'
import type { SubscriptionsState } from './useSubscriptions'
import './subscriptions.css'

interface Message {
  tone: 'success' | 'error'
  text: string
}

function MessageLine({ id, message }: { id?: string; message: Message | null }) {
  return (
    <div id={id} className="form-message-region" role="status">
      {message !== null && (
        <p className={message.tone === 'error' ? 'form-message is-error' : 'form-message is-success'}>
          <Icon name={message.tone === 'error' ? 'alert' : 'info'} size={14} />
          <span>{message.text}</span>
        </p>
      )}
    </div>
  )
}

/**
 * 订阅 settings: the App UUID (shown in its field, saved with 保存) and the fixed web sync object,
 * which is chosen in 饼干 › 用途. Which source the list shows is switched on the subscription page.
 */
export function SubscriptionSection({ subscriptions }: { subscriptions: SubscriptionsState }) {
  const { overview, overviewFailed, refreshOverview } = subscriptions
  const headingId = useId()

  return (
    <section className="settings-section" aria-labelledby={headingId} aria-busy={(overview === null && !overviewFailed) || undefined}>
      <h3 className="settings-section-title" id={headingId}>
        订阅
      </h3>
      {overview === null && overviewFailed && (
        <FailureNotice title="订阅设置读取失败" failure={{ type: 'internal' }} onRetry={() => void refreshOverview()} compact />
      )}
      {overview !== null && (
        <>
          {overviewFailed && (
            <div className="notice notice-cached is-compact" role="status">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">订阅设置刷新失败，下面可能不是最新状态</p>
              <button type="button" className="btn btn-small" onClick={() => void refreshOverview()}>
                重试
              </button>
            </div>
          )}
          <SubscriptionSettings overview={overview} subscriptions={subscriptions} />
        </>
      )}
    </section>
  )
}

function SubscriptionSettings({ overview, subscriptions }: { overview: SubscriptionOverview; subscriptions: SubscriptionsState }) {
  return (
    <>
      {overview.protection === 'unavailable' && (
        <div className="notice notice-cached is-compact" role="note">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">系统凭据保护不可用，App UUID 与网页同步对象暂时无法使用</p>
        </div>
      )}
      {!overview.writable && (
        <div className="notice notice-cached" role="note">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">本地存储不可写</p>
        </div>
      )}
      <AppUuidForm overview={overview} busy={subscriptions.busy} onApplied={subscriptions.applyOverview} />
      <div className="settings-group">
        <h4 className="settings-group-title">网页同步对象</h4>
        <p className="sub-setting-value">{webObjectText(overview)}</p>
        <p className="settings-group-text">在「饼干 › 用途」中更换。</p>
      </div>
    </>
  )
}

function AppUuidForm({
  overview,
  busy,
  onApplied
}: {
  overview: SubscriptionOverview
  /** A write, preview or plan is running: its fixed UUID must not change under it from this form. */
  busy: boolean
  onApplied: (next: SubscriptionOverview) => void
}) {
  // Uncontrolled on purpose: React would mirror a controlled value into the `value` attribute.
  const uuidRef = useRef<HTMLInputElement>(null)
  const generateRef = useRef<HTMLButtonElement>(null)
  const cancelGenerateRef = useRef<HTMLButtonElement>(null)
  const [shown, setShown] = useState(true)
  /** The saved UUID as read back from main; `undefined` while reading, `null` when none is saved. */
  const [saved, setSaved] = useState<string | null | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<'set' | 'generate' | null>(null)
  const [confirmGenerate, setConfirmGenerate] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [invalid, setInvalid] = useState(false)
  const titleId = useId()
  const inputId = useId()
  const messageId = useId()
  const confirmId = useId()
  const blocked = overview.protection === 'unavailable' || !overview.writable || busy
  const savedRef = overview.context.appCredentialId

  // The field shows the saved UUID, read back from main (it stays encrypted at rest) on mount and
  // whenever the saved one changes.
  useEffect(() => {
    let alive = true
    window.xidao.subscriptions.revealAppUuid().then(
      (result) => {
        if (!alive) return
        if (!result.ok) {
          setSaved(null)
          setMessage({ tone: 'error', text: `已保存的 UUID 无法读取：${failureText(result.reason)}` })
          return
        }
        setSaved(result.value)
        if (uuidRef.current !== null) uuidRef.current.value = result.value ?? ''
        setDirty(false)
      },
      () => {
        if (alive) setSaved(null)
      }
    )
    return () => {
      alive = false
    }
  }, [savedRef])

  // The UUID never outlives this form (settings left or section unmounted).
  useEffect(() => {
    const input = uuidRef.current
    return () => {
      if (input !== null) input.value = ''
    }
  }, [])

  useEffect(() => {
    if (confirmGenerate) cancelGenerateRef.current?.focus()
  }, [confirmGenerate])

  const onInput = () => {
    if (invalid) setInvalid(false)
    setDirty((uuidRef.current?.value.trim().toLowerCase() ?? '') !== (saved ?? ''))
  }

  const apply = async (kind: 'set' | 'generate', uuid: string | null) => {
    if (pending !== null || blocked) return
    const before = overview.context.generation
    setPending(kind)
    setMessage(null)
    let result: SubscriptionResult<SubscriptionOverview>
    try {
      result = await window.xidao.subscriptions.configureApp({ uuid })
    } catch {
      setPending(null)
      setMessage({ tone: 'error', text: '请求失败，结果未知；请重新打开设置查看' })
      return
    }
    setPending(null)
    if (!result.ok) {
      setMessage({ tone: 'error', text: failureText(result.reason) })
      if (result.reason === 'invalid-uuid') {
        setInvalid(true)
        uuidRef.current?.focus()
      }
      return
    }
    setDirty(false)
    onApplied(result.value)
    const after = result.value.context.generation
    setMessage({
      tone: 'success',
      text: after === before ? '与当前 UUID 相同' : kind === 'generate' ? '已生成并保存新的 UUID' : '已保存'
    })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = uuidRef.current?.value.trim() ?? ''
    if (value === '') {
      setInvalid(true)
      setMessage({ tone: 'error', text: '请先输入 UUID' })
      uuidRef.current?.focus()
      return
    }
    void apply('set', value)
  }

  const generate = () => {
    if (pending !== null || confirmGenerate || blocked) return
    if (overview.appConfigured) setConfirmGenerate(true)
    else void apply('generate', null)
  }

  const closeConfirm = () => {
    setConfirmGenerate(false)
    generateRef.current?.focus()
  }

  const onConfirmKeyDown = (event: KeyboardEvent) => {
    // Esc cancels the inline step only; the dialog stays open.
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (pending === null) closeConfirm()
  }

  return (
    <form className="import-form" aria-labelledby={titleId} onSubmit={submit} noValidate>
      <fieldset className="import-fieldset" disabled={blocked}>
        <h4 className="import-title" id={titleId}>
          App 订阅 UUID
        </h4>
        {busy && <p className="field-hint">订阅操作进行中，结束后才能更换 UUID</p>}

        <label className="visually-hidden" htmlFor={inputId}>
          App 订阅 UUID
        </label>
        <div className="secret-row">
          <input
            id={inputId}
            ref={uuidRef}
            className="text-input secret-input"
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={saved === undefined ? undefined : '未设置'}
            aria-busy={saved === undefined || undefined}
            aria-describedby={invalid ? messageId : undefined}
            aria-invalid={invalid ? true : undefined}
            onInput={onInput}
          />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setShown((value) => !value)}
            aria-controls={inputId}
            aria-label={shown ? '隐藏 UUID' : '显示 UUID'}
          >
            {shown ? '隐藏' : '显示'}
          </button>
        </div>

        <div className="import-actions sub-uuid-actions">
          <button type="submit" className="btn btn-primary" disabled={pending !== null || !dirty} aria-describedby={messageId}>
            {pending === 'set' ? '正在保存…' : '保存'}
          </button>
          <button
            type="button"
            ref={generateRef}
            className="btn"
            onClick={generate}
            // Not disabled while busy: focus returns here from the confirmation and must not be dropped.
            aria-disabled={pending !== null || confirmGenerate ? true : undefined}
          >
            {pending === 'generate' ? '正在生成…' : '生成新的 UUID'}
          </button>
        </div>

        {confirmGenerate && (
          <div className="credential-confirm sub-confirm-inline" role="group" aria-labelledby={confirmId} onKeyDown={onConfirmKeyDown}>
            <p className="credential-confirm-title" id={confirmId}>
              生成新的 UUID？
            </p>
            <p className="credential-confirm-text">App 订阅将换到一份新的空集合，原集合保留。</p>
            <div className="credential-confirm-actions">
              <button
                type="button"
                className="btn btn-small btn-danger"
                disabled={pending !== null}
                onClick={() => {
                  setConfirmGenerate(false)
                  generateRef.current?.focus()
                  void apply('generate', null)
                }}
              >
                确认生成
              </button>
              <button type="button" ref={cancelGenerateRef} className="btn btn-small" onClick={closeConfirm} disabled={pending !== null}>
                取消
              </button>
            </div>
          </div>
        )}
      </fieldset>
      <MessageLine id={messageId} message={message} />
    </form>
  )
}
