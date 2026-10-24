import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { OwnPost } from '../../../../shared/publication'
import { Icon } from '../../components/Icon'
import { Modal, ModalHeader } from '../../components/Modal'
import { Loading } from '../../components/Notices'
import { formatLocalTime } from '../../lib/format'
import { credentialLine } from '../editor/editorText'
import { useEditorWorkspace } from '../editor/workspace'
import './publication.css'

type ListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; posts: OwnPost[] }

/** A forum post/thread number as typed: “No.123”, “No 123” and “123” are the same. */
function postNumber(input: string): string | null {
  const value = input.trim().replace(/^No\.?\s*/i, '')
  return /^[1-9]\d{0,19}$/.test(value) ? value : null
}

/**
 * 我的发言: posts recorded as one's own, newest first. Confirmed sends carry the identity they
 * were sent with; old IDs added by hand are only the user's own assertion, never associated with
 * an identity (so they never trigger the PO identity prompt).
 */
export function OwnPostsDialog({
  onOpenThread,
  onClose,
  fallbackFocus
}: {
  onOpenThread: (threadId: string) => void
  onClose: () => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const { store, identities } = useEditorWorkspace()
  const ids = useId()
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [postInput, setPostInput] = useState('')
  const [threadInput, setThreadInput] = useState('')
  const [isThread, setIsThread] = useState(false)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<{ warning: boolean; text: string } | null>(null)
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const result = await window.xidao.publication.listOwnPosts()
      if (!alive.current) return
      setList(
        result.ok
          ? { status: 'ready', posts: [...result.posts].sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)) }
          : { status: 'failed' }
      )
    } catch {
      if (alive.current) setList({ status: 'failed' })
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // A send confirmed while this is open adds a post: read again.
  const revision = store.publicationRevision
  useEffect(() => {
    void load()
  }, [load, revision])

  const postId = postNumber(postInput)
  const threadId = isThread ? postId : postNumber(threadInput)

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (adding) return
    if (postId === null) {
      setMessage({ warning: true, text: '请输入发言编号（数字）' })
      return
    }
    if (threadId === null) {
      setMessage({ warning: true, text: '请输入所在串号（数字），或勾选“这是我开的串”' })
      return
    }
    setAdding(true)
    setMessage(null)
    let text: string | null = null
    try {
      const result = await window.xidao.publication.addOwnPost({ postId, threadId, isThread })
      if (!result.ok) text = result.reason === 'target' ? '编号无效：主帖的发言编号应与串号相同' : '未能保存：本地存储不可用'
    } catch {
      text = '未能保存：应用内部请求失败'
    }
    if (!alive.current) return
    setAdding(false)
    if (text !== null) {
      setMessage({ warning: true, text })
      return
    }
    setMessage({ warning: false, text: `已补充 No.${postId}（人工依据）` })
    setPostInput('')
    setThreadInput('')
    setIsThread(false)
    void load()
  }

  const posts = list.status === 'ready' ? list.posts : []

  return (
    <Modal className="own-posts-dialog" labelledBy={`${ids}-title`} onClose={onClose} fallbackFocus={fallbackFocus}>
      <ModalHeader title="我的发言" titleId={`${ids}-title`} closeLabel="关闭我的发言" onClose={onClose} />
      <div className="modal-body own-posts-body">
        <p className="own-posts-intro">
          这里是汐岛记录为你自己的发言。通过汐岛发出并核对编号的发言，会同时记下实际使用的饼干；只有这样确认的主帖才会在你回自己的串时提示 PO 饼干。
        </p>

        <form className="own-posts-form" onSubmit={(event) => void add(event)} aria-labelledby={`${ids}-add`}>
          <h3 className="attempts-heading" id={`${ids}-add`}>
            手动补充旧发言
          </h3>
          <p className="own-posts-help" id={`${ids}-help`}>
            只记录你的声明（人工依据），不关联任何饼干，也不会从公开的饼干标识推测。因此这些发言的实际饼干保持未知，不会用于 PO 饼干提示。
          </p>
          <div className="own-posts-fields">
            <div className="editor-field">
              <label htmlFor={`${ids}-post`}>发言编号</label>
              <input
                id={`${ids}-post`}
                inputMode="numeric"
                autoComplete="off"
                placeholder="No."
                value={postInput}
                aria-describedby={`${ids}-help`}
                aria-invalid={postInput.trim() !== '' && postId === null ? true : undefined}
                onChange={(event) => {
                  setPostInput(event.target.value)
                  setMessage(null)
                }}
              />
            </div>
            <div className="editor-field">
              <label htmlFor={`${ids}-thread`}>所在串号</label>
              <input
                id={`${ids}-thread`}
                inputMode="numeric"
                autoComplete="off"
                placeholder="No."
                value={isThread ? (postId ?? postInput) : threadInput}
                disabled={isThread}
                aria-invalid={!isThread && threadInput.trim() !== '' && threadId === null ? true : undefined}
                onChange={(event) => {
                  setThreadInput(event.target.value)
                  setMessage(null)
                }}
              />
            </div>
          </div>
          <label className="own-posts-check">
            <input
              type="checkbox"
              checked={isThread}
              onChange={(event) => {
                setIsThread(event.target.checked)
                setMessage(null)
              }}
            />
            这是我开的串（主帖，串号即发言编号）
          </label>
          <div className="own-posts-submit">
            <button type="submit" className="btn btn-small" aria-busy={adding || undefined} aria-disabled={adding || undefined}>
              <Icon name="plus" size={14} />
              {adding ? '正在补充…' : '补充'}
            </button>
          </div>
          <p className="own-posts-message" role="status">
            {message !== null && (
              <span className={message.warning ? 'notice-inline is-warning' : 'notice-inline'}>
                <Icon name={message.warning ? 'alert' : 'check'} size={14} />
                {message.text}
              </span>
            )}
          </p>
        </form>

        <section aria-labelledby={`${ids}-list`}>
          <h3 className="attempts-heading" id={`${ids}-list`}>
            已记录{list.status === 'ready' ? `（${posts.length}）` : ''}
          </h3>
          {list.status === 'loading' && <Loading>正在读取我的发言…</Loading>}
          {list.status === 'failed' && (
            <div className="notice notice-error" role="alert">
              <Icon name="alert" className="notice-icon" />
              <div className="notice-text">
                <p className="notice-title">我的发言读取失败：本地存储不可用</p>
              </div>
              <button type="button" className="btn btn-small" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}
          {list.status === 'ready' && posts.length === 0 && <p className="attempts-empty-title">还没有记录。发言确认后会自动出现在这里。</p>}
          {posts.length > 0 && (
            <ul className="own-posts-list">
              {posts.map((post) => {
                const identity =
                  post.credentialId === null
                    ? { text: post.evidence === 'manual' ? '未知（手动补充不关联饼干）' : '未知', warning: false }
                    : credentialLine(post.credentialId, identities.overview)
                const rowId = `own-${post.postId}`
                return (
                  <li key={post.postId} className="own-post">
                    <div className="own-post-text">
                      <p className="own-post-title" id={rowId}>
                        No.{post.postId}
                        <span className="own-post-kind">{post.isThread ? '主帖（我开的串）' : `回复 · 串 No.${post.threadId}`}</span>
                      </p>
                      <p className="attempt-meta">
                        <span className={post.evidence === 'manual' ? 'own-post-evidence is-manual' : 'own-post-evidence'}>
                          {post.evidence === 'manual' ? '人工依据' : '发送后核对确认'}
                        </span>
                        <span className={identity.warning ? 'is-warning' : undefined}>饼干：{identity.text}</span>
                        <span>{formatLocalTime(post.confirmedAt)}</span>
                      </p>
                    </div>
                    <button type="button" className="btn btn-small" aria-describedby={rowId} onClick={() => onOpenThread(post.threadId)}>
                      <Icon name="arrowRight" size={14} />
                      打开串
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  )
}
