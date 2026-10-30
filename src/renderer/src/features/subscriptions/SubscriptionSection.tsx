import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { AppSettings } from '../../../../shared/settings'
import type { SubscriptionOverview, SubscriptionResult, SubscriptionSource } from '../../../../shared/subscriptions'
import { Choice, SettingRow, type Write } from '../../app/settingsSections'
import { ContextMenu, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { FailureNotice } from '../../components/Notices'
import { singleFlight } from '../../lib/singleFlight'
import { useClearOnLeave } from '../../lib/useClearOnLeave'
import { useListOpener } from '../reminders/openList'
import { failureText, SOURCE_NAME, webObjectText } from './subscriptionText'
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

const SOURCES: readonly SubscriptionSource[] = ['app', 'web']

/**
 * 订阅 settings: where the thread toolbar's 订阅 writes (a saved setting of its own, never the
 * source the subscription page shows), the App UUID (shown in its field, saved with 保存) and the
 * fixed web sync object, which is chosen in 饼干 › 用途. Which source the list shows is switched on
 * the subscription page.
 */
export function SubscriptionSection({
  subscriptions,
  active,
  settings,
  write
}: {
  subscriptions: SubscriptionsState
  active: boolean
  settings: AppSettings
  write: Write
}) {
  const { overview, overviewFailed, refreshOverview } = subscriptions
  const headingId = useId()

  return (
    <section className="settings-section" aria-labelledby={headingId} aria-busy={(overview === null && !overviewFailed) || undefined}>
      <h3 className="settings-section-title" id={headingId}>
        订阅
      </h3>
      {/* Only saved here: choosing never reads, writes or switches any subscription. */}
      <SettingRow
        labelId="setting-default-subscription-source"
        label="串工具栏默认订阅到"
        help="按钮旁的箭头可单独订阅到另一来源"
        helpId="setting-default-subscription-source-help"
      >
        <Choice<SubscriptionSource>
          labelledBy="setting-default-subscription-source"
          describedBy="setting-default-subscription-source-help"
          options={SOURCES.map((value) => ({ value, label: SOURCE_NAME[value] }))}
          value={settings.defaultSubscriptionSource}
          onChange={(defaultSubscriptionSource) => write({ defaultSubscriptionSource })}
        />
      </SettingRow>
      {overview === null && overviewFailed && (
        <FailureNotice title="订阅设置读取失败" failure={{ type: 'internal' }} onRetry={() => void refreshOverview()} compact />
      )}
      {overview !== null && (
        <>
          {overviewFailed && (
            <div className="notice notice-cached is-compact" role="status">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">
                订阅设置刷新失败，下面可能不是最新状态
                <KaomojiDecor state="failure" />
              </p>
              <button type="button" className="btn btn-small btn-page" onClick={() => void refreshOverview()}>
                重试
              </button>
            </div>
          )}
          <SubscriptionSettings overview={overview} subscriptions={subscriptions} active={active} />
        </>
      )}
    </section>
  )
}

function SubscriptionSettings({ overview, subscriptions, active }: { overview: SubscriptionOverview; subscriptions: SubscriptionsState; active: boolean }) {
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
      <AppUuidForm overview={overview} busy={subscriptions.busy} onApplied={subscriptions.applyOverview} active={active} />
      <MergeEntry overview={overview} subscriptions={subscriptions} />
      <div className="settings-group">
        <h4 className="settings-group-title">网页同步对象</h4>
        <p className="sub-setting-value">{webObjectText(overview)}</p>
        <p className="settings-group-text">在「饼干 › 用途」中更换。</p>
      </div>
    </>
  )
}

/**
 * 从旧 UUID 合并…: choose an App UUID used before; its threads missing from the current App
 * subscription show in the subscription page's one-page view (加入／不动 only).
 */
