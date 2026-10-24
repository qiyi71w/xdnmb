import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { SubscriptionOverview, SubscriptionResult, SubscriptionSource } from '../../../../shared/subscriptions'
import { Icon } from '../../components/Icon'
import { FailureNotice, Loading } from '../../components/Notices'
import { SOURCE_SHORT, failureText, webObjectText } from './subscriptionText'
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
 * 订阅 settings: the viewed source, the App UUID (write-only, never shown back) and the fixed web
 * sync object, which is chosen in 饼干 › 用途.
 */
export function SubscriptionSection({ subscriptions }: { subscriptions: SubscriptionsState }) {
  const { overview, overviewFailed, refreshOverview } = subscriptions
  const headingId = useId()

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        订阅
      </h3>
      {overview === null && !overviewFailed && <Loading>正在读取订阅设置…</Loading>}
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
        <div className="notice notice-cached" role="note">
          <Icon name="alert" className="notice-icon" />
          <div className="notice-text">
            <p className="notice-title">系统凭据保护不可用</p>
            <p>App UUID 与网页同步对象暂时无法使用，也不能保存新的 UUID；不会以明文保存。</p>
          </div>
        </div>
      )}
      {!overview.writable && (
        <div className="notice notice-cached" role="note">
          <Icon name="alert" className="notice-icon" />
          <div className="notice-text">
            <p className="notice-title">本地存储不可写</p>
            <p>暂时无法更换 App UUID 或切换来源。</p>
          </div>
        </div>
      )}
      <SourcePicker overview={overview} onApplied={subscriptions.applyOverview} />
      <AppUuidForm overview={overview} onApplied={subscriptions.applyOverview} />
      <div className="settings-group">
        <h4 className="settings-group-title">网页同步对象</h4>
        <p className="sub-setting-value">{webObjectText(overview)}</p>
        <p className="settings-group-text">
          固定绑定一块饼干，在上方「饼干 › 用途 › 网页同步对象」中更换；浏览或发言饼干改变时不会跟着改变。
        </p>
      </div>
      <p className="settings-note">
        <Icon name="info" size={14} />
        当前配置代次 {overview.context.generation}。更换 UUID 或同步对象会进入新的代次，之前的观察与操作记录保留各自的代次。
      </p>
    </>
  )
}

function SourcePicker({ overview, onApplied }: { overview: SubscriptionOverview; onApplied: (next: SubscriptionOverview) => void }) {
  const labelId = useId()
  const helpId = useId()
  const [pending, setPending] = useState<SubscriptionSource | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (source: SubscriptionSource) => {
    if (pending !== null || source === overview.source) return
    setPending(source)
    setError(null)
    try {
      const result = await window.xidao.subscriptions.selectSource({ source })
      if (result.ok) onApplied(result.value)
      else setError(`未切换：${failureText(result.reason)}`)
    } catch {
      setError('切换请求失败，未切换，请重试')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="settings-group">
      <h4 className="settings-group-title" id={labelId}>
        查看的订阅来源
      </h4>
      <div className="segmented" role="group" aria-labelledby={labelId} aria-describedby={helpId}>
        {(['app', 'web'] as const).map((source) => (
          <button
            key={source}
            type="button"
            className="segmented-item"
            aria-pressed={overview.source === source}
            aria-busy={pending === source ? true : undefined}
            disabled={!overview.writable}
            onClick={() => void choose(source)}
          >
            {SOURCE_SHORT[source]}
          </button>
        ))}
      </div>
      <p className="settings-group-text" id={helpId}>
        只切换显示哪一份远端列表，不复制集合，不改变发言或浏览饼干。
      </p>
      <MessageLine message={error === null ? null : { tone: 'error', text: error }} />
    </div>
  )
}

function AppUuidForm({ overview, onApplied }: { overview: SubscriptionOverview; onApplied: (next: SubscriptionOverview) => void }) {
  // Uncontrolled on purpose: React would mirror a controlled value into the `value` attribute.
  const uuidRef = useRef<HTMLInputElement>(null)
  const generateRef = useRef<HTMLButtonElement>(null)
  const cancelGenerateRef = useRef<HTMLButtonElement>(null)
  const [shown, setShown] = useState(false)
  const [pending, setPending] = useState<'set' | 'generate' | null>(null)
  const [confirmGenerate, setConfirmGenerate] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [invalid, setInvalid] = useState(false)
  const titleId = useId()
  const inputId = useId()
  const hintId = useId()
  const messageId = useId()
  const confirmId = useId()
  const blocked = overview.protection === 'unavailable' || !overview.writable

  // The typed UUID never outlives this form (dialog closed or section unmounted).
  useEffect(() => {
    const input = uuidRef.current
    return () => {
      if (input !== null) input.value = ''
    }
  }, [])

  useEffect(() => {
    if (confirmGenerate) cancelGenerateRef.current?.focus()
  }, [confirmGenerate])

  const clearInput = () => {
    if (uuidRef.current !== null) uuidRef.current.value = ''
    setShown(false)
    setInvalid(false)
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
      setMessage({ tone: 'error', text: '请求失败，结果未知；请重新打开设置查看当前状态' })
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
    clearInput()
    onApplied(result.value)
    const after = result.value.context.generation
    setMessage({
      tone: 'success',
      text:
        after === before
          ? '与当前 UUID 相同，配置没有变化。'
          : kind === 'generate'
            ? `已生成并保存新的 UUID，进入配置代次 ${after}。UUID 不会再显示；之前的远端集合和本地阅读资料保留。`
            : `已保存这个 UUID，进入配置代次 ${after}。UUID 不会再显示；之前的远端集合和本地阅读资料保留。`
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
        <p className="sub-setting-value">
          {overview.appConfigured
            ? `已设置 · 本机引用 #${overview.context.appCredentialId ?? '未知'}`
            : '未设置'}
        </p>

        <label className="field-label" htmlFor={inputId}>
          {overview.appConfigured ? '更换为另一个 UUID' : '使用已有的 UUID'}
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
            placeholder="粘贴或输入 UUID"
            aria-describedby={invalid ? `${hintId} ${messageId}` : hintId}
            aria-invalid={invalid ? true : undefined}
            onInput={() => {
              if (invalid) setInvalid(false)
            }}
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
        <p className="field-hint" id={hintId}>
          默认遮蔽显示，按系统凭据保护保存，保存后不会再显示。更换只切换到另一份远端集合，不搬运旧集合。
        </p>

        <div className="import-actions sub-uuid-actions">
          <button type="submit" className="btn btn-primary" disabled={pending !== null} aria-describedby={messageId}>
            {pending === 'set' ? '正在保存…' : '使用这个 UUID'}
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
            <p className="credential-confirm-text">
              App 订阅将切换到一份新的空集合。当前 UUID 的远端集合不会被删除或搬运，本地阅读资料保留；新 UUID 不会显示出来。
            </p>
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
