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
 * never overwrites a newer state. The applied reply is what main has in effect. `commit` instead
 * sends at once and shows the change only when main has it, for changes that must not appear when
 * they are refused or not saved.
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

  const sendNow = useCallback(
    (patch: Partial<AppSettings>): Promise<boolean> => {
      const id = ++sequence.current
      return window.xidao.settings.update(patch).then(
        (result) => {
          if (id === sequence.current && pending.current === null) {
            latest.current = result.settings
            setSettings(result.settings)
            setStatus({ notSaved: !result.saved && result.issues.length === 0, refused: result.issues })
          }
          return result.saved
        },
        () => {
          if (id === sequence.current) setStatus({ notSaved: true, refused: [] })
          return false
        }
      )
    },
    [setSettings]
  )

  const send = useCallback(() => {
    timer.current = null
    const patch = pending.current
    pending.current = null
    if (patch !== null) void sendNow(patch)
  }, [sendNow])

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

  /**
   * Sends `patch` now, together with any waiting changes, and resolves whether main saved it. The
   * patch shows once main's reply is applied; a refused or unsaved one never shows.
   */
  const commit = useCallback(
    (patch: Partial<AppSettings>): Promise<boolean> => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      const sent = { ...pending.current, ...patch }
      pending.current = null
      return sendNow(sent)
    },
    [sendNow]
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

  return { status, write, commit, adopt, clearStatus, latest: current }
}
