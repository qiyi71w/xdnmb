import { useContext, useEffect, useRef, useState } from 'react'
import { BottomNotice } from '../../components/BottomNotice'
import { SettingsContext } from '../../lib/settingsContext'
import { RATE_LIMIT_TEXT, rateLimitRetry } from './reminderText'
import { failureText, useRemindersContext, type LoadFailure } from './useReminders'

/**
 * The bottom notice of a reminder rate-limit episode: shown while the checker reports one the user
 * has not acknowledged, until 知道了 is saved or a wholly successful check ends the episode (the
 * overview then reports none). A moved retry time updates in place without a new announcement.
 * A failed acknowledgment keeps the notice, says why and leaves 知道了 to press again.
 */
export function RateLimitNotice({ fallbackFocus }: { fallbackFocus: () => HTMLElement | null }) {
  const { overview, reload } = useRemindersContext()
  const autoOff = useContext(SettingsContext)?.settings.reminderInterval === 0
  const rateLimit = overview?.checker.rateLimit ?? null
  const retryAt = overview?.checker.retryAt ?? null

  /** The episode whose acknowledgment was saved; hidden before the overview reports it dismissed. */
  const [acknowledged, setAcknowledged] = useState<string | null>(null)
  /** 知道了 of an episode: being saved, or why saving failed. */
  const [dismissal, setDismissal] = useState<{ id: string; pending: boolean; failure: LoadFailure | null } | null>(null)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const id = rateLimit?.id ?? null
  const current = dismissal !== null && dismissal.id === id ? dismissal : null
  const open = rateLimit !== null && !rateLimit.dismissed && rateLimit.id !== acknowledged

  const dismiss = async () => {
    if (id === null || current?.pending === true) return
    setDismissal({ id, pending: true, failure: null })
    let failure: LoadFailure | null = null
    try {
      const result = await window.xidao.reminders.dismissRateLimit({ id })
      if (!result.ok) failure = 'storage'
    } catch {
      failure = 'internal'
    }
    if (!alive.current) return
    if (failure === null) {
      setAcknowledged(id)
      setDismissal(null)
      void reload()
    } else {
      setDismissal({ id, pending: false, failure })
    }
  }

  const retry = rateLimitRetry(retryAt, autoOff)
  return (
    <BottomNotice
      open={open}
      detail={current?.failure != null ? `没有记下：${failureText(current.failure)}` : null}
      actions={[{ label: '知道了', busy: current?.pending === true, onAction: () => void dismiss() }]}
      fallbackFocus={fallbackFocus}
    >
      {RATE_LIMIT_TEXT}
      {retry !== null && (
        <>
          ，<span aria-live="off">{retry}</span>
        </>
      )}
    </BottomNotice>
  )
}
