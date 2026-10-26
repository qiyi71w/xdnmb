import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../../shared/settings'
import type { AppearanceIssue } from '../../../shared/theme'

export interface SettingsWriteStatus {
  /** Local storage refused the last write; the shown settings are what is in effect. */
  notSaved: boolean
  /** The last write was refused as a whole; these are the reasons. */
  refused: AppearanceIssue[]
}

const NO_STATUS: SettingsWriteStatus = { notSaved: false, refused: [] }

/**
 * Writes settings through `settings.update`. A change is shown at once (the UI applies it), then
 * sent after `delay` ms; changes arriving before the send are coalesced into one update. Only the
 * reply to the latest update is applied, and only when nothing newer is waiting, so an older reply
 * never overwrites a newer state. The applied reply is what main has in effect.
 */
export function useSettingsWriter(settings: AppSettings, setSettings: (settings: AppSettings) => void) {
  const latest = useRef(settings)
  useLayoutEffect(() => {
    latest.current = settings
  })
  const pending = useRef<Partial<AppSettings> | null>(null)
  const timer = useRef<number | null>(null)
  const sequence = useRef(0)
  const [status, setStatus] = useState<SettingsWriteStatus>(NO_STATUS)

  const send = useCallback(() => {
    timer.current = null
    const patch = pending.current
    pending.current = null
    if (patch === null) return
    const id = ++sequence.current
    window.xidao.settings.update(patch).then(
      (result) => {
        if (id !== sequence.current || pending.current !== null) return
        latest.current = result.settings
        setSettings(result.settings)
        setStatus({ notSaved: !result.saved && result.issues.length === 0, refused: result.issues })
      },
      () => {
        if (id === sequence.current) setStatus({ notSaved: true, refused: [] })
      }
    )
  }, [setSettings])

  /** Shows `patch` now and sends it after `delay` ms (coalesced with other waiting changes). */
  const write = useCallback(
    (patch: Partial<AppSettings>, delay = 0) => {
      pending.current = { ...pending.current, ...patch }
      latest.current = { ...latest.current, ...patch }
      setSettings(latest.current)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(send, delay)
    },
    [send, setSettings]
  )

  /** Settings changed elsewhere in main (theme import): they win over waiting and in-flight writes. */
  const adopt = useCallback(
    (next: AppSettings) => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      pending.current = null
      sequence.current++
      latest.current = next
      setSettings(next)
      setStatus(NO_STATUS)
    },
    [setSettings]
  )

  const clearStatus = useCallback(() => setStatus(NO_STATUS), [])

  /** The settings including changes not yet sent or answered. */
  const current = useCallback(() => latest.current, [])

  return { status, write, adopt, clearStatus, latest: current }
}
