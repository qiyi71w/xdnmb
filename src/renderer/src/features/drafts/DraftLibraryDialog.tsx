import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { targetText, type DraftId, type SavedDraft } from '../../../../shared/drafts'
import { isUnsettled } from '../../../../shared/publication'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Modal, ModalHeader } from '../../components/Modal'
import { formatRecordTime } from '../../lib/time'
import { editorForDraft } from '../editor/editorsState'
import { credentialLine, excerpt, SAVE_FAILURE_TEXT } from '../editor/editorText'
import type { SaveFailure } from '../editor/useEditorsStore'
import { useEditorWorkspace } from '../editor/workspace'
import './drafts.css'

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; drafts: SavedDraft[] }

/** Drafts that sends still in progress hold (no edit, save or delete); `null`: could not be read. */
type Locks = ReadonlySet<DraftId> | null

/** Why a draft whose send is still sending or being checked cannot be deleted (row and tooltip). */
const LOCKED_TEXT = '发送结果还没确定，暂时不能删除'
/** The send records could not be read: any draft may be held by a send, so none is deleted. */
const UNKNOWN_LOCK_TEXT = '发送状态未知，暂时不能删除'

/**
 * 草稿 library: every saved draft, most recently saved first; several may share a target.
 * 继续 hands the draft to the shell (focus its editor, load it into the editor already on its
 * target, or open it in a new tab); 删除 removes the record at once, closing an editor that
 * continues it, and can be undone from its bottom notice, which shows over this dialog (the draft
 * comes back into this list). A draft whose send is still sending or being checked, or any draft
 * while the send records cannot be read, cannot be deleted: 删除 is then unavailable and says why.
 * Esc, 关闭 or a press on the backdrop closes it.
 */
