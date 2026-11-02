// An announcement's text: the safe content tree the main process parsed, drawn by the shared
// `Content` renderer. Links open the system browser through its usual check. A >>No. reference
// is a plain button: showing, hovering or focusing it reads nothing; only a press locates the post
// and opens its thread in a new tab, like 在新标签页打开 elsewhere.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { LocateHint } from '../../../../shared/api'
import type { ContentNode, PostId } from '../../../../shared/forum'
import { Content, type RenderQuote } from '../../components/Content'
import { Icon } from '../../components/Icon'
import { describeReadError } from '../../lib/format'
import type { ThreadOpen } from '../tabs/tabsState'

/** Opens a thread in a new active tab (global split default). `null` outside the app shell. */
export const AnnouncementNavigationContext = createContext<((thread: ThreadOpen) => void) | null>(null)

/**
 * One locate at a time; presses while it runs are ignored. `onOpening` runs right before the thread
 * opens (the dialog closes first, so the new tab is not covered). Leaving — unmounting, or no longer
 * being displayed (设置 hidden behind another tab) — cancels a running locate; its late result is
 * dropped without opening a tab or moving focus, and the reference can be pressed again later.
 */
function useQuoteOpening(onOpening: (() => void) | undefined, displayed: boolean) {
  const openThread = useContext(AnnouncementNavigationContext)
  const [locating, setLocating] = useState<PostId | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const operation = useRef<string | null>(null)
  const opening = useRef(onOpening)
  useEffect(() => {
    opening.current = onOpening
  })

  /** Drops the running locate: `settle` ignores whatever it still reports. */
  const cancel = useCallback(() => {
    const running = operation.current
    operation.current = null
    if (running !== null) void window.xidao.reading.cancel({ operationId: running }).catch(() => undefined)
  }, [])
  useEffect(() => cancel, [cancel])
  useEffect(() => {
    if (displayed) return
    cancel()
    setLocating(null)
    setProblem(null)
  }, [displayed, cancel])

  /** `hint`: the reference's verified forum link clue, tried only when local records do not place the post. */
  const open = useCallback(
    (postId: PostId, hint: LocateHint | undefined) => {
      if (openThread === null || operation.current !== null) return
      const operationId = `announcement-locate-${crypto.randomUUID()}`
      operation.current = operationId
      setLocating(postId)
      setProblem(null)
      const settle = (thread: ThreadOpen | null, failure: string | null) => {
        if (operation.current !== operationId) return
        operation.current = null
        setLocating(null)
        setProblem(failure)
        if (thread === null) return
        opening.current?.()
        openThread(thread)
      }
      window.xidao.quotes.locate({ operationId, postId, ...(hint === undefined ? {} : { hint }) }).then(
        (result) => {
          switch (result.status) {
            case 'cancelled':
              settle(null, null)
              return
            case 'located': {
              const target = { postId: result.target.postId, page: result.target.page, mode: result.target.mode }
              settle({ threadId: result.threadId, head: result.head, target, snapshot: null, unlocatedPostId: null }, null)
              return
            }
            // Its thread is known but the post was not placed: the thread opens and says so.
            case 'thread-known':
              settle({ threadId: result.threadId, head: result.head, target: null, snapshot: null, unlocatedPostId: postId }, null)
              return
            case 'unknown-thread':
              settle(null, `无法确认 No.${postId} 所属的串`)
              return
            case 'failed':
              if (result.threadId !== null) settle({ threadId: result.threadId, head: null, target: null, snapshot: null, unlocatedPostId: postId }, null)
              else settle(null, `没能打开 No.${postId}：${describeReadError(result.error)}`)
          }
        },
        () => settle(null, `没能打开 No.${postId}：应用内部请求失败`)
      )
    },
    [openThread]
  )

  const renderQuote = useCallback<RenderQuote>(
    (node) => {
      if (openThread === null) return <span className="quote-ref">{node.raw}</span>
      const busy = locating === node.postId
      return (
        <button
          type="button"
          className="quote-ref is-interactive"
          title={`在新标签页打开 No.${node.postId}`}
          aria-busy={busy || undefined}
          aria-disabled={locating !== null || undefined}
          onClick={() => open(node.postId, node.hint)}
        >
          {node.raw}
        </button>
      )
    },
    [openThread, locating, open]
  )

  return { renderQuote, locating, problem }
}

/**
 * The announcement text with its quote status line. `onOpening`: the dialog showing it closes
 * before an opened thread's tab is shown. `displayed`: false while its page is hidden (设置 behind
 * another tab); a running quote lookup is then cancelled.
 */
export function AnnouncementBody({
  nodes,
  className,
  onOpening,
  displayed = true,
  labelledBy
}: {
  nodes: readonly ContentNode[]
  className?: string
  onOpening?: () => void
  displayed?: boolean
  /** Names the scrolling text region (keyboard users scroll it after Tab reaches it). */
  labelledBy: string
}) {
  const { renderQuote, locating, problem } = useQuoteOpening(onOpening, displayed)
  return (
    <>
      <div
        className={className === undefined ? 'announcement-text' : `announcement-text ${className}`}
        role="region"
        aria-labelledby={labelledBy}
        tabIndex={0}
      >
        <Content nodes={nodes} renderQuote={renderQuote} />
      </div>
      <div className="announcement-quote-status" role="status">
        {locating !== null && <p className="announcement-quote-line">正在查找 No.{locating}…</p>}
        {problem !== null && (
          <p className="notice-inline is-warning announcement-quote-line">
            <Icon name="alert" size={14} />
            <span>{problem}</span>
          </p>
        )}
      </div>
    </>
  )
}
