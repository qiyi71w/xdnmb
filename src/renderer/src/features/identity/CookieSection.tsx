import {
  useCallback, useEffect, useId, useRef, useState,
  type FormEvent, type KeyboardEvent, type RefObject
} from 'react'
import type { AccountCookie, AccountFailure, AccountOverview } from '../../../../shared/account'
import {
  COOKIE_ID_MAX_LENGTH,
  IDENTITY_ROLES,
  type CredentialId,
  type CredentialSummary,
  type IdentityMutationResult,
  type IdentityOverview,
  type IdentityRole
} from '../../../../shared/identity'
import { CookieId } from '../../components/CookieId'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { FailureNotice } from '../../components/Notices'
import { SortHandle, SortStatus, useSortableList, type SortableList } from '../../components/SortHandle'
import { formatForumTime, formatRecordTime } from '../../lib/time'
import { moveItem } from '../../lib/reorder'
import { singleFlight } from '../../lib/singleFlight'
import {
  MISSING_SELECTION_TEXT,
  ROLE_INFO,
  SOURCE_LABEL,
  accountBlockerText,
  accountFailureText,
  accountImportFailureText,
  accountImportSummary,
  checkCookieId,
  checkName,
  cookieIdErrorText,
  cookieIdLabel,
  duplicateText,
  importFailureText,
  importedText,
  nameErrorText,
  roleList,
  rolesUsing,
  type AccountImportCounts,
  type FailureField,
  type ImportEntry
} from './identityText'
import type { IdentitiesState } from './useIdentities'
import { reloadCookieColors } from '../cookieColors/cookieColorsStore'
import './identity.css'

type Tone = 'success' | 'error'
interface Message {
  tone: Tone
  text: string
}

/** Where an account's cookies are claimed, applied and exported; opened in the system browser (spec I3). */
const OFFICIAL_COOKIE_PAGE = 'https://www.nmbxd1.com/Member/User/Index/index.html'

/**
 * 饼干 settings: the ordered credential list (the first one is used for browsing), one import area,
 * import from the logged-in official account and the two independent role selectors. Pasted
 * secrets live only in the DOM value of their (uncontrolled) inputs while this section is shown.
 */
export function CookieSection({ identities, active }: { identities: IdentitiesState; active: boolean }) {
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
              <p className="notice-text">
                饼干信息刷新失败，下面可能不是最新状态
                <KaomojiDecor state="failure" />
              </p>
              <button type="button" className="btn btn-small btn-page" onClick={() => void refresh()}>
                重试
              </button>
            </div>
          )}
          <CookieSettings overview={overview} onChanged={refresh} active={active} />
        </>
      )}
    </section>
  )
}

