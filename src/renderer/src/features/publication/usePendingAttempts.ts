import { useEffect, useState } from 'react'
import { isPending } from '../../../../shared/publication'
import type { SentKind } from './sentRecords'

/** 待核对 attempts (sending, result unknown, number unconfirmed) by what they went to. */
export interface PendingAttempts {
  /** `null` until read or while unreadable. */
  counts: Readonly<Record<SentKind, number>> | null
  /** The local record could not be read. */
  failed: boolean
}

/** All 待核对 attempts, of both kinds; `null` while unknown. */
export function pendingTotal(pending: PendingAttempts): number | null {
  return pending.counts === null ? null : pending.counts.thread + pending.counts.reply
}

/** While something is still sending without an editor watching it, how often to read again. */
const POLL_MS = 2000

/**
 * 待核对 attempts for the 历史 badges (the rail's, and those of its 新串／回复 pages), read at start
 * (attempts left `unknown` by a restart show up here) and again whenever `revision` changes.
 * Reading is local and never sends.
 */
export function usePendingAttempts(revision: number): PendingAttempts {
  const [pending, setPending] = useState<PendingAttempts>({ counts: null, failed: false })
  const [sending, setSending] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    window.xidao.publication
      .listAttempts()
      .then((result) => {
        if (!alive) return
        if (!result.ok) {
          setPending({ counts: null, failed: true })
          return
        }
        const open = result.attempts.filter(isPending)
        const counts = { thread: 0, reply: 0 }
        for (const attempt of open) counts[attempt.payload.target.kind] += 1
        setPending({ counts, failed: false })
        setSending(open.some((attempt) => attempt.state === 'sending'))
      })
      .catch(() => {
        if (alive) setPending({ counts: null, failed: true })
      })
    return () => {
      alive = false
    }
  }, [revision, tick])

  useEffect(() => {
    if (!sending) return
    const timer = window.setTimeout(() => setTick((value) => value + 1), POLL_MS)
    return () => window.clearTimeout(timer)
  }, [sending, tick])

  return pending
}
