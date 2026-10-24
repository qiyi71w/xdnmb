import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import {
  IDENTITY_ROLES,
  type CredentialSummary,
  type IdentityMutationResult,
  type IdentityOverview,
  type IdentityRole
} from '../../../../shared/identity'
import { Icon } from '../../components/Icon'
import { FailureNotice, Loading } from '../../components/Notices'
import { formatLocalTime } from '../../lib/format'
import {
  MISSING_SELECTION_TEXT,
  ROLE_INFO,
  SOURCE_LABEL,
  checkName,
  importFailureText,
  nameErrorText,
  roleList,
  rolesUsing,
  type FailureField,
  type ImportEntry
} from './identityText'
import type { IdentitiesState } from './useIdentities'
import './identity.css'

type Tone = 'success' | 'error'
interface Message {
  tone: Tone
  text: string
}

/**
 * 饼干 settings: imported credentials, the two paste entries and the three independent role selectors.
 * Pasted secrets live only in the DOM value of their (uncontrolled) inputs while this section is mounted.
 */
export function CookieSection({ identities }: { identities: IdentitiesState }) {
  const { overview, failed, refresh } = identities
  const headingId = useId()

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        饼干
      </h3>

      {overview === null && !failed && <Loading>正在读取饼干信息…</Loading>}
      {overview === null && failed && (
        <FailureNotice title="饼干信息读取失败" failure={{ type: 'internal' }} onRetry={() => void refresh()} compact />
      )}
      {overview !== null && (
        <>
          {failed && (
            <div className="notice notice-cached is-compact" role="status">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">饼干信息刷新失败，下面可能不是最新状态</p>
              <button type="button" className="btn btn-small" onClick={() => void refresh()}>
                重试
              </button>
            </div>
          )}
          <CookieSettings overview={overview} onChanged={refresh} />
        </>
      )}
    </section>
  )
}

function CookieSettings({ overview, onChanged }: { overview: IdentityOverview; onChanged: () => Promise<void> }) {
  const protectionOk = overview.protection === 'available'
  const importBlocked = !protectionOk || !overview.writable

  return (
    <>
      {!protectionOk && (
        <div className="notice notice-cached" role="note">
          <Icon name="alert" className="notice-icon" />
          <div className="notice-text">
            <p className="notice-title">系统凭据保护不可用，不会以明文保存</p>
            <p>暂时无法导入饼干，需要饼干的读取也会被阻止。已导入的饼干仍可重命名、移除或调整用途。</p>
          </div>
        </div>
      )}
      {!overview.writable && (
        <div className="notice notice-cached" role="note">
          <Icon name="alert" className="notice-icon" />
          <div className="notice-text">
            <p className="notice-title">本地存储不可写</p>
            <p>暂时无法导入、重命名、移除饼干或更改用途。</p>
          </div>
        </div>
      )}

      <CredentialList overview={overview} onChanged={onChanged} />

      <div className="cookie-imports">
        <ImportForm entry="export" disabled={importBlocked} onImported={onChanged} />
        <ImportForm entry="raw" disabled={importBlocked} onImported={onChanged} />
      </div>
      <p className="settings-note">
        <Icon name="info" size={14} />
        账号登录、领取和导出请在官网完成。
      </p>

      <div className="settings-group">
        <h4 className="settings-group-title">用途</h4>
        <p className="settings-group-text">三种用途分别保存，更改其中一项不会影响其他两项。</p>
        <div className="role-list">
          {IDENTITY_ROLES.map((role) => (
            <RoleSelect key={role} role={role} overview={overview} onChanged={onChanged} />
          ))}
        </div>
      </div>
    </>
  )
}

/* ---------- Message line ---------- */

/** Always-present polite live region so a changed message is announced. */
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

/* ---------- Credential list ---------- */

