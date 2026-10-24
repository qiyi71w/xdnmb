import { useEffect, useState } from 'react'

/** Attempts still sending or waiting to be checked; `null` until read or while unreadable. */
export interface PendingAttempts {
  count: number | null
  /** The local record could not be read. */
  failed: boolean
}

/** While something is still sending without an editor watching it, how often to read again. */
const POLL_MS = 2000

/**
 * Unresolved attempts for the 发送记录 entry, read at start (attempts left `unknown` by a restart
 * show up here) and again whenever `revision` changes. Reading is local and never sends.
 */
export function usePendingAttempts(revision: number): PendingAttempts {
  const [pending, setPending] = useState<PendingAttempts>({ count: null, failed: false })
  const [sending, setSending] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    window.xidao.publication
      .listAttempts()
      .then((result) => {
        if (!alive) return
        if (!result.ok) {
          setPending({ count: null, failed: true })
          return
        }
        const open = result.attempts.filter(
          (attempt) => attempt.state === 'sending' || attempt.state === 'unknown' || attempt.state === 'unconfirmed'
        )
        setPending({ count: open.length, failed: false })
        setSending(open.some((attempt) => attempt.state === 'sending'))
      })
      .catch(() => {
        if (alive) setPending({ count: null, failed: true })
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
