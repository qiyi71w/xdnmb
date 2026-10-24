import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DraftId, SavedDraft } from '../../../../shared/drafts'
import { Icon } from '../../components/Icon'
import { Modal, ModalHeader } from '../../components/Modal'
import { Loading } from '../../components/Notices'
import { formatLocalTime } from '../../lib/format'
import { editorForDraft } from '../editor/editorsState'
import { credentialLine, excerpt, targetText } from '../editor/editorText'
import { useEditorWorkspace } from '../editor/workspace'
import './drafts.css'

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; drafts: SavedDraft[] }

/**
 * 草稿 library: every saved draft, most recently saved first; several may share a target.
 * 继续 hands the draft to the shell (focus its editor, or open it in a new tab); 删除 removes the
 * record after confirmation and is unavailable while the draft is being edited.
 */
export function DraftLibraryDialog({
  tabTitle,
  onContinue,
  onClose,
  fallbackFocus
}: {
  tabTitle: (tabId: number) => string
  onContinue: (draft: SavedDraft) => void
  onClose: () => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const { store, identities, forumName } = useEditorWorkspace()
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [confirming, setConfirming] = useState<DraftId | null>(null)
  const [deleting, setDeleting] = useState<DraftId | null>(null)
  const [deleteFailed, setDeleteFailed] = useState<DraftId | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const closeRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const focusAfterDelete = useRef<number | null>(null)

  const load = useCallback(async () => {
    setList({ status: 'loading' })
    try {
      const result = await window.xidao.drafts.list()
      if (alive.current) setList(result.ok ? { status: 'ready', drafts: result.drafts } : { status: 'failed' })
    } catch {
      if (alive.current) setList({ status: 'failed' })
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

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
    let ok = false
    try {
      ok = (await window.xidao.drafts.delete({ draftId: draft.id })).ok
    } catch {
      ok = false
    }
    if (!alive.current) return
    setDeleting(null)
    setConfirming(null)
    if (!ok) {
      setDeleteFailed(draft.id)
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
      <div className="modal-body drafts-body">
        {list.status === 'loading' && <Loading>正在读取草稿…</Loading>}
        {list.status === 'failed' && (
          <div className="notice notice-error" role="alert">
            <Icon name="alert" className="notice-icon" />
            <div className="notice-text">
              <p className="notice-title">草稿读取失败：本地存储不可用</p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}
        {list.status === 'ready' && list.drafts.length === 0 && (
          <div className="drafts-empty" role="status">
            <p className="drafts-empty-title">还没有草稿</p>
            <p className="drafts-empty-text">在串或版面底部编辑后点“保存草稿”，草稿会保存在这里。</p>
          </div>
        )}
        {list.status === 'ready' && list.drafts.length > 0 && (
          <ul className="drafts-list" ref={listRef} aria-label={`草稿列表，共 ${list.drafts.length} 份`}>
            {list.drafts.map((draft, index) => {
              const editing = editorForDraft(store.state, draft.id)
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
                    {deleteFailed === draft.id && (
                      <p className="notice-inline is-warning" role="alert">
                        <Icon name="alert" size={14} />
                        删除失败：本地存储不可用，草稿仍保留
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
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-describedby={`${rowId}-target`}
                        onClick={() => onContinue(draft)}
                      >
                        <Icon name="draft" size={14} />
                        继续
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        data-delete-id={draft.id}
                        aria-describedby={editing !== null ? `${rowId}-editing` : `${rowId}-target`}
                        disabled={editing !== null || deleting !== null}
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