function CredentialList({ overview, onChanged }: { overview: IdentityOverview; onChanged: () => Promise<void> }) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [message, setMessage] = useState<Message | null>(null)

  return (
    <div className="settings-group">
      <h4 className="settings-group-title" id={headingId} ref={headingRef} tabIndex={-1}>
        已导入的饼干
      </h4>
      {overview.credentials.length === 0 ? (
        <p className="settings-empty">还没有导入饼干。</p>
      ) : (
        <ul className="credential-list" aria-labelledby={headingId}>
          {overview.credentials.map((credential) => (
            <CredentialItem
              key={credential.id}
              credential={credential}
              overview={overview}
              onChanged={onChanged}
              onAnnounce={setMessage}
              listHeading={headingRef}
            />
          ))}
        </ul>
      )}
      <MessageLine message={message} />
    </div>
  )
}

type ItemMode = 'view' | 'rename' | 'confirm-remove'

function mutationErrorText(result: IdentityMutationResult & { ok: false }, action: string): string {
  switch (result.reason) {
    case 'not-found':
      return '这个饼干已不存在'
    case 'storage':
      return `本地存储不可写，未${action}`
    case 'name':
      return nameErrorText(result.nameError ?? 'invalid')
  }
}

function CredentialItem({
  credential,
  overview,
  onChanged,
  onAnnounce,
  listHeading
}: {
  credential: CredentialSummary
  overview: IdentityOverview
  onChanged: () => Promise<void>
  onAnnounce: (message: Message) => void
  listHeading: RefObject<HTMLHeadingElement | null>
}) {
  const [mode, setMode] = useState<ItemMode>('view')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const renameButton = useRef<HTMLButtonElement>(null)
  const removeButton = useRef<HTMLButtonElement>(null)
  const renameInput = useRef<HTMLInputElement>(null)
  const cancelRemove = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<RefObject<HTMLButtonElement | null> | null>(null)
  const nameId = useId()
  const errorId = useId()
  const confirmId = useId()

  const roles = rolesUsing(overview, credential.id)
  const writable = overview.writable

  // Focus follows the mode: into the editor / confirmation, back to the button that opened it.
  useEffect(() => {
    if (mode === 'rename') renameInput.current?.select()
    else if (mode === 'confirm-remove') cancelRemove.current?.focus()
    else if (returnFocus.current !== null) {
      returnFocus.current.current?.focus()
      returnFocus.current = null
    }
  }, [mode])

  const leave = (focusTarget: RefObject<HTMLButtonElement | null>) => {
    returnFocus.current = focusTarget
    setError(null)
    setMode('view')
  }

  const startRename = () => {
    setDraft(credential.name)
    setError(null)
    setMode('rename')
  }

  const saveRename = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    const nameError = checkName(draft)
    if (nameError !== null) {
      setError(nameErrorText(nameError))
      renameInput.current?.focus()
      return
    }
    const name = draft.trim()
    if (name === credential.name) {
      leave(renameButton)
      return
    }
    setPending(true)
    try {
      const result = await window.xidao.identities.rename({ credentialId: credential.id, name })
      if (result.ok) {
        onAnnounce({ tone: 'success', text: `已重命名为「${name}」` })
        await onChanged()
        leave(renameButton)
      } else {
        setError(mutationErrorText(result, '保存'))
        if (result.reason === 'not-found') await onChanged()
      }
    } catch {
      setError('重命名请求失败，未保存，请重试')
    } finally {
      setPending(false)
    }
  }

  const confirmRemove = async () => {
    if (pending) return
    setPending(true)
    try {
      const result = await window.xidao.identities.remove({ credentialId: credential.id })
      if (result.ok || result.reason === 'not-found') {
        const affected = roles.length > 0 ? `；${roleList(roles)}需要重新选择` : ''
        onAnnounce({
          tone: 'success',
          text: result.ok ? `已移除「${credential.name}」${affected}` : '这个饼干已不存在'
        })
        // The item disappears; keep keyboard focus inside the list area.
        listHeading.current?.focus()
        await onChanged()
      } else {
        setError(mutationErrorText(result, '移除'))
      }
    } catch {
      setError('移除请求失败，未移除，请重试')
    } finally {
      setPending(false)
    }
  }

  const onEditorKeyDown = (event: KeyboardEvent) => {
    // Esc cancels the inline step only; the dialog stays open.
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (!pending) leave(mode === 'rename' ? renameButton : removeButton)
  }

  return (
    <li className="credential-item">
      {mode === 'rename' ? (
        <form className="credential-rename" onSubmit={(event) => void saveRename(event)} onKeyDown={onEditorKeyDown}>
          <label className="field-label" htmlFor={nameId}>
            新名称
          </label>
          <div className="credential-rename-row">
            <input
              id={nameId}
              ref={renameInput}
              className="text-input"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setError(null)
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error !== null ? true : undefined}
              aria-describedby={errorId}
              disabled={pending}
            />
            <button type="submit" className="btn btn-small" disabled={pending}>
              {pending ? '正在保存…' : '保存'}
            </button>
            <button type="button" className="btn btn-small" onClick={() => leave(renameButton)} disabled={pending}>
              取消
            </button>
          </div>
          <p className="field-hint">1–40 个字符，首尾空格会被去掉。</p>
        </form>
      ) : (
        <div className="credential-main">
          <Icon name="key" className="credential-icon" />
          <div className="credential-text">
            <p className="credential-name">{credential.name}</p>
            <p className="credential-meta">
              {SOURCE_LABEL[credential.source]} · 导入于 {formatLocalTime(credential.importedAt)}
            </p>
            {roles.length > 0 && (
              <p className="credential-roles">
                <span className="visually-hidden">用于：</span>
                {roles.map((role) => (
                  <span key={role} className="tag">
                    {ROLE_INFO[role].label}
                  </span>
                ))}
              </p>
            )}
          </div>
          <div className="credential-actions">
            <button
              type="button"
              ref={renameButton}
              className="btn btn-small"
              onClick={startRename}
              disabled={!writable || mode !== 'view'}
              aria-label={`重命名「${credential.name}」`}
            >
              重命名
            </button>
            <button
              type="button"
              ref={removeButton}
              className="btn btn-small btn-danger"
              onClick={() => {
                setError(null)
                setMode('confirm-remove')
              }}
              disabled={!writable || mode !== 'view'}
              aria-label={`移除「${credential.name}」`}
            >
              移除
            </button>
          </div>
        </div>
      )}

      {mode === 'confirm-remove' && (
        <div className="credential-confirm" role="group" aria-labelledby={confirmId} onKeyDown={onEditorKeyDown}>
          <p className="credential-confirm-title" id={confirmId}>
            移除「{credential.name}」？
          </p>
          <p className="credential-confirm-text">
            {roles.length > 0
              ? `${roleList(roles)}正在使用它，移除后将显示为需要重新选择，不会自动改用其他饼干。`
              : '目前没有用途使用它。'}
            移除后无法恢复，需要重新粘贴才能再次使用。
          </p>
          <div className="credential-confirm-actions">
            <button type="button" className="btn btn-small btn-danger" onClick={() => void confirmRemove()} disabled={pending}>
              {pending ? '正在移除…' : '确认移除'}
            </button>
            <button type="button" ref={cancelRemove} className="btn btn-small" onClick={() => leave(removeButton)} disabled={pending}>
              取消
            </button>
          </div>
        </div>
      )}

      <div id={errorId} role="status" className="form-message-region">
        {error !== null && (
          <p className="form-message is-error">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </p>
        )}
      </div>
    </li>
  )
}

