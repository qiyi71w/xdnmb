import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type ComponentProps, type DragEvent, type FormEvent, type KeyboardEvent, type RefObject
} from 'react'
import type { AccountCookie, AccountFailure, AccountOverview } from '../../../../shared/account'
import {
  IDENTITY_ROLES,
  type CredentialId,
  type CredentialSummary,
  type IdentityMutationResult,
  type IdentityOverview,
  type IdentityRole
} from '../../../../shared/identity'
import { Icon } from '../../components/Icon'
import { FailureNotice } from '../../components/Notices'
import { formatLocalTime } from '../../lib/format'
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
import {
  MISSING_SELECTION_TEXT,
  ROLE_INFO,
  SOURCE_LABEL,
  accountBlockerText,
  accountFailureText,
  accountImportFailureText,
  accountImportSummary,
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

/** Where an account's cookies are claimed and exported; opened in the system browser. */
const OFFICIAL_COOKIE_PAGE = 'https://www.nmbxd1.com/Member/User/Index/'

/**
 * 饼干 settings: the ordered credential list (the first one is used for browsing), one import area,
 * import from the logged-in official account and the two independent role selectors. Pasted
 * secrets live only in the DOM value of their (uncontrolled) inputs while this section is mounted.
 */
export function CookieSection({ identities }: { identities: IdentitiesState }) {
  const { overview, failed, refresh } = identities
  const headingId = useId()

  return (
    <section className="settings-section" aria-labelledby={headingId} aria-busy={(overview === null && !failed) || undefined}>
      <h3 className="settings-section-title" id={headingId}>
        饼干
      </h3>

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
      {PROTOTYPE_ENABLED && <OfficialPageLink />}
      {!protectionOk && (
        <div className="notice notice-cached" role="note">
          <Icon name="alert" className="notice-icon" />
          <div className="notice-text">
            <p className="notice-title">系统凭据保护不可用</p>
            <p>不能导入饼干，需要饼干的读取会被阻止。</p>
          </div>
        </div>
      )}
      {!overview.writable && (
        <div className="notice notice-cached" role="note">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">本地存储不可写</p>
        </div>
      )}

      <CredentialList overview={overview} onChanged={onChanged} />

      {PROTOTYPE_ENABLED ? (
        <ImportArea disabled={importBlocked} onImported={onChanged} />
      ) : (
        <div className="cookie-imports">
          <ImportForm entry="export" disabled={importBlocked} onImported={onChanged} />
          <ImportForm entry="raw" disabled={importBlocked} onImported={onChanged} />
        </div>
      )}

      <AccountImport onImported={onChanged} />

      {!PROTOTYPE_ENABLED && (
        <p className="settings-note">
          <Icon name="info" size={14} />
          领取、应用和删除饼干请在官网完成。
        </p>
      )}

      <div className="settings-group">
        <h4 className="settings-group-title">用途</h4>
        <div className="role-list">
          {IDENTITY_ROLES.map((role) => (
            <RoleSelect key={role} role={role} overview={overview} onChanged={onChanged} />
          ))}
        </div>
      </div>
    </>
  )
}

/** The official cookie page, in the system browser: claiming, applying and deleting cookies happen there. */
function OfficialPageLink() {
  const [failed, setFailed] = useState(false)
  const open = () => {
    setFailed(false)
    window.xidao.links.openExternal({ url: OFFICIAL_COOKIE_PAGE }).then(
      (result) => setFailed(!result.opened),
      () => setFailed(true)
    )
  }
  return (
    <div className="cookie-official">
      <button type="button" className="btn" onClick={open}>
        <Icon name="external" size={14} />
        打开官网饼干页
      </button>
      <MessageLine message={failed ? { tone: 'error', text: '无法打开浏览器' } : null} />
    </div>
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

type MoveDirection = 'up' | 'down'

/** Ordered list: drag a row's handle, or use 上移／下移 from the keyboard. The first one browses. */
function CredentialList({ overview, onChanged }: { overview: IdentityOverview; onChanged: () => Promise<void> }) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [message, setMessage] = useState<Message | null>(null)
  /** The order being saved: shown at once, replaced by the stored order when the save ends. */
  const [pendingOrder, setPendingOrder] = useState<CredentialId[] | null>(null)
  const [dragId, setDragId] = useState<CredentialId | null>(null)
  const [dropAt, setDropAt] = useState<{ id: CredentialId; after: boolean } | null>(null)
  /** A move button moved its row: focus stays on it (or its twin when it became unavailable). */
  const focusAfterMove = useRef<{ id: CredentialId; direction: MoveDirection } | null>(null)

  const credentials =
    pendingOrder === null
      ? overview.credentials
      : pendingOrder.flatMap((id) => overview.credentials.filter((item) => item.id === id))
  const movable = overview.writable && pendingOrder === null && credentials.length > 1

  // While saving the moved row keeps the pressed button; once saved, its twin takes over when the
  // pressed one no longer applies (moved to the top or bottom).
  useLayoutEffect(() => {
    const wanted = focusAfterMove.current
    const list = listRef.current
    if (wanted === null || list === null) return
    const button = (direction: MoveDirection) =>
      list.querySelector<HTMLButtonElement>(`[data-credential="${wanted.id}"] [data-move="${direction}"]`)
    const same = button(wanted.direction)
    if (pendingOrder !== null) {
      if (same !== null && document.activeElement !== same) same.focus()
      return
    }
    focusAfterMove.current = null
    const target = same !== null && same.getAttribute('aria-disabled') !== 'true' ? same : button(wanted.direction === 'up' ? 'down' : 'up')
    target?.focus()
  })

  const save = async (ids: CredentialId[], moved: CredentialSummary) => {
    if (pendingOrder !== null) return
    setPendingOrder(ids)
    setMessage(null)
    try {
      const result = await window.xidao.identities.reorder({ credentialIds: ids })
      if (result.ok) {
        const position = ids.indexOf(moved.id) + 1
        setMessage({ tone: 'success', text: position === 1 ? `「${moved.name}」移到第一位，浏览时使用` : `「${moved.name}」移到第 ${position} 位` })
      } else setMessage({ tone: 'error', text: mutationErrorText(result, '调整顺序') })
      await onChanged()
    } catch {
      setMessage({ tone: 'error', text: '顺序未保存，请重试' })
    } finally {
      setPendingOrder(null)
    }
  }

  const move = (credential: CredentialSummary, direction: MoveDirection) => {
    const ids = credentials.map((item) => item.id)
    const from = ids.indexOf(credential.id)
    const to = direction === 'up' ? from - 1 : from + 1
    if (!movable || from < 0 || to < 0 || to >= ids.length) return
    ids.splice(from, 1)
    ids.splice(to, 0, credential.id)
    focusAfterMove.current = { id: credential.id, direction }
    void save(ids, credential)
  }

  const drop = () => {
    const dragged = credentials.find((item) => item.id === dragId)
    const at = dropAt
    setDragId(null)
    setDropAt(null)
    if (dragged === undefined || at === null || at.id === dragged.id) return
    const ids = credentials.map((item) => item.id).filter((id) => id !== dragged.id)
    const index = ids.indexOf(at.id)
    if (index < 0) return
    ids.splice(at.after ? index + 1 : index, 0, dragged.id)
    if (ids.every((id, position) => id === credentials[position]?.id)) return
    void save(ids, dragged)
  }

  const dragProps = (credential: CredentialSummary) => ({
    onDragOver: (event: DragEvent<HTMLLIElement>) => {
      if (dragId === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const box = event.currentTarget.getBoundingClientRect()
      const after = event.clientY > box.top + box.height / 2
      if (dropAt?.id !== credential.id || dropAt.after !== after) setDropAt({ id: credential.id, after })
    },
    onDrop: (event: DragEvent<HTMLLIElement>) => {
      if (dragId === null) return
      event.preventDefault()
      drop()
    }
  })

  return (
    <div className="settings-group">
      <h4 className="settings-group-title" id={headingId} ref={headingRef} tabIndex={-1}>
        已导入的饼干
      </h4>
      {credentials.length === 0 ? (
        <p className="settings-empty">还没有导入饼干，浏览时不带饼干。</p>
      ) : (
        <ul className="credential-list" aria-labelledby={headingId} ref={listRef} aria-busy={pendingOrder !== null ? true : undefined}>
          {credentials.map((credential, index) => (
            <CredentialItem
              key={credential.id}
              credential={credential}
              index={index}
              count={credentials.length}
              overview={overview}
              movable={movable}
              dragging={dragId === credential.id}
              dropMark={dropAt !== null && dropAt.id === credential.id && dragId !== credential.id ? (dropAt.after ? 'after' : 'before') : null}
              dragProps={dragProps(credential)}
              onDragStart={() => setDragId(credential.id)}
              onDragEnd={() => {
                setDragId(null)
                setDropAt(null)
              }}
              onMove={(direction) => move(credential, direction)}
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
  index,
  count,
  overview,
  movable,
  dragging,
  dropMark,
  dragProps,
  onDragStart,
  onDragEnd,
  onMove,
  onChanged,
  onAnnounce,
  listHeading
}: {
  credential: CredentialSummary
  index: number
  count: number
  overview: IdentityOverview
  /** Order changes are possible now (writable, several items, no save running). */
  movable: boolean
  dragging: boolean
  dropMark: 'before' | 'after' | null
  dragProps: Pick<ComponentProps<'li'>, 'onDragOver' | 'onDrop'>
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (direction: MoveDirection) => void
  onChanged: () => Promise<void>
  onAnnounce: (message: Message) => void
  listHeading: RefObject<HTMLHeadingElement | null>
}) {
  const [mode, setMode] = useState<ItemMode>('view')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const itemRef = useRef<HTMLLIElement>(null)
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
  const browsing = index === 0

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
        const affected = [
          roles.length > 0 ? `${roleList(roles)}需要重新选择` : null,
          browsing && count > 1 ? '浏览改用下一个饼干' : null
        ].filter(Boolean)
        onAnnounce({
          tone: 'success',
          text: result.ok ? `已移除「${credential.name}」${affected.length > 0 ? `；${affected.join('，')}` : ''}` : '这个饼干已不存在'
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

  const itemClass = ['credential-item', dragging ? 'is-dragging' : null, dropMark === null ? null : `is-drop-${dropMark}`]
    .filter(Boolean)
    .join(' ')

  return (
    <li ref={itemRef} className={itemClass} data-credential={credential.id} {...dragProps}>
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
          {movable && mode === 'view' ? (
            // Mouse only; the keyboard uses 上移／下移.
            <span
              className="credential-handle"
              draggable
              aria-hidden="true"
              title="拖动调整顺序"
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', '')
                if (itemRef.current !== null) event.dataTransfer.setDragImage(itemRef.current, 16, 16)
                onDragStart()
              }}
              onDragEnd={onDragEnd}
            >
              <Icon name="more" size={16} />
            </span>
          ) : (
            <Icon name="key" className="credential-icon" />
          )}
          <div className="credential-text">
            <p className="credential-name">{credential.name}</p>
            <p className="credential-meta">
              {SOURCE_LABEL[credential.source]} · 导入于 {formatLocalTime(credential.importedAt)}
            </p>
            {(browsing || roles.length > 0) && (
              <p className="credential-roles">
                <span className="visually-hidden">用于：</span>
                {browsing && <span className="tag">浏览</span>}
                {roles.map((role) => (
                  <span key={role} className="tag">
                    {ROLE_INFO[role].label}
                  </span>
                ))}
              </p>
            )}
          </div>
          <div className="credential-actions">
            {count > 1 && (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  data-move="up"
                  aria-label={`上移「${credential.name}」`}
                  title="上移"
                  aria-disabled={!movable || index === 0 ? true : undefined}
                  onClick={() => movable && index > 0 && onMove('up')}
                >
                  <Icon name="arrowUp" />
                </button>
                <button
                  type="button"
                  className="icon-btn credential-flip"
                  data-move="down"
                  aria-label={`下移「${credential.name}」`}
                  title="下移"
                  aria-disabled={!movable || index === count - 1 ? true : undefined}
                  onClick={() => movable && index < count - 1 && onMove('down')}
                >
                  <Icon name="arrowUp" />
                </button>
              </>
            )}
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
            {roles.length > 0 && `${roleList(roles)}将需要重新选择。`}
            {browsing && count > 1 && '浏览将改用下一个饼干。'}
            移除后需要重新导入。
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

const IMPORT_COPY: Record<ImportEntry, { tab: string; title: string; secretLabel: string; description: string; nameHint: string }> = {
  export: {
    tab: '官网导出',
    title: '粘贴官网导出内容',
    secretLabel: '官网导出内容',
    description: 'Base64 或 JSON。',
    nameHint: '留空时用导出内容里的名称。'
  },
  raw: {
    tab: 'userhash',
    title: '粘贴原始 userhash',
    secretLabel: 'userhash',
    description: '可带 userhash= 前缀。',
    nameHint: '1–40 个字符。'
  }
}

const IMPORT_ENTRIES: readonly ImportEntry[] = ['export', 'raw']

/** One import area: a switch picks the format; switching clears whatever was pasted. */
function ImportArea({ disabled, onImported }: { disabled: boolean; onImported: () => Promise<void> }) {
  const [entry, setEntry] = useState<ImportEntry>('export')
  const titleId = useId()
  return (
    <div className="settings-group">
      <div className="cookie-import-head">
        <h4 className="settings-group-title" id={titleId}>
          导入饼干
        </h4>
        <div className="segmented" role="group" aria-labelledby={titleId}>
          {IMPORT_ENTRIES.map((item) => (
            <button key={item} type="button" className="segmented-item" aria-pressed={entry === item} onClick={() => setEntry(item)}>
              {IMPORT_COPY[item].tab}
            </button>
          ))}
        </div>
      </div>
      <ImportForm key={entry} entry={entry} titled={false} disabled={disabled} onImported={onImported} />
    </div>
  )
}

function ImportForm({
  entry,
  titled = true,
  disabled,
  onImported
}: {
  entry: ImportEntry
  /** False inside the import area, whose heading and switch already name the form. */
  titled?: boolean
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
        setMessage({ tone: 'success', text: `已导入「${result.credential.name}」` })
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
    <form
      className="import-form"
      aria-labelledby={titled ? titleId : undefined}
      aria-label={titled ? undefined : copy.title}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <fieldset className="import-fieldset" disabled={disabled}>
        {titled && (
          <h4 className="import-title" id={titleId}>
            {copy.title}
          </h4>
        )}

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
          {copy.description}
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

/* ---------- Official account ---------- */

type AccountBusy = 'login' | 'list' | 'import' | 'forget'

/**
 * Import from the official account: login (or the stored session) lists the account's cookies by
 * their public fields; the chosen ones are stored like a pasted export. No secret reaches this view.
 */
function AccountImport({ onImported }: { onImported: () => Promise<void> }) {
  const titleId = useId()
  const listTitleId = useId()
  const messageId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const listTitleRef = useRef<HTMLHeadingElement>(null)
  const openRef = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  const latestOverview = useRef(0)
  /** Where focus goes once the running action ends: the new list, or login when the session ended. */
  const pendingFocus = useRef<'list' | 'open' | null>(null)
  const [overview, setOverview] = useState<AccountOverview | null>(null)
  const [overviewFailed, setOverviewFailed] = useState(false)
  const [busy, setBusy] = useState<AccountBusy | null>(null)
  const [cookies, setCookies] = useState<AccountCookie[] | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  /** What the last import did to each row. */
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Message>>(() => new Map())
  const [message, setMessage] = useState<Message | null>(null)

  // Only the newest read may apply, so a slow earlier one never overwrites a newer state.
  const readOverview = useCallback(async () => {
    const request = ++latestOverview.current
    try {
      const next = await window.xidao.account.getOverview()
      if (!alive.current || request !== latestOverview.current) return
      setOverview(next)
      setOverviewFailed(false)
    } catch {
      if (!alive.current || request !== latestOverview.current) return
      setOverviewFailed(true)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void readOverview()
    return () => {
      alive.current = false
    }
  }, [readOverview])

  useEffect(() => {
    if (busy !== null || pendingFocus.current === null) return
    const target = pendingFocus.current === 'list' ? listTitleRef.current : (openRef.current ?? titleRef.current)
    pendingFocus.current = null
    target?.focus()
  })

  const idle = busy === null
  const loggedIn = overview?.loggedIn === true

  const endSession = () => {
    setCookies(null)
    setSelected(new Set())
    setOutcomes(new Map())
    setOverview((current) => current && { ...current, loggedIn: false, expiresAt: null })
    pendingFocus.current = 'open'
  }

  /** An expired session drops the list so the button offers login again. */
  const showFailure = (reason: AccountFailure) => {
    if (reason === 'expired') endSession()
    setMessage({ tone: reason === 'cancelled' ? 'success' : 'error', text: accountFailureText(reason) })
  }

  const open = async () => {
    if (!idle || overview === null || !overview.available) return
    const action = overview.loggedIn ? 'list' : 'login'
    setBusy(action)
    setMessage(null)
    try {
      const result = action === 'list' ? await window.xidao.account.list() : await window.xidao.account.login()
      if (!alive.current) return
      if (result.ok) {
        setCookies(result.value)
        setSelected(new Set())
        setOutcomes(new Map())
        pendingFocus.current = 'list'
      } else showFailure(result.reason)
    } catch {
      if (alive.current) setMessage({ tone: 'error', text: action === 'list' ? '读取失败，请重试' : '登录失败，请重试' })
    } finally {
      if (alive.current) setBusy(null)
    }
    void readOverview()
  }

  const importChosen = async () => {
    if (!idle || cookies === null) return
    const ids = cookies.filter((cookie) => selected.has(cookie.id)).map((cookie) => cookie.id)
    if (ids.length === 0) {
      setMessage({ tone: 'error', text: '请先勾选要导入的饼干' })
      return
    }
    setBusy('import')
    setMessage(null)
    try {
      const result = await window.xidao.account.importSelected({ ids })
      if (!result.ok) {
        if (!alive.current) return
        showFailure(result.reason)
        void readOverview()
        return
      }
      void onImported()
      if (!alive.current) return
      const next = new Map(outcomes)
      const settled = new Set<string>()
      let imported = 0
      let duplicates = 0
      let failures = 0
      for (const { id, result: item } of result.value) {
        if (item.ok) {
          imported += 1
          settled.add(id)
          next.set(id, { tone: 'success', text: `已导入为「${item.credential.name}」` })
        } else if (item.failure.reason === 'duplicate') {
          duplicates += 1
          settled.add(id)
          next.set(id, { tone: 'success', text: `已有相同饼干「${item.failure.existing.name}」` })
        } else {
          failures += 1
          next.set(id, { tone: 'error', text: accountImportFailureText(item.failure) })
        }
      }
      setOutcomes(next)
      setSelected((current) => new Set([...current].filter((id) => !settled.has(id))))
      setMessage({ tone: failures > 0 ? 'error' : 'success', text: accountImportSummary(imported, duplicates, failures) })
    } catch {
      // The request may have stored some of them before failing: re-read what is there.
      void onImported()
      if (alive.current) setMessage({ tone: 'error', text: '导入结果未知，请查看已导入的饼干' })
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  const forget = async () => {
    if (!idle) return
    setBusy('forget')
    setMessage(null)
    try {
      const result = await window.xidao.account.forget()
      if (!alive.current) return
      if (result.ok) {
        endSession()
        setMessage({ tone: 'success', text: '已退出登录' })
      } else showFailure(result.reason)
    } catch {
      if (alive.current) setMessage({ tone: 'error', text: '退出登录失败，请重试' })
    } finally {
      if (alive.current) setBusy(null)
    }
    void readOverview()
  }

  const allSelected = cookies !== null && cookies.length > 0 && cookies.every((cookie) => selected.has(cookie.id))
  const toggleAll = () => {
    if (!idle || cookies === null) return
    setSelected(allSelected ? new Set() : new Set(cookies.map((cookie) => cookie.id)))
  }
  const setChecked = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const openLabel =
    busy === 'login' ? '正在等待登录…' : busy === 'list' ? '正在读取…' : !loggedIn ? '登录官网导入' : cookies === null ? '读取账号饼干' : '重新读取'

  return (
    <div className="settings-group" aria-busy={!idle || (overview === null && !overviewFailed) || undefined}>
      <h4 className="settings-group-title" id={titleId} ref={titleRef} tabIndex={-1}>
        官网账号
      </h4>

      {overview === null ? (
        overviewFailed ? (
          <div className="account-row">
            <p className="form-message is-error">
              <Icon name="alert" size={14} />
              <span>登录状态读取失败</span>
            </p>
            <button type="button" className="btn btn-small" onClick={() => void readOverview()}>
              重试
            </button>
          </div>
        ) : (
          <p className="settings-group-text">正在读取登录状态…</p>
        )
      ) : (
        <>
          {loggedIn && (
            <p className="settings-group-text">
              {overview.expiresAt === null ? '已登录' : `已登录，有效至 ${formatLocalTime(overview.expiresAt)}`}
            </p>
          )}
          {!overview.available && (
            <p className="settings-note is-warning">
              <Icon name="alert" size={14} />
              {accountBlockerText(overview.blocker)}
            </p>
          )}
          {(overview.available || loggedIn) && (
            <div className="account-row">
              {overview.available && (
                <button
                  ref={openRef}
                  type="button"
                  className={cookies === null ? 'btn btn-primary' : 'btn'}
                  aria-disabled={!idle || undefined}
                  aria-describedby={messageId}
                  onClick={() => void open()}
                >
                  {openLabel}
                </button>
              )}
              {loggedIn && (
                <button type="button" className="btn btn-quiet" aria-disabled={!idle || undefined} onClick={() => void forget()}>
                  {busy === 'forget' ? '正在退出…' : '退出登录'}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {cookies !== null && (
        <div className="account-cookies">
          <div className="account-cookies-head">
            <h5 className="account-cookies-title" id={listTitleId} ref={listTitleRef} tabIndex={-1}>
              账号里的饼干
            </h5>
            {cookies.length > 1 && (
              <button type="button" className="btn btn-quiet btn-small" aria-disabled={!idle || undefined} onClick={toggleAll}>
                {allSelected ? '全不选' : '全选'}
              </button>
            )}
          </div>
          {cookies.length === 0 ? (
            <p className="settings-empty">账号里没有饼干</p>
          ) : (
            <>
              <ul className="account-cookie-list" aria-labelledby={listTitleId}>
                {cookies.map((cookie) => {
                  const outcome = outcomes.get(cookie.id)
                  return (
                    <li key={cookie.id}>
                      <label className="account-cookie">
                        <input
                          type="checkbox"
                          checked={selected.has(cookie.id)}
                          disabled={!idle}
                          onChange={(event) => setChecked(cookie.id, event.target.checked)}
                        />
                        <span className="account-cookie-text">
                          <span className="account-cookie-id">{cookie.publicId}</span>
                          <span className="account-cookie-meta">
                            <span>ID {cookie.id}</span>
                            {cookie.validUntil !== null && <span>有效时间 {cookie.validUntil}</span>}
                            {cookie.claimedAt !== null && <span>领取时间 {cookie.claimedAt}</span>}
                          </span>
                          {outcome !== undefined && (
                            <span className={outcome.tone === 'error' ? 'account-cookie-outcome is-error' : 'account-cookie-outcome'}>
                              {outcome.text}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
              <div className="account-import-actions">
                <span className="account-selected-count">已选 {selected.size} 块</span>
                <button
                  type="button"
                  className="btn btn-primary"
                  aria-disabled={!idle || undefined}
                  aria-describedby={messageId}
                  onClick={() => void importChosen()}
                >
                  {busy === 'import' ? '正在导入…' : '导入所选'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <MessageLine id={messageId} message={message} />
    </div>
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

  const describedBy = [missing ? warningId : null, error !== null ? errorId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className="role-field">
      <label className="field-label" htmlFor={selectId}>
        {info.label}
      </label>
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
          <span>之前选择的饼干已移除，请重新选择。</span>
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
