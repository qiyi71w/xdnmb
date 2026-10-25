import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { PostTarget, SavedDraft } from '../../../../shared/drafts'
import type { PublicationAttempt } from '../../../../shared/publication'
import { Icon } from '../../components/Icon'
import { Modal, ModalHeader } from '../../components/Modal'
import { Loading } from '../../components/Notices'
import { formatLocalTime } from '../../lib/format'
import { credentialLine, excerpt, targetText } from '../editor/editorText'
import { useEditorWorkspace } from '../editor/workspace'
import { ATTEMPT_PROBLEM_TEXT, ATTEMPT_STATE_DETAIL, ATTEMPT_STATE_LABEL } from './publicationText'
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
import './publication.css'

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; attempts: PublicationAttempt[] }

/** How often the list is read again while one of its attempts is still sending (local query). */
const POLL_MS = 1000

function needsCheck(attempt: PublicationAttempt): boolean {
  return attempt.state === 'sending' || attempt.state === 'unknown' || attempt.state === 'unconfirmed'
}

/**
 * 发送记录: every durable attempt with the content, target and identity it froze, newest first;
 * those still to be checked (sending / 结果待确认 / ID 未确认) come first. Nothing here sends: an
 * unresolved attempt can only be checked at its target, a failed one continues as its saved draft.
 */