/* ---------- Import entries ---------- */

const IMPORT_COPY: Record<ImportEntry, { title: string; secretLabel: string; description: string; nameHint: string }> = {
  export: {
    title: '粘贴官网导出内容',
    secretLabel: '官网导出内容',
    description: '粘贴在官网导出的饼干内容（Base64 或 JSON）。',
    nameHint: '可不填，留空时使用导出内容中的名称。'
  },
  raw: {
    title: '粘贴原始 userhash',
    secretLabel: 'userhash',
    description: '粘贴饼干的 userhash 值，可带 userhash= 前缀。',
    nameHint: '必填，1–40 个字符。'
  }
}

function ImportForm({
  entry,
  disabled,
  onImported
}: {
  entry: ImportEntry
  disabled: boolean
  onImported: () => Promise<void>
}) {
  const copy = IMPORT_COPY[entry]
  // Uncontrolled on purpose: React would mirror a controlled value into the `value` attribute.
  const secretRef = useRef<HTMLInputElement>(null)
  const [shown, setShown] = useState(false)
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [invalid, setInvalid] = useState<FailureField>(null)
  const titleId = useId()
  const secretId = useId()
  const secretHintId = useId()
  const nameId = useId()
  const nameHintId = useId()
  const messageId = useId()
  const nameRequired = entry === 'raw'

  // The pasted value never outlives this form (dialog closed or section unmounted).
  useEffect(() => {
    const input = secretRef.current
    return () => {
      if (input !== null) input.value = ''
    }
  }, [])

  const fail = (text: string, field: FailureField) => {
    setMessage({ tone: 'error', text })
    setInvalid(field)
    if (field === 'secret') secretRef.current?.focus()
    else if (field === 'name') document.getElementById(nameId)?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || disabled) return
    const trimmedName = name.trim()
    if (nameRequired || trimmedName !== '') {
      const nameError = checkName(name)
      if (nameError !== null) {
        fail(nameErrorText(nameError), 'name')
        return
      }
    }
    const secret = secretRef.current?.value ?? ''
    setPending(true)
    setMessage(null)
    try {
      const result =
        entry === 'export'
          ? await window.xidao.identities.importExport(
              trimmedName === '' ? { payload: secret } : { payload: secret, name: trimmedName }
            )
          : await window.xidao.identities.importRaw({ userhash: secret, name: trimmedName })
      if (result.ok) {
        if (secretRef.current !== null) secretRef.current.value = ''
        setShown(false)
        setName('')
        setInvalid(null)
        setMessage({
          tone: 'success',
          text: `已导入「${result.credential.name}」：格式有效并已加密保存；远端可用性未验证。`
        })
        await onImported()
      } else {
        const { text, field } = importFailureText(result.failure, entry)
        fail(text, field)
      }
    } catch {
      fail('导入请求失败，未导入，请重试', null)
    } finally {
      setPending(false)
    }
  }

  const describedSecret = invalid === 'secret' ? `${secretHintId} ${messageId}` : secretHintId
  const describedName = invalid === 'name' ? `${nameHintId} ${messageId}` : nameHintId

  return (
    <form className="import-form" aria-labelledby={titleId} onSubmit={(event) => void submit(event)} noValidate>
      <fieldset className="import-fieldset" disabled={disabled}>
        <h4 className="import-title" id={titleId}>
          {copy.title}
        </h4>

        <label className="field-label" htmlFor={secretId}>
          {copy.secretLabel}
        </label>
        <div className="secret-row">
          <input
            id={secretId}
            ref={secretRef}
            className="text-input secret-input"
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="粘贴到这里"
            aria-describedby={describedSecret}
            aria-invalid={invalid === 'secret' ? true : undefined}
            onInput={() => {
              if (invalid === 'secret') setInvalid(null)
            }}
          />
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setShown((value) => !value)}
            aria-controls={secretId}
            aria-label={`${shown ? '隐藏' : '显示'}${copy.secretLabel}`}
          >
            {shown ? '隐藏' : '显示'}
          </button>
        </div>
        <p className="field-hint" id={secretHintId}>
          {copy.description}默认遮蔽显示。
        </p>

        <label className="field-label" htmlFor={nameId}>
          名称{nameRequired ? '' : '（可选）'}
        </label>
        <input
          id={nameId}
          className="text-input"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            if (invalid === 'name') setInvalid(null)
          }}
          autoComplete="off"
          spellCheck={false}
          required={nameRequired}
          aria-required={nameRequired ? true : undefined}
          aria-describedby={describedName}
          aria-invalid={invalid === 'name' ? true : undefined}
        />
        <p className="field-hint" id={nameHintId}>
          {copy.nameHint}
        </p>

        <div className="import-actions">
          <button type="submit" className="btn btn-primary" disabled={pending} aria-describedby={messageId}>
            {pending ? '正在导入…' : '导入'}
          </button>
        </div>
      </fieldset>
      <MessageLine id={messageId} message={message} />
    </form>
  )
}

