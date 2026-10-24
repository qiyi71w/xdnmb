import { useEffect, useId, useState } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { enabledKinds, KIND_NAME } from './reminderText'
import { failureText, loadRules, ReminderStorageError, type LoadFailure } from './useReminders'
import './reminders.css'

export type ReminderChoice = 'keep' | 'close'

/**
 * The local half of an in-app unsubscribe or a confirmed sync deletion: what the user chose for the
 * reminders of the affected threads, and what happened locally. Reported apart from the remote result.
 */
export interface ReminderLinkage {
  threadIds: ThreadId[]
  choice: ReminderChoice
  /**
   * `null` for 保留; for 关闭 `pending` until the local close settled. `failed` keeps the threads
   * that were closed by the batches that succeeded and how many threads were in failed batches.
   */
  result:
    | { status: 'pending' }
    | { status: 'closed'; closed: ThreadId[] }
    | { status: 'failed'; failure: LoadFailure; closed: ThreadId[]; failedCount: number }
    | null
}

/** Most thread IDs one `closeForThreads` call accepts. */
const MAX_CLOSE_THREADS = 500

/**
 * Applies the choice locally, before any remote write: every batch of at most 500 threads in turn,
 * all settled before this returns. A failed batch does not stop the others. 保留 changes nothing.
 */
export async function applyReminderChoice(
  linkage: ReminderLinkage,
  reason: 'unsubscribe' | 'sync-delete'
): Promise<ReminderLinkage> {
  if (linkage.choice === 'keep') return linkage
  const closed: ThreadId[] = []
  let failure: LoadFailure | null = null
  let failedCount = 0
  for (let at = 0; at < linkage.threadIds.length; at += MAX_CLOSE_THREADS) {
    const threadIds = linkage.threadIds.slice(at, at + MAX_CLOSE_THREADS)
    try {
      const result = await window.xidao.reminders.closeForThreads({ threadIds, reason })
      if (result.ok) {
        closed.push(...result.closed)
        continue
      }
      failure ??= 'storage'
    } catch {
      failure ??= 'internal'
    }
    failedCount += threadIds.length
  }
  return { ...linkage, result: failure === null ? { status: 'closed', closed } : { status: 'failed', failure, closed, failedCount } }
}

/** One statement on the local reminders, separate from the remote outcome. */
export function linkageText(linkage: ReminderLinkage): { text: string; warn: boolean } {
  const many = linkage.threadIds.length > 1
  const scope = many ? `${linkage.threadIds.length} 个串的` : '本串'
  if (linkage.choice === 'keep') return { text: `本地提醒：已保留，${scope}提醒规则不变`, warn: false }
  const result = linkage.result
  if (result === null || result.status === 'pending') return { text: '本地提醒：正在关闭…', warn: false }
  if (result.status === 'failed') {
    const partial = result.failedCount < linkage.threadIds.length
    return {
      text: partial
        ? `本地提醒：部分关闭失败（${failureText(result.failure)}）：已关闭 ${result.closed.length} 个串，另有 ${result.failedCount} 个串的提醒可能仍按原规则开启，可以在“提醒”列表里手动关闭`
        : `本地提醒：关闭失败（${failureText(result.failure)}），${scope}提醒仍按原规则开启，可以在“提醒”列表里手动关闭`,
      warn: true
    }
  }
  const rest = linkage.threadIds.length - result.closed.length
  const closed = many ? `已关闭 ${result.closed.length} 个串的提醒` : '已关闭'
  return { text: `本地提醒：${closed}${rest > 0 ? `；其余 ${rest} 个串当时已没有开启的提醒` : ''}`, warn: false }
}

/** Which of the threads have an enabled reminder; `unknown` when the rules could not be read. */
export type ReminderAsk =
  | { status: 'loading' }
  | { status: 'ready'; enabled: { threadId: ThreadId; kinds: string[] }[] }
  | { status: 'unknown'; failure: LoadFailure }

