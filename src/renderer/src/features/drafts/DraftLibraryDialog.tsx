import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DraftId, SavedDraft } from '../../../../shared/drafts'
import { Icon } from '../../components/Icon'
import { Modal, ModalHeader } from '../../components/Modal'
import { formatLocalTime } from '../../lib/format'
import { editorForDraft } from '../editor/editorsState'
import { credentialLine, excerpt, targetText } from '../editor/editorText'
import { useEditorWorkspace } from '../editor/workspace'
import './drafts.css'

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; drafts: SavedDraft[] }

/** Drafts that unresolved attempts hold (no edit, save or delete); `null`: could not be read. */
type Locks = ReadonlySet<DraftId> | null

/**
 * 草稿 library: every saved draft, most recently saved first; several may share a target.
 * 继续 hands the draft to the shell (focus its editor, or open it in a new tab); 删除 removes the
 * record after confirmation and is unavailable while the draft is being edited. A draft whose send
 * is still sending or unresolved is locked: it can only be looked up in 发送记录.
 */
export function DraftLibraryDialog({
  tabTitle,
  onContinue,
  onOpenAttempts,
  onClose,
  fallbackFocus
}: {
  tabTitle: (tabId: number) => string
  onContinue: (draft: SavedDraft) => void
  onOpenAttempts: () => void
  onClose: () => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const { store, identities, forumName } = useEditorWorkspace()
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [locks, setLocks] = useState<Locks>(() => new Set())
  const [confirming, setConfirming] = useState<DraftId | null>(null)
  const [deleting, setDeleting] = useState<DraftId | null>(null)
  const [deleteFailed, setDeleteFailed] = useState<{ draftId: DraftId; locked: boolean } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const closeRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const focusAfterDelete = useRef<number | null>(null)

  const load = useCallback(async (quiet: boolean) => {
    if (!quiet) setList({ status: 'loading' })
    const [drafts, attempts] = await Promise.allSettled([window.xidao.drafts.list(), window.xidao.publication.listAttempts()])
    if (!alive.current) return
    if (attempts.status === 'fulfilled' && attempts.value.ok) {
      const held = attempts.value.attempts.filter(
        (attempt) => attempt.state === 'sending' || attempt.state === 'unknown' || attempt.state === 'unconfirmed'
      )
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

  // Confirming moves focus to 确认删除; leaving the confirmation returns it to that row's 删除.
  const confirmRef = useRef<HTMLButtonElement>(null)
  const lastConfirmed = useRef<DraftId | null>(null)
  useLayoutEffect(() => {
    if (confirming !== null) {
      lastConfirmed.current = confirming
      confirmRef.current?.focus()
      return
    }
    const draftId = lastConfirmed.current
    lastConfirmed.current = null
    if (draftId !== null) listRef.current?.querySelector<HTMLElement>(`[data-delete-id="${draftId}"]`)?.focus()
  }, [confirming])

  // After a deletion, keep focus in the list: the item now at the same position, else the dialog.
  useLayoutEffect(() => {
    const index = focusAfterDelete.current
    if (index === null || list.status !== 'ready') return
    focusAfterDelete.current = null
    const items = listRef.current?.querySelectorAll<HTMLElement>('.draft-item') ?? []
    const item = items[Math.min(index, items.length - 1)]
    const target = item?.querySelector<HTMLElement>('button:not(:disabled)') ?? closeRef.current?.querySelector<HTMLElement>('button')
    target?.focus()
  }, [list])

  const remove = async (draft: SavedDraft, index: number) => {
    if (deleting !== null) return
    setDeleting(draft.id)
    setDeleteFailed(null)
    let failure: { draftId: DraftId; locked: boolean } | null = null
    try {
      const result = await window.xidao.drafts.delete({ draftId: draft.id })
      if (!result.ok) failure = { draftId: draft.id, locked: result.reason === 'locked' }
    } catch {
      failure = { draftId: draft.id, locked: false }
    }
    if (!alive.current) return
    setDeleting(null)
    setConfirming(null)
    if (failure !== null) {
      setDeleteFailed(failure)
      return
    }
    focusAfterDelete.current = index
    setList((current) => (current.status === 'ready' ? { status: 'ready', drafts: current.drafts.filter((item) => item.id !== draft.id) } : current))
  }

  return (
    <Modal className="drafts-dialog" label="草稿" onClose={onClose} fallbackFocus={fallbackFocus}>
      <div ref={closeRef}>
        <ModalHeader title="草稿" closeLabel="关闭草稿" onClose={onClose} />
      </div>
      <div className="modal-body drafts-body" aria-busy={list.status === 'loading' || undefined}>
        {list.status === 'failed' && (
          <div className="notice notice-error" role="alert">
            <Icon name="alert" className="notice-icon" />
            <div className="notice-text">
              <p className="notice-title">草稿读取失败：本地存储不可用</p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void load(false)}>
              重试
            </button>
          </div>
        )}
        {list.status === 'ready' && locks === null && list.drafts.length > 0 && (
          <p className="notice-inline is-warning" role="status">
            <Icon name="alert" size={14} />
            发送记录读取失败，锁定状态未知
          </p>
        )}
        {list.status === 'ready' && list.drafts.length === 0 && (
          <div className="drafts-empty" role="status">
            <p className="drafts-empty-title">还没有草稿</p>
          </div>
        )}
        {list.status === 'ready' && list.drafts.length > 0 && (
          <ul className="drafts-list" ref={listRef} aria-label={`草稿列表，共 ${list.drafts.length} 份`}>
            {list.drafts.map((draft, index) => {
              const editing = editorForDraft(store.state, draft.id)
              const locked = locks?.has(draft.id) === true
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
                      <span>保存于 {formatLocalTime(draft.savedAt)}</span>
                    </p>
                    {editing !== null && (
                      <p className="draft-editing" id={`${rowId}-editing`}>
                        正在「{tabTitle(editing.tabId)}」标签编辑
                      </p>
                    )}
                    {locked && (
                      <p className="draft-locked" id={`${rowId}-locked`}>
                        <Icon name="alert" size={13} />
                        发送结果待核对，已锁定
                      </p>
                    )}
                    {deleteFailed?.draftId === draft.id && (
                      <p className="notice-inline is-warning" role="alert">
                        <Icon name="alert" size={14} />
                        {deleteFailed.locked
                          ? '删除失败：草稿已锁定'
                          : '删除失败：本地存储不可用'}
                      </p>
                    )}
                  </div>
                  {confirming === draft.id ? (
                    <div className="draft-actions" role="group" aria-label={`确认删除：${target}`}>
                      <button
                        ref={confirmRef}
                        type="button"
                        className="btn btn-small btn-danger"
                        aria-busy={deleting === draft.id || undefined}
                        onClick={() => void remove(draft, index)}
                      >
                        {deleting === draft.id ? '正在删除…' : '确认删除'}
                      </button>
                      <button type="button" className="btn btn-small" disabled={deleting === draft.id} onClick={() => setConfirming(null)}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <div className="draft-actions">
                      {locked && editing === null ? (
                        <button
                          type="button"
                          className="btn btn-small"
                          aria-describedby={`${rowId}-locked`}
                          onClick={onOpenAttempts}
                        >
                          <Icon name="history" size={14} />
                          查看发送记录
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-small"
                          aria-describedby={`${rowId}-target`}
                          onClick={() => onContinue(draft)}
                        >
                          <Icon name="draft" size={14} />
                          继续
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        data-delete-id={draft.id}
                        aria-describedby={locked ? `${rowId}-locked` : editing !== null ? `${rowId}-editing` : `${rowId}-target`}
                        disabled={locked || editing !== null || deleting !== null}
                        onClick={() => {
                          setDeleteFailed(null)
                          setConfirming(draft.id)
                        }}
                      >
                        <Icon name="trash" size={14} />
                        删除
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