/* ---------- Role selectors ---------- */

const MISSING_VALUE = '__missing__'

function RoleSelect({
  role,
  overview,
  onChanged
}: {
  role: IdentityRole
  overview: IdentityOverview
  onChanged: () => Promise<void>
}) {
  const info = ROLE_INFO[role]
  const selection = overview.roles[role]
  const [pendingValue, setPendingValue] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selectId = useId()
  const explanationId = useId()
  const warningId = useId()
  const errorId = useId()

  const { credentials } = overview
  const selectedExists = selection.state === 'selected' && credentials.some((item) => item.id === selection.credentialId)
  const missing = selection.state === 'missing' || (selection.state === 'selected' && !selectedExists)
  const currentValue = selection.state === 'none' ? '' : missing ? MISSING_VALUE : selection.credentialId
  const shownValue = pendingValue ?? currentValue

  // Duplicate names get their source and import time so options stay distinguishable.
  const nameCounts = new Map<string, number>()
  for (const item of credentials) nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1)

  const choose = async (value: string) => {
    if (value === MISSING_VALUE || value === currentValue || pendingValue !== null) return
    setPendingValue(value)
    setError(null)
    try {
      const result = await window.xidao.identities.select({ role, credentialId: value === '' ? null : value })
      if (result.ok) await onChanged()
      else {
        setError(result.reason === 'not-found' ? '所选饼干已不存在，未更改' : '本地存储不可写，未更改')
        if (result.reason === 'not-found') await onChanged()
      }
    } catch {
      setError('请求失败，未更改，请重试')
    } finally {
      setPendingValue(null)
    }
  }

  const describedBy = [explanationId, missing ? warningId : null, error !== null ? errorId : null].filter(Boolean).join(' ')

  return (
    <div className="role-field">
      <label className="field-label" htmlFor={selectId}>
        {info.label}
      </label>
      <p className="field-hint" id={explanationId}>
        {info.explanation}
      </p>
      <select
        id={selectId}
        className={missing && pendingValue === null ? 'select-input is-warning' : 'select-input'}
        value={shownValue}
        onChange={(event) => void choose(event.target.value)}
        // Not disabled while saving: that would drop keyboard focus; `choose` ignores changes meanwhile.
        disabled={!overview.writable}
        aria-busy={pendingValue !== null ? true : undefined}
        aria-describedby={describedBy}
        aria-invalid={missing ? true : undefined}
      >
        <option value="">{info.noneLabel}</option>
        {missing && (
          <option value={MISSING_VALUE} disabled>
            {MISSING_SELECTION_TEXT}
          </option>
        )}
        {credentials.map((item) => (
          <option key={item.id} value={item.id}>
            {(nameCounts.get(item.name) ?? 0) > 1
              ? `${item.name}（${SOURCE_LABEL[item.source]}，${formatLocalTime(item.importedAt)}）`
              : item.name}
          </option>
        ))}
      </select>
      {missing && (
        <p className="field-warning" id={warningId}>
          <Icon name="alert" size={14} />
          <span>之前选择的饼干已移除，需要重新选择；不会自动改用其他饼干。</span>
        </p>
      )}
      <div id={errorId} role="status" className="form-message-region">
        {error !== null && (
          <p className="form-message is-error">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </p>
        )}
      </div>
    </div>
  )
}