/** Reads the rules of the threads about to be removed, once per distinct set. */
export function useReminderAsk(threadIds: readonly ThreadId[] | null): ReminderAsk | null {
  const key = threadIds === null ? null : [...new Set(threadIds)].join(',')
  const [state, setState] = useState<{ key: string; ask: ReminderAsk } | null>(null)
  useEffect(() => {
    if (key === null) return
    let alive = true
    const ids = key === '' ? [] : key.split(',')
    setState({ key, ask: { status: 'loading' } })
    loadRules(ids).then(
      (rules) => {
        if (!alive) return
        const enabled = ids.flatMap((threadId) => {
          const thread = rules.get(threadId)
          const kinds = thread === undefined ? [] : enabledKinds(thread.rules)
          return kinds.length === 0 ? [] : [{ threadId, kinds: kinds.map((kind) => KIND_NAME[kind]) }]
        })
        setState({ key, ask: { status: 'ready', enabled } })
      },
      (error: unknown) => {
        if (alive) setState({ key, ask: { status: 'unknown', failure: error instanceof ReminderStorageError ? 'storage' : 'internal' } })
      }
    )
    return () => {
      alive = false
    }
  }, [key])
  if (key === null) return null
  return state?.key === key ? state.ask : { status: 'loading' }
}

/** Threads the choice applies to: those with enabled reminders, or all when that is unknown. */
export function askedThreads(ask: ReminderAsk | null, all: readonly ThreadId[]): ThreadId[] | null {
  if (ask === null || ask.status === 'loading') return null
  if (ask.status === 'unknown') return [...new Set(all)]
  return ask.enabled.map((item) => item.threadId)
}

/**
 * Required 保留 / 关闭 choice inside an unsubscribe or sync-delete confirmation. Renders a short
 * line while the rules are being read, nothing when no affected thread has reminders.
 */
export function ReminderChoiceField({
  ask,
  all,
  choice,
  onChoice,
  labelOf,
  single
}: {
  ask: ReminderAsk | null
  all: readonly ThreadId[]
  choice: ReminderChoice
  onChoice: (choice: ReminderChoice) => void
  labelOf: (threadId: ThreadId) => string
  /** One thread (single unsubscribe): wording says 本串. */
  single: boolean
}) {
  const name = useId()
  const legendId = useId()
  if (ask === null) return null
  if (ask.status === 'loading') {
    return <p className="reminder-choice-note">正在读取{single ? '本串' : '相关串'}的提醒状态…</p>
  }
  if (ask.status === 'ready' && ask.enabled.length === 0) return null
  const threads = askedThreads(ask, all) ?? []
  const subject = single ? '本串' : '这些串'
  return (
    <fieldset className="reminder-choice">
      <legend className="reminder-choice-legend" id={legendId}>
        {ask.status === 'unknown'
          ? `提醒状态读取失败（${failureText(ask.failure)}），${subject}可能开启了提醒：`
          : single
            ? `本串开启了提醒（${ask.enabled[0]?.kinds.join('、') ?? ''}）：`
            : `下列 ${threads.length} 个串开启了提醒：`}
      </legend>
      {!single && (
        <ul className="reminder-choice-list" aria-labelledby={legendId}>
          {ask.status === 'ready'
            ? ask.enabled.map((item) => (
                <li key={item.threadId}>
                  {labelOf(item.threadId)}
                  <span className="reminder-choice-kinds">{item.kinds.join('、')}</span>
                </li>
              ))
            : threads.map((threadId) => <li key={threadId}>{labelOf(threadId)}</li>)}
        </ul>
      )}
      <label className="reminder-choice-row">
        <input type="radio" name={name} checked={choice === 'keep'} onChange={() => onChoice('keep')} />
        <span>
          <span className="reminder-choice-title">保留{single ? '本串' : ''}提醒</span>
          <span className="reminder-choice-help">提醒规则和起点不变，之后仍会检查。</span>
        </span>
      </label>
      <label className="reminder-choice-row">
        <input type="radio" name={name} checked={choice === 'close'} onChange={() => onChoice('close')} />
        <span>
          <span className="reminder-choice-title">关闭{single ? '本串' : '这些串的'}提醒</span>
          <span className="reminder-choice-help">先在本机关闭，再发出远端请求；远端失败或结果未知时，本机关闭也照样生效并分开说明。</span>
        </span>
      </label>
    </fieldset>
  )
}

/** Separate line for the local reminder result, next to a remote outcome. */
export function LinkageLine({ linkage, className }: { linkage: ReminderLinkage; className: string }) {
  const { text, warn } = linkageText(linkage)
  return (
    <p className={warn ? `${className} reminder-linkage is-warning` : `${className} reminder-linkage`}>
      <Icon name={warn ? 'alert' : 'bell'} size={13} />
      <span>{text}</span>
    </p>
  )
}