function CookieSettings({ overview, onChanged, active }: { overview: IdentityOverview; onChanged: () => Promise<void>; active: boolean }) {
  const protectionOk = overview.protection === 'available'
  const importBlocked = !protectionOk || !overview.writable
  // An import may give the new 饼干 ID the default 饼干颜色 (main process): show it at once.
  const onImported = useCallback(async () => {
    void reloadCookieColors()
    await onChanged()
  }, [onChanged])

  return (
    <>
      <OfficialPageLink />
      {!protectionOk && (
        <div className="notice notice-cached is-compact" role="note">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">系统凭据保护不可用，不能导入饼干</p>
        </div>
      )}
      {!overview.writable && (
        <div className="notice notice-cached is-compact" role="note">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">本地存储不可写</p>
        </div>
      )}

      <CredentialList overview={overview} onChanged={onChanged} />

      <ImportArea disabled={importBlocked} onImported={onImported} active={active} />

      <AccountImport onImported={onImported} />

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

/** The official cookie page, in the system browser. */
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
      <button type="button" className="btn btn-page" onClick={open}>
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

/** Ordered list, sorted by each row's handle (drag, or Alt+↑／Alt+↓). The first one browses. */
function CredentialList({ overview, onChanged }: { overview: IdentityOverview; onChanged: () => Promise<void> }) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [message, setMessage] = useState<Message | null>(null)
  /** The order being saved: shown at once, replaced by the stored order when the save ends. */
  const [pendingOrder, setPendingOrder] = useState<CredentialId[] | null>(null)

  const credentials =
    pendingOrder === null
      ? overview.credentials
      : pendingOrder.flatMap((id) => overview.credentials.filter((item) => item.id === id))
  /** Handles are shown (writable, several items); moves wait while a save runs. */
  const sortable = overview.writable && credentials.length > 1

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

  const ids = credentials.map((item) => item.id)
  const sort = useSortableList(ids, (from, to) => {
    const order = moveItem(ids, from, to)
    const moved = credentials[from]
    if (sortable && order !== null && moved !== undefined) void save(order, moved)
  })

  return (
    <div className="settings-group">
      <h4 className="settings-group-title" id={headingId} ref={headingRef} tabIndex={-1}>
        已导入的饼干
      </h4>
      {credentials.length === 0 ? (
        <p className="settings-empty">
          还没有导入饼干
          <KaomojiDecor state="cookiesEmpty" />
        </p>
      ) : (
        <ul
          className={`credential-list ${sort.listClassName}`}
          style={sort.listStyle}
          aria-labelledby={headingId}
          ref={sort.listRef}
          aria-busy={pendingOrder !== null ? true : undefined}
        >
          {credentials.map((credential, index) => (
            <CredentialItem
              key={credential.id}
              credential={credential}
              index={index}
              count={credentials.length}
              overview={overview}
              sort={sortable ? sort : null}
              sortPending={pendingOrder !== null}
              onChanged={onChanged}
              onAnnounce={setMessage}
              listHeading={headingRef}
            />
          ))}
        </ul>
      )}
      <SortStatus sort={sort} />
      <MessageLine message={message} />
    </div>
  )
}

type ItemMode = 'view' | 'rename' | 'cookie-id' | 'confirm-remove'

function mutationErrorText(result: IdentityMutationResult & { ok: false }, action: string): string {
  switch (result.reason) {
    case 'not-found':
      return '这个饼干已不存在'
    case 'storage':
      return `本地存储不可写，未${action}`
    case 'name':
      return nameErrorText(result.nameError ?? 'invalid')
    case 'cookie-id':
      return cookieIdErrorText(result.cookieIdError ?? 'invalid')
  }
}

function CredentialItem({
  credential,
  index,
  count,
  overview,
  sort,
  sortPending,
  onChanged,
  onAnnounce,
  listHeading
}: {
  credential: CredentialSummary
  index: number
  count: number
  overview: IdentityOverview
  /** The list this item sorts in; `null` when the order cannot change (read-only, a single item). */
  sort: SortableList | null
  /** An order save is running: the handle stays focusable but does not move. */
  sortPending: boolean
  onChanged: () => Promise<void>
  onAnnounce: (message: Message) => void
  listHeading: RefObject<HTMLHeadingElement | null>
}) {
  const [mode, setMode] = useState<ItemMode>('view')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const renameButton = useRef<HTMLButtonElement>(null)
  const cookieIdButton = useRef<HTMLButtonElement>(null)
  const removeButton = useRef<HTMLButtonElement>(null)
  const editInput = useRef<HTMLInputElement>(null)
  const cancelRemove = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<RefObject<HTMLButtonElement | null> | null>(null)
  const nameId = useId()
  const errorId = useId()
  const confirmId = useId()

  const roles = rolesUsing(overview, credential.id)
  const writable = overview.writable
  const browsing = index === 0
  /** 重命名, 填写／修改 ID and 移除: only while the item is shown as is and storage is writable. */
  const actionsAvailable = writable && mode === 'view'
  /** Taken synchronously: a second Enter or press before `pending` renders does not save or remove twice. */
  const [flight] = useState(singleFlight)

  // Focus follows the mode: into the editor / confirmation, back to the button that opened it.
  useEffect(() => {
    if (mode === 'rename' || mode === 'cookie-id') editInput.current?.select()
    else if (mode === 'confirm-remove') cancelRemove.current?.focus()
    else if (returnFocus.current !== null) {
      returnFocus.current.current?.focus()
      returnFocus.current = null
    }
  }, [mode])

  const refocusInput = useRef(false)
  useEffect(() => {
    if (pending || !refocusInput.current) return
    refocusInput.current = false
    editInput.current?.focus()
  }, [pending])

  const leave = (focusTarget: RefObject<HTMLButtonElement | null>) => {
    returnFocus.current = focusTarget
    setError(null)
    setMode('view')
  }

  const openerOf = (current: ItemMode) =>
    current === 'rename' ? renameButton : current === 'cookie-id' ? cookieIdButton : removeButton

  const startEdit = (next: 'rename' | 'cookie-id') => {
    setDraft(next === 'rename' ? credential.name : (credential.cookieId ?? ''))
    setError(null)
    setMode(next)
  }

  const invalidDraft = (text: string) => {
    setError(text)
    editInput.current?.focus()
  }

  const saveRename = async () => {
    const nameError = checkName(draft)
    if (nameError !== null) {
      invalidDraft(nameErrorText(nameError))
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

  // Only later matching changes (own posts, PO 饼干, quotes of mine); past reminders stay as they are.
  const saveCookieId = async () => {
    const cookieIdError = checkCookieId(draft)
    if (cookieIdError !== null) {
      invalidDraft(cookieIdErrorText(cookieIdError))
      return
    }
    const cookieId = draft.trim()
    if (cookieId === credential.cookieId) {
      leave(cookieIdButton)
      return
    }
    setPending(true)
    try {
      const result = await window.xidao.identities.setCookieId({ credentialId: credential.id, cookieId })
      if (result.ok) {
        onAnnounce({ tone: 'success', text: `「${credential.name}」的饼干 ID 已${credential.cookieId === null ? '填写' : '改'}为 ${cookieId}` })
        void reloadCookieColors()
        await onChanged()
        leave(cookieIdButton)
      } else if (result.reason === 'cookie-id') {
        // The input is disabled while saving; it takes focus back once the save ends.
        refocusInput.current = true
        setError(mutationErrorText(result, '保存'))
      } else {
        setError(mutationErrorText(result, '保存'))
        if (result.reason === 'not-found') await onChanged()
      }
    } catch {
      setError('请求失败，饼干 ID 未保存，请重试')
    } finally {
      setPending(false)
    }
  }

  const saveEdit = (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    void flight.run(mode === 'cookie-id' ? saveCookieId : saveRename)
  }

  const confirmRemove = () =>
    flight.run(async () => {
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
    })

  const onEditorKeyDown = (event: KeyboardEvent) => {
    // Esc cancels the inline step only; the dialog stays open.
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (!pending) leave(openerOf(mode))
  }

  return (
    <li
      className={sort?.dragging === credential.id ? 'credential-item is-sort-dragging' : 'credential-item'}
      data-sort-key={sort === null ? undefined : credential.id}
    >
      {mode === 'rename' || mode === 'cookie-id' ? (
        <form className="credential-rename" onSubmit={saveEdit} onKeyDown={onEditorKeyDown}>
          <label className="field-label" htmlFor={nameId}>
            {mode === 'rename' ? '新名称' : `「${credential.name}」的饼干 ID`}
          </label>
          <div className="credential-rename-row">
            <input
              id={nameId}
              ref={editInput}
              className={mode === 'cookie-id' ? 'text-input cookie-id-input' : 'text-input'}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setError(null)
              }}
              maxLength={mode === 'cookie-id' ? COOKIE_ID_MAX_LENGTH : undefined}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={error !== null ? true : undefined}
              aria-describedby={errorId}
              disabled={pending}
            />
            {/* Saving keeps both buttons focusable; `saveEdit` and 取消 refuse while it runs. */}
            <button type="submit" className="btn btn-small btn-page" aria-disabled={pending || undefined} aria-busy={pending || undefined}>
              {pending ? '正在保存…' : '保存'}
            </button>
            <button
              type="button"
              className="btn btn-small btn-page"
              onClick={() => {
                if (!pending) leave(openerOf(mode))
              }}
              aria-disabled={pending || undefined}
            >
              取消
            </button>
          </div>
        </form>
      ) : (
        <div className="credential-main">
          {sort !== null && mode === 'view' ? (
            <SortHandle sort={sort} itemKey={credential.id} label={credential.name} disabled={sortPending} />
          ) : (
            <Icon name="key" className="credential-icon" />
          )}
          <div className="credential-text">
            <p className="credential-name">
              <span>{credential.name}</span>
              {(browsing || roles.length > 0) && (
                <span className="credential-roles">
                  <span className="visually-hidden">用于：</span>
                  {browsing && <span className="tag">浏览</span>}
                  {roles.map((role) => (
                    <span key={role} className="tag">
                      {ROLE_INFO[role].label}
                    </span>
                  ))}
                </span>
              )}
            </p>
            <p className="credential-meta">
              <span className="credential-cookie-id">
                {credential.cookieId === null ? cookieIdLabel(null) : <>饼干 ID <CookieId cookieId={credential.cookieId} /></>}
              </span>
              {' · '}
              {SOURCE_LABEL[credential.source]} · 导入于 {formatRecordTime(credential.importedAt)}
            </p>
          </div>
          <div className="credential-actions">
            <button
              type="button"
              ref={renameButton}
              className="btn btn-small btn-page"
              onClick={() => {
                if (actionsAvailable) startEdit('rename')
              }}
              aria-disabled={!actionsAvailable || undefined}
              aria-label={`重命名「${credential.name}」`}
            >
              重命名
            </button>
            <button
              type="button"
              ref={cookieIdButton}
              className="btn btn-small btn-page"
              onClick={() => {
                if (actionsAvailable) startEdit('cookie-id')
              }}
              aria-disabled={!actionsAvailable || undefined}
              aria-label={`${credential.cookieId === null ? '填写' : '修改'}「${credential.name}」的饼干 ID`}
            >
              {credential.cookieId === null ? '填写 ID' : '修改 ID'}
            </button>
            <button
              type="button"
              ref={removeButton}
              className="btn btn-small btn-danger btn-page"
              onClick={() => {
                if (!actionsAvailable) return
                setError(null)
                setMode('confirm-remove')
              }}
              aria-disabled={!actionsAvailable || undefined}
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
          </p>
          <div className="credential-confirm-actions">
            <button
              type="button"
              className="btn btn-small btn-danger btn-page"
              onClick={() => void confirmRemove()}
              aria-disabled={pending || undefined}
              aria-busy={pending || undefined}
            >
              {pending ? '正在移除…' : '确认移除'}
            </button>
            <button
              type="button"
              ref={cancelRemove}
              className="btn btn-small btn-page"
              onClick={() => {
                if (!pending) leave(removeButton)
              }}
              aria-disabled={pending || undefined}
            >
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

const IMPORT_COPY: Record<ImportEntry, { tab: string; title: string; secretLabel: string; placeholder: string }> = {
  export: { tab: '官网导出', title: '粘贴官网导出内容', secretLabel: '官网导出内容', placeholder: '二维码图片地址或导出内容' },
  raw: { tab: 'userhash', title: '粘贴原始 userhash', secretLabel: 'userhash', placeholder: '粘贴到这里' }
}

const IMPORT_ENTRIES: readonly ImportEntry[] = ['export', 'raw']

/** One import area: a switch picks the format; switching clears whatever was pasted. */
function ImportArea({ disabled, onImported, active }: { disabled: boolean; onImported: () => Promise<void>; active: boolean }) {
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
      <ImportForm key={entry} entry={entry} disabled={disabled} onImported={onImported} active={active} />
    </div>
  )
}

/** The import area's form for one format; its heading and switch name it. */
function ImportForm({
  entry,
  disabled,
  onImported,
  active
}: {
  entry: ImportEntry
  disabled: boolean
  onImported: () => Promise<void>
  /** 设置 is the active tab. */
  active: boolean
}) {
  const copy = IMPORT_COPY[entry]
  // Uncontrolled on purpose: React would mirror a controlled value into the `value` attribute.
  const secretRef = useRef<HTMLInputElement>(null)
  const [shown, setShown] = useState(false)
  const [cookieId, setCookieId] = useState('')
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [invalid, setInvalid] = useState<FailureField>(null)
  const secretId = useId()
  const cookieIdId = useId()
  const nameId = useId()
  const messageId = useId()
  // The userhash alone carries no public ID; an export carries it as its `name`.
  const askCookieId = entry === 'raw'

  // The pasted value never outlives this form (dialog closed or section unmounted).
  useEffect(() => {
    const input = secretRef.current
    return () => {
      if (input !== null) input.value = ''
    }
  }, [])

  // Nor stays behind while another tab is shown: settings left, it is gone and hidden again. An
  // import already sent keeps its own copy and finishes as usual.
  useEffect(() => {
    if (active) return
    if (secretRef.current !== null) secretRef.current.value = ''
    setShown(false)
  }, [active])

  const fail = (text: string, field: FailureField) => {
    setMessage({ tone: 'error', text })
    setInvalid(field)
    const target = field === 'secret' ? secretId : field === 'cookie-id' ? cookieIdId : field === 'name' ? nameId : null
    if (target !== null) document.getElementById(target)?.focus()
  }

  /** The entered values are done with: stored, or the same userhash was already there. */
  const clear = () => {
    if (secretRef.current !== null) secretRef.current.value = ''
    setShown(false)
    setCookieId('')
    setName('')
    setInvalid(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || disabled) return
    const trimmedId = cookieId.trim()
    if (askCookieId) {
      const cookieIdError = checkCookieId(cookieId)
      if (cookieIdError !== null) {
        fail(cookieIdErrorText(cookieIdError), 'cookie-id')
        return
      }
    }
    const trimmedName = name.trim()
    if (trimmedName !== '') {
      const nameError = checkName(name)
      if (nameError !== null) {
        fail(nameErrorText(nameError), 'name')
        return
      }
    }
    const secret = secretRef.current?.value ?? ''
    const named = trimmedName === '' ? {} : { name: trimmedName }
    setPending(true)
    setMessage(null)
    try {
      const result =
        entry === 'export'
          ? await window.xidao.identities.importExport({ payload: secret, ...named })
          : await window.xidao.identities.importRaw({ userhash: secret, cookieId: trimmedId, ...named })
      if (result.ok) {
        clear()
        setMessage({ tone: 'success', text: `已导入${importedText(result.credential)}` })
        await onImported()
      } else if (result.failure.reason === 'duplicate') {
        const failure = result.failure
        clear()
        setMessage({ tone: failure.cookieId === 'conflict' ? 'error' : 'success', text: duplicateText(failure, askCookieId ? trimmedId : null) })
        if (failure.cookieId === 'filled') await onImported()
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

  return (
    <form className="import-form" aria-label={copy.title} onSubmit={(event) => void submit(event)} noValidate>
      {/* Not a disabled fieldset: that would take the page button out of the tab order too. The
          fields and 导入 are disabled one by one; `submit` refuses while `disabled` or pending. */}
      <fieldset className="import-fieldset">
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
            placeholder={copy.placeholder}
            aria-describedby={invalid === 'secret' ? messageId : undefined}
            aria-invalid={invalid === 'secret' ? true : undefined}
            disabled={disabled}
            onInput={() => {
              if (invalid === 'secret') setInvalid(null)
            }}
          />
          {/* A page button: unavailable it stays focusable (not inside a disabled fieldset) and does nothing. */}
          <button
            type="button"
            className="btn btn-small btn-page"
            onClick={() => {
              if (!disabled) setShown((value) => !value)
            }}
            aria-disabled={disabled || undefined}
            aria-controls={secretId}
            aria-label={`${shown ? '隐藏' : '显示'}${copy.secretLabel}`}
          >
            {shown ? '隐藏' : '显示'}
          </button>
        </div>
        {askCookieId && (
          <>
            <label className="field-label" htmlFor={cookieIdId}>
              饼干 ID
            </label>
            <input
              id={cookieIdId}
              className="text-input cookie-id-input"
              value={cookieId}
              onChange={(event) => {
                setCookieId(event.target.value)
                if (invalid === 'cookie-id') setInvalid(null)
              }}
              maxLength={COOKIE_ID_MAX_LENGTH}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="发言旁显示的饼干 ID"
              required
              aria-required
              aria-describedby={invalid === 'cookie-id' ? messageId : undefined}
              aria-invalid={invalid === 'cookie-id' ? true : undefined}
              disabled={disabled}
            />
          </>
        )}
        <label className="field-label" htmlFor={nameId}>
          显示名称（可选）
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
          placeholder={entry === 'export' ? '默认为导出内容中的饼干 ID' : '默认为饼干 ID'}
          aria-describedby={invalid === 'name' ? messageId : undefined}
          aria-invalid={invalid === 'name' ? true : undefined}
          disabled={disabled}
        />

        <div className="import-actions">
          <button type="submit" className="btn btn-primary" disabled={pending || disabled} aria-describedby={messageId}>
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
      const publicIds = new Map(cookies.map((cookie) => [cookie.id, cookie.publicId]))
      const counts: AccountImportCounts = { imported: 0, filled: 0, same: 0, conflict: 0, failed: 0 }
      for (const { id, result: item } of result.value) {
        if (item.ok) {
          counts.imported += 1
          settled.add(id)
          next.set(id, { tone: 'success', text: `已导入为${importedText(item.credential)}` })
        } else if (item.failure.reason === 'duplicate') {
          const failure = item.failure
          counts[failure.cookieId] += 1
          settled.add(id)
          next.set(id, {
            tone: failure.cookieId === 'conflict' ? 'error' : 'success',
            text: duplicateText(failure, publicIds.get(id) ?? null)
          })
        } else {
          counts.failed += 1
          next.set(id, { tone: 'error', text: accountImportFailureText(item.failure) })
        }
      }
      setOutcomes(next)
      setSelected((current) => new Set([...current].filter((id) => !settled.has(id))))
      setMessage({ tone: counts.failed > 0 || counts.conflict > 0 ? 'error' : 'success', text: accountImportSummary(counts) })
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
            <button type="button" className="btn btn-small btn-page" onClick={() => void readOverview()}>
              重试
            </button>
          </div>
        ) : null
      ) : (
        <>
          {loggedIn && (
            <p className="settings-group-text">
              {overview.expiresAt === null ? '已登录' : `已登录，有效至 ${formatRecordTime(overview.expiresAt)}`}
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
                  className={cookies === null ? 'btn btn-primary' : 'btn btn-page'}
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
            <p className="settings-empty">
              账号里没有饼干
              <KaomojiDecor state="accountCookiesEmpty" />
            </p>
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
                            {cookie.validUntil !== null && <span>有效时间 {formatForumTime(cookie.validUntil)}</span>}
                            {cookie.claimedAt !== null && <span>领取时间 {formatForumTime(cookie.claimedAt)}</span>}
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
              ? `${item.name}（${SOURCE_LABEL[item.source]}，${formatRecordTime(item.importedAt)}）`
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