export function DraftLibraryDialog({
  tabTitle,
  onContinue,
  onClose,
  fallbackFocus
}: {
  tabTitle: (tabId: number) => string
  /** Resolves to why the draft could not be continued, or null when it was. */
  onContinue: (draft: SavedDraft) => Promise<string | null>
  onClose: () => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const { store, identities, forumName } = useEditorWorkspace()
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [locks, setLocks] = useState<Locks>(() => new Set())
  const [deleting, setDeleting] = useState<DraftId | null>(null)
  const deletingRef = useRef(false)
  const [deleteFailed, setDeleteFailed] = useState<{ draftId: DraftId; reason: SaveFailure } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const closeRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const focusAfterDelete = useRef<number | null>(null)
  const unknownLockId = useId()

  const load = useCallback(async (quiet: boolean) => {
    if (!quiet) setList({ status: 'loading' })
    const [drafts, attempts] = await Promise.allSettled([window.xidao.drafts.list(), window.xidao.publication.listAttempts()])
    if (!alive.current) return
    if (attempts.status === 'fulfilled' && attempts.value.ok) {
      const held = attempts.value.attempts.filter(isUnsettled)
      setLocks(new Set(held.flatMap((attempt) => (attempt.draftId === null ? [] : [attempt.draftId]))))
    } else setLocks(null)
    if (drafts.status === 'fulfilled' && drafts.value.ok) setList({ status: 'ready', drafts: drafts.value.drafts })
    else setList((current) => (quiet && current.status === 'ready' ? current : { status: 'failed' }))
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Read again when a send changed drafts (failed → saved, confirmed → cleared) while open.
  const revision = store.publicationRevision
  const loaded = useRef(false)
  useEffect(() => {
    const quiet = loaded.current
    loaded.current = true
    void load(quiet)
  }, [load, revision])

  // After a deletion, keep focus in the list: the item now at the same position, else (the last
  // one gone) the dialog's close button.
  useLayoutEffect(() => {
    const index = focusAfterDelete.current
    if (index === null || list.status !== 'ready') return
    focusAfterDelete.current = null
    const items = listRef.current?.querySelectorAll<HTMLElement>('.draft-item') ?? []
    const item = items[Math.min(index, items.length - 1)]
    const target = item?.querySelector<HTMLElement>('button:not([aria-disabled="true"])') ?? closeRef.current?.querySelector<HTMLElement>('button')
    target?.focus()
  }, [list])

  /**
   * One press deletes: no confirmation; the bottom notice can undo it. `deletingRef` is taken before
   * anything awaits, so a second press (or Enter held down) while this one runs does nothing.
   */
  const remove = async (draft: SavedDraft, index: number) => {
    if (deletingRef.current) return
    deletingRef.current = true
    setDeleting(draft.id)
    setDeleteFailed(null)
    try {
      // An editor continuing the draft is closed with it (that editor only); the store refuses a
      // draft a send holds, and on failure nothing is deleted.
      const outcome = await store.deleteDraft(draft, 'close')
      if (!alive.current) return
      if (!outcome.ok) {
        setDeleteFailed({ draftId: draft.id, reason: outcome.reason })
        return
      }
      focusAfterDelete.current = index
      setList((current) => (current.status === 'ready' ? { status: 'ready', drafts: current.drafts.filter((item) => item.id !== draft.id) } : current))
    } finally {
      deletingRef.current = false
      if (alive.current) setDeleting(null)
    }
  }

  const [continueFailed, setContinueFailed] = useState<{ draftId: DraftId; text: string } | null>(null)
  const continueDraft = async (draft: SavedDraft) => {
    setContinueFailed(null)
    const failure = await onContinue(draft)
    if (failure !== null && alive.current) setContinueFailed({ draftId: draft.id, text: failure })
  }

  return (
    <Modal className="drafts-dialog" label="草稿" onClose={onClose} closeOnBackdrop fallbackFocus={fallbackFocus}>
      <div ref={closeRef}>
        <ModalHeader title="草稿" closeLabel="关闭草稿" onClose={onClose} />
      </div>
      <div className="modal-body drafts-body" aria-busy={list.status === 'loading' || undefined}>
        {list.status === 'failed' && (
          <div className="notice notice-error" role="alert">
            <Icon name="alert" className="notice-icon" />
            <div className="notice-text">
              <p className="notice-title">
                草稿读取失败：本地存储不可用
                <KaomojiDecor state="failure" />
              </p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void load(false)}>
              重试
            </button>
          </div>
        )}
        {list.status === 'ready' && locks === null && list.drafts.length > 0 && (
          <p className="notice-inline is-warning" role="status" id={unknownLockId}>
            <Icon name="alert" size={14} />
            发送记录读取失败，发送状态未知，暂时不能删除草稿
            <button type="button" className="btn btn-small" onClick={() => void load(true)}>
              重新读取
            </button>
          </p>
        )}
        {list.status === 'ready' && list.drafts.length === 0 && (
          <div className="drafts-empty" role="status">
            <p className="drafts-empty-title">
              <KaomojiDecor state="draftsEmpty" above />
              还没有草稿
            </p>
          </div>
        )}
        {list.status === 'ready' && list.drafts.length > 0 && (
          <ul className="drafts-list" ref={listRef} aria-label={`草稿列表，共 ${list.drafts.length} 份`}>
            {list.drafts.map((draft, index) => {
              const editing = editorForDraft(store.state, draft.id)
              // A send holds it: its attempt (sending or being checked), or the editor continuing it.
              const sendHeld = locks?.has(draft.id) === true || (editing !== null && editing.publication !== null)
              // Unknown sends (the records could not be read) may hold it too: deleting waits until they are known.
              const lockText = sendHeld ? LOCKED_TEXT : locks === null ? UNKNOWN_LOCK_TEXT : null
              const locked = lockText !== null
              const identity = credentialLine(draft.credentialId, identities.overview)
              const target = targetText(draft.target, forumName)
              const rowId = `draft-${draft.id}`
              return (
                <li key={draft.id} className="draft-item" aria-labelledby={`${rowId}-target`}>
                  {draft.attachment !== null && (
                    <img
                      className="draft-thumb"
                      src={draft.attachment.url}
                      alt=""
                      onError={(event) => (event.currentTarget.hidden = true)}
                    />
                  )}
                  <div className="draft-text">
                    <p className="draft-target" id={`${rowId}-target`}>
                      {target}
                    </p>
                    <p className="draft-excerpt">{excerpt(draft.fields, draft.attachment, 80)}</p>
                    <p className="draft-meta">
                      <span className={identity.warning ? 'draft-identity is-warning' : 'draft-identity'}>
                        饼干：{identity.text}
                      </span>
                      {draft.attachment !== null && (
                        <span className="draft-image">
                          <Icon name="image" size={13} />
                          有图
                        </span>
                      )}
                      <span>保存于 {formatRecordTime(draft.savedAt)}</span>
                    </p>
                    {editing !== null && (
                      <p className="draft-editing" id={`${rowId}-editing`}>
                        正在「{tabTitle(editing.tabId)}」标签编辑
                      </p>
                    )}
                    {sendHeld && (
                      <p className="draft-locked" id={`${rowId}-locked`}>
                        <Icon name="alert" size={13} />
                        {LOCKED_TEXT}
                      </p>
                    )}
                    {deleteFailed?.draftId === draft.id && (
                      <p className="notice-inline is-warning" role="alert">
                        <Icon name="alert" size={14} />
                        没能删除：{deleteFailed.reason === 'locked' ? '发送结果还没确定' : SAVE_FAILURE_TEXT[deleteFailed.reason]}，草稿仍保留
                        <KaomojiDecor state="failure" />
                      </p>
                    )}
                    {continueFailed?.draftId === draft.id && (
                      <p className="notice-inline is-warning" role="alert">
                        <Icon name="alert" size={14} />
                        {continueFailed.text}
                        <KaomojiDecor state="failure" />
                      </p>
                    )}
                  </div>
                  <div className="draft-actions">
                    {sendHeld && editing === null ? null : (
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-describedby={`${rowId}-target`}
                        onClick={() => void continueDraft(draft)}
                      >
                        <Icon name="draft" size={14} />
                        继续
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-small btn-danger"
                      aria-describedby={sendHeld ? `${rowId}-locked` : locked ? unknownLockId : editing !== null ? `${rowId}-editing` : `${rowId}-target`}
                      aria-disabled={locked || deleting !== null || undefined}
                      aria-busy={deleting === draft.id || undefined}
                      title={lockText ?? undefined}
                      onClick={() => {
                        if (!locked && deleting === null) void remove(draft, index)
                      }}
                    >
                      <Icon name="trash" size={14} />
                      {deleting === draft.id ? '正在删除…' : '删除'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
