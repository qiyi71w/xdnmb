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

export interface SettingsWriter {
  /**
   * Shows `patch` now and sends it after `delay` ms (coalesced with other waiting changes); resolves
   * whether the update that carried it was saved.
   */
  write: (patch: Partial<AppSettings>, delay?: number) => Promise<boolean>
  /**
   * Sends `patch` now, together with any waiting changes, and resolves whether main saved it; the
   * waiting writes it carries resolve the same. The patch shows once main's reply is applied; a
   * refused or unsaved one never shows.
   */
  commit: (patch: Partial<AppSettings>) => Promise<boolean>
  /**
   * Settings changed elsewhere in main (theme import): they win over waiting and in-flight writes.
   * Waiting writes are dropped and resolve false.
   */
  adopt: (next: AppSettings) => void
}

/**
 * Writes settings through `settings.update`. A change is shown at once (the UI applies it), then
 * sent after `delay` ms; changes arriving before the send are coalesced into one update. Only the
 * reply to the latest update is applied, and only when nothing newer is waiting, so an older reply
 * never overwrites a newer state. The applied reply is what main has in effect. `commit` instead
 * sends at once and shows the change only when main has it, for changes that must not appear when
 * they are refused or not saved. A saved commit shows even when its reply is not the latest: the
 * settings it sent take main's values, except those changed again since, so whatever is built on
 * `latest` next (the theme list queue) includes it.
 *
 * Each write's promise tells whether the update that carried it was saved (false when refused,
 * failed or dropped); a write sent by `commit` is carried by the commit's update.
 *
 * `latest` holds the settings including changes not yet sent or answered; it is what `show` was
 * last given, and the caller keeps it in step with settings it shows otherwise.
 */
export function settingsWriter(
  latest: { current: AppSettings },
  show: (settings: AppSettings) => void,
  report: (status: SettingsWriteStatus) => void
): SettingsWriter {
  let pending: Partial<AppSettings> | null = null
  /** Writes in `pending`, told whether the update carrying them was saved. */
  let waiting: ((saved: boolean) => void)[] = []
  let timer: number | null = null
  let sequence = 0
  /** For each setting, the update that sends its latest change; none while that change waits. */
  const sentBy = new Map<keyof AppSettings, number>()

  const apply = (settings: AppSettings) => {
    latest.current = settings
    show(settings)
  }

  /** Takes the waiting writes: the next update sent carries them. */
  const takeWaiting = () => {
    const settle = waiting
    waiting = []
    return settle
  }

  const sendNow = (
    patch: Partial<AppSettings>,
    committed: boolean,
    settle: ((saved: boolean) => void)[]
  ): Promise<boolean> => {
    const id = ++sequence
    const keys = Object.keys(patch) as (keyof AppSettings)[]
    for (const key of keys) sentBy.set(key, id)
    return window.xidao.settings.update(patch).then(
      (result) => {
        for (const tell of settle) tell(result.saved)
        if (id === sequence && pending === null) {
          apply(result.settings)
          report({ notSaved: !result.saved && result.issues.length === 0, refused: result.issues })
        } else if (committed && result.saved) {
          // A newer update is waiting or unanswered: keep its changes, show what this one saved.
          const next = { ...latest.current }
          const take = <K extends keyof AppSettings>(key: K) => {
            if (sentBy.get(key) === id) next[key] = result.settings[key]
          }
          keys.forEach(take)
          apply(next)
        }
        return result.saved
      },
      () => {
        for (const tell of settle) tell(false)
        if (id === sequence) report({ notSaved: true, refused: [] })
        return false
      }
    )
  }

  const send = () => {
    timer = null
    const patch = pending
    pending = null
    if (patch !== null) void sendNow(patch, false, takeWaiting())
  }

  const stopTimer = () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
  }

  return {
    write: (patch, delay = 0) => {
      pending = { ...pending, ...patch }
      for (const key of Object.keys(patch) as (keyof AppSettings)[]) sentBy.delete(key)
      apply({ ...latest.current, ...patch })
      stopTimer()
      timer = window.setTimeout(send, delay)
      const { promise, resolve } = Promise.withResolvers<boolean>()
      waiting.push(resolve)
      return promise
    },
    commit: (patch) => {
      stopTimer()
      const sent = { ...pending, ...patch }
      pending = null
      return sendNow(sent, true, takeWaiting())
    },
    adopt: (next) => {
      stopTimer()
      pending = null
      for (const tell of takeWaiting()) tell(false)
      sequence++
      sentBy.clear()
      apply(next)
      report(NO_STATUS)
    }
  }
}

/** `settingsWriter` for the app's settings state, with the status of the last write. */
export function useSettingsWriter(settings: AppSettings, setSettings: (settings: AppSettings) => void) {
  const latest = useRef(settings)
  useLayoutEffect(() => {
    latest.current = settings
  })
  const [status, setStatus] = useState<SettingsWriteStatus>(NO_STATUS)
  const [{ write, commit, adopt }] = useState(() => settingsWriter(latest, setSettings, setStatus))

  const clearStatus = useCallback(() => setStatus(NO_STATUS), [])

  /** The settings including changes not yet sent or answered. */
  const current = useCallback(() => latest.current, [])

  return { status, write, commit, adopt, clearStatus, latest: current }
}