export function AttemptsDialog({ onClose, fallbackFocus, ...body }: AttemptsBodyProps & {
  onClose: () => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const titleId = useId()
  return (
    <Modal className="attempts-dialog" labelledBy={titleId} onClose={onClose} fallbackFocus={fallbackFocus}>
      <ModalHeader title="发送记录" titleId={titleId} closeLabel="关闭发送记录" onClose={onClose} />
      <AttemptsBody {...body} />
    </Modal>
  )
}

export interface AttemptsBodyProps {
  tabTitle: (tabId: number) => string
  onContinue: (draft: SavedDraft) => void
  /** Opens the attempt's thread (or forum for a new thread that has no ID) in a new tab. */
  onOpenTarget: (target: PostTarget) => void
}

export function AttemptsBody({ tabTitle, onContinue, onOpenTarget, refreshRevision = 0 }: AttemptsBodyProps & { refreshRevision?: number }) {
  const { store, identities, forumName } = useEditorWorkspace()
  const titleId = useId()
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [readFailed, setReadFailed] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [openFailed, setOpenFailed] = useState<{ id: string; text: string } | null>(null)
  const alive = useRef(true)

  const load = useCallback(async (quiet: boolean) => {
    if (!quiet) setList({ status: 'loading' })
    try {
      const result = await window.xidao.publication.listAttempts()
      if (!alive.current) return
      if (result.ok) {
        const attempts = [...result.attempts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        setList({ status: 'ready', attempts })
        setReadFailed(false)
      } else {
        if (!quiet) setList({ status: 'failed' })
        else if (PROTOTYPE_ENABLED) setReadFailed(true)
      }
    } catch {
      if (!alive.current) return
      if (!quiet) setList({ status: 'failed' })
      else if (PROTOTYPE_ENABLED) setReadFailed(true)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Read again whenever a send of this window changed something.
  const revision = store.publicationRevision
  const loaded = useRef(false)
  useEffect(() => {
    const quiet = loaded.current
    loaded.current = true
    void load(quiet)
  }, [load, revision, refreshRevision])

  const sending = list.status === 'ready' && list.attempts.some((attempt) => attempt.state === 'sending')
  useEffect(() => {
    if (!sending) return
    const timer = window.setInterval(() => void load(true), POLL_MS)
    return () => window.clearInterval(timer)
  }, [sending, load])

  const continueDraft = async (attempt: PublicationAttempt) => {
    if (opening !== null) return
    setOpening(attempt.id)
    setOpenFailed(null)
    let draft: SavedDraft | null = null
    let text = '读取草稿失败：本地存储不可用'
    try {
      const result = await window.xidao.publication.getAttempt({ attemptId: attempt.id })
      if (result.ok) {
        draft = result.draft
        text = '这份自动保存的草稿已不存在（可能已删除或已发出）'
      }
    } catch {
      text = '读取草稿失败：应用内部请求失败'
    }
    if (!alive.current) return
    setOpening(null)
    if (draft === null) setOpenFailed({ id: attempt.id, text })
    else onContinue(draft)
  }

  const attempts = list.status === 'ready' ? list.attempts : []
  const pending = attempts.filter(needsCheck)
  const done = attempts.filter((attempt) => !needsCheck(attempt))

  const renderItem = (attempt: PublicationAttempt) => {
    const payload = attempt.payload
    const target = targetText(payload.target, forumName)
    const identity = credentialLine(payload.credentialId, identities.overview)
    const editing = store.state.editors.find((editor) => editor.publication?.phase === 'attempt' && editor.publication.attempt.id === attempt.id)
    const rowId = `${titleId}-attempt-${attempt.id}`
    const state = attempt.state
    const postThread = attempt.threadId ?? (payload.target.kind === 'reply' ? payload.target.threadId : null)
    return (
      <li key={attempt.id} className={`attempt-item is-${state}`} aria-labelledby={`${rowId}-target`}>
        <div className="attempt-head">
          <span className={`attempt-badge is-${state}`}>
            <Icon name={state === 'confirmed' ? 'check' : state === 'sending' ? 'send' : 'alert'} size={13} />
            {ATTEMPT_STATE_LABEL[state]}
          </span>
          <span className="attempt-time">{formatLocalTime(attempt.createdAt)}</span>
        </div>
        <p className="attempt-target" id={`${rowId}-target`}>
          {target}
          {state === 'confirmed' && attempt.postId !== null && <span className="attempt-post"> · No.{attempt.postId}</span>}
        </p>
        <p className="attempt-meta">
          <span className={identity.warning ? 'is-warning' : undefined}>饼干：{identity.text}</span>
          {payload.attachmentId !== null && (
            <span className="attempt-image">
              <Icon name="image" size={13} />
              有图
            </span>
          )}
          {payload.fields.watermark && payload.attachmentId !== null && <span>水印开</span>}
        </p>
        <p className="attempt-excerpt">{excerpt(payload.fields, null, 80)}</p>
        {state === 'sending' && (PROTOTYPE_ENABLED
          ? <p className="attempt-detail">{ATTEMPT_STATE_DETAIL.sending}</p>
          : <Loading live={false}>{ATTEMPT_STATE_DETAIL.sending}</Loading>)}
        {(state === 'unknown' || state === 'unconfirmed') && (
          <p className="attempt-detail">
            {ATTEMPT_STATE_DETAIL[state]}
            {attempt.problem !== null && `（${ATTEMPT_PROBLEM_TEXT[attempt.problem]}）`}
          </p>
        )}
        {state === 'failed' && (
          <p className="attempt-detail">
            {attempt.problem === null ? '发送失败' : ATTEMPT_PROBLEM_TEXT[attempt.problem]}。
            {attempt.savedDraftId !== null ? '内容已自动保存为草稿，可继续编辑后再发。' : '自动保存草稿没有成功；内容仍在下方保留。'}
          </p>
        )}
        {editing !== undefined && <p className="attempt-editing">仍在「{tabTitle(editing.tabId)}」标签的编辑中显示</p>}
        <details className="attempt-content">
          <summary>查看保留的内容</summary>
          <dl>
            {payload.fields.title !== '' && (
              <div>
                <dt>标题</dt>
                <dd>{payload.fields.title}</dd>
              </div>
            )}
            {payload.fields.name !== '' && (
              <div>
                <dt>名称</dt>
                <dd>{payload.fields.name}</dd>
              </div>
            )}
            {payload.fields.email !== '' && (
              <div>
                <dt>E-mail</dt>
                <dd>{payload.fields.email}</dd>
              </div>
            )}
            <div>
              <dt>正文</dt>
              <dd className="attempt-body">{payload.fields.content === '' ? '（无正文）' : payload.fields.content}</dd>
            </div>
          </dl>
        </details>
        {openFailed?.id === attempt.id && (
          <p className="notice-inline is-warning" role="alert">
            <Icon name="alert" size={14} />
            {openFailed.text}
          </p>
        )}
        <div className="attempt-actions">
          {state === 'failed' && attempt.savedDraftId !== null && (
            <button
              type="button"
              className="btn btn-small"
              aria-describedby={`${rowId}-target`}
              aria-busy={opening === attempt.id || undefined}
              onClick={() => void continueDraft(attempt)}
            >
              <Icon name="draft" size={14} />
              继续草稿
            </button>
          )}
          {state !== 'failed' && state !== 'sending' && (postThread !== null || payload.target.kind === 'thread') && (
            <button
              type="button"
              className="btn btn-small"
              aria-describedby={`${rowId}-target`}
              onClick={() =>
                onOpenTarget(postThread !== null ? { kind: 'reply', threadId: postThread } : payload.target)
              }
            >
              <Icon name="arrowRight" size={14} />
              {state === 'confirmed' ? '打开串' : postThread !== null ? '打开串核对' : '打开版面核对'}
            </button>
          )}
        </div>
      </li>
    )
  }

  return (
      <div className="modal-body attempts-body" aria-busy={list.status === 'loading' || undefined}>
        {!PROTOTYPE_ENABLED && <p className="attempts-intro">每次发送都先记录在本机。汐岛不会自动重发；结果待确认或 ID 未确认的发送只能到目标处核对。</p>}
        {list.status === 'loading' && !PROTOTYPE_ENABLED && <Loading>正在读取发送记录…</Loading>}
        {(list.status === 'failed' || readFailed) && (
          <div className={`notice notice-error${PROTOTYPE_ENABLED ? ' is-compact' : ''}`} role="alert">
            <Icon name="alert" className="notice-icon" />
            <div className="notice-text">
              <p className="notice-title">发送记录读取失败：本地存储不可用</p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void load(false)}>
              重试
            </button>
          </div>
        )}
        {list.status === 'ready' && attempts.length === 0 && (
          <div className="attempts-empty" role="status">
            <p className="attempts-empty-title">还没有发送记录</p>
          </div>
        )}
        {pending.length > 0 && (
          <section aria-labelledby={`${titleId}-pending`}>
            <h3 className="attempts-heading" id={`${titleId}-pending`}>
              需要留意（{pending.length}）
            </h3>
            <ul className="attempts-list">{pending.map(renderItem)}</ul>
          </section>
        )}
        {done.length > 0 && (
          <section aria-labelledby={`${titleId}-done`}>
            <h3 className="attempts-heading" id={`${titleId}-done`}>
              已有结果
            </h3>
            <ul className="attempts-list">{done.map(renderItem)}</ul>
          </section>
        )}
      </div>
  )
}