function MergeEntry({ overview, subscriptions }: { overview: SubscriptionOverview; subscriptions: SubscriptionsState }) {
  const { busy, mergeSources, mergeSourcesFailed, refreshMergeSources, startPreview, requestReveal } = subscriptions
  const openList = useListOpener()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menuAt, setMenuAt] = useState<ContextMenuPoint | null>(null)
  const hintId = useId()
  const current = overview.context.appCredentialId
  // The current App UUID is the merge target, never also its source.
  const sources = (mergeSources ?? []).filter((source) => source.appCredentialId !== current)
  const hint =
    overview.protection === 'unavailable' || !overview.writable
      ? null
      : !overview.appConfigured
        ? '先设置 App 订阅 UUID'
        : busy
          ? '订阅操作进行中，结束后才能合并'
          : mergeSources !== null && !mergeSourcesFailed && sources.length === 0
            ? '还没有用过其他 App UUID'
            : null
  const blocked = overview.protection === 'unavailable' || !overview.writable || !overview.appConfigured || busy || sources.length === 0
  if (openList === null) return null

  return (
    <div className="settings-group sub-merge">
      <button
        type="button"
        ref={buttonRef}
        className="btn btn-page"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        aria-disabled={blocked || undefined}
        aria-describedby={hint === null ? undefined : hintId}
        onClick={(event) => {
          if (blocked) return
          const box = event.currentTarget.getBoundingClientRect()
          setMenuAt({ x: box.left, y: box.bottom + 4 })
        }}
      >
        从旧 UUID 合并…
      </button>
      {hint !== null && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {mergeSourcesFailed && (
        <div className="notice notice-error is-compact" role="alert">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">
            用过的 App UUID 读取失败
            <KaomojiDecor state="failure" />
          </p>
          <button type="button" className="btn btn-small btn-page" onClick={() => void refreshMergeSources()}>
            重试
          </button>
        </div>
      )}
      {menuAt !== null && (
        <ContextMenu
          point={menuAt}
          label="从哪个旧 UUID 合并"
          items={sources.map((source) => ({
            type: 'action' as const,
            key: source.appCredentialId,
            label: source.label,
            onSelect: () => {
              // Leaves settings for the subscription page, which shows the preview as it is read.
              void startPreview('merge', source)
              requestReveal()
              openList({ kind: 'subscriptions' })
            }
          }))}
          onClose={(returnFocus) => {
            setMenuAt(null)
            if (returnFocus) buttonRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function AppUuidForm({
  overview,
  busy,
  onApplied,
  active
}: {
  overview: SubscriptionOverview
  /** A write, preview or plan is running: its fixed UUID must not change under it from this form. */
  busy: boolean
  onApplied: (next: SubscriptionOverview) => void
  /** 设置 is the active tab: only then does the field hold the UUID. */
  active: boolean
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
  const begin = useClearOnLeave(active, () => setMessage((last) => (last?.tone === 'success' ? null : last)))

  // While 设置 is shown, the field shows the saved UUID, read back from main (it stays encrypted at
  // rest) each time 设置 is shown and whenever the saved one changes. Another tab shown, the field
  // and this form forget it, an unsaved entry with it; a read still under way is dropped.
  useEffect(() => {
    if (!active) {
      if (uuidRef.current !== null) uuidRef.current.value = ''
      setSaved(undefined)
      setShown(true)
      setDirty(false)
      setInvalid(false)
      return
    }
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
  }, [savedRef, active])

  // The UUID never outlives this form (设置 closed or section unmounted).
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

  /** Taken synchronously: a second press or Enter before `pending` renders does not write twice. */
  const [flight] = useState(singleFlight)
  const apply = (kind: 'set' | 'generate', uuid: string | null) =>
    flight.run(async () => {
      if (pending !== null || blocked) return
      const before = overview.context.generation
      setPending(kind)
      setMessage(null)
      const current = begin()
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
      if (current()) setMessage({
        tone: 'success',
        text: after === before ? '与当前 UUID 相同' : kind === 'generate' ? '已生成并保存新的 UUID' : '已保存'
      })
    })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    // Nothing at all while blocked or writing: no message, no field state, no write.
    if (blocked || pending !== null) return
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
    if (pending === null && !blocked) closeConfirm()
  }

  return (
    <form className="import-form" aria-labelledby={titleId} onSubmit={submit} noValidate>
      {/* Not a disabled fieldset: that would take the page buttons out of the tab order too. The
          field and 保存 are disabled one by one; every handler here refuses while `blocked`. */}
      <fieldset className="import-fieldset">
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
            disabled={blocked}
          />
          <button
            type="button"
            className="btn btn-small btn-page"
            aria-disabled={blocked || undefined}
            onClick={() => {
              if (!blocked) setShown((value) => !value)
            }}
            aria-controls={inputId}
            aria-label={shown ? '隐藏 UUID' : '显示 UUID'}
          >
            {shown ? '隐藏' : '显示'}
          </button>
        </div>

        <div className="import-actions sub-uuid-actions">
          <button type="submit" className="btn btn-primary" disabled={blocked || pending !== null || !dirty} aria-describedby={messageId}>
            {pending === 'set' ? '正在保存…' : '保存'}
          </button>
          <button
            type="button"
            ref={generateRef}
            className="btn btn-page"
            onClick={generate}
            // Not disabled while busy: focus returns here from the confirmation and must not be dropped.
            aria-disabled={blocked || pending !== null || confirmGenerate ? true : undefined}
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
                className="btn btn-small btn-danger btn-page"
                aria-disabled={pending !== null || blocked || undefined}
                onClick={() => {
                  if (pending !== null || blocked) return
                  setConfirmGenerate(false)
                  generateRef.current?.focus()
                  void apply('generate', null)
                }}
              >
                确认生成
              </button>
              <button
                type="button"
                ref={cancelGenerateRef}
                className="btn btn-small btn-page"
                aria-disabled={pending !== null || blocked || undefined}
                onClick={() => {
                  if (pending === null && !blocked) closeConfirm()
                }}
              >
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
