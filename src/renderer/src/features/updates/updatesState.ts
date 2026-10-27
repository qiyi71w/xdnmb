import { createContext, useContext, useEffect, useState } from 'react'
import type { UpdateState } from '../../../../shared/updates'

/** The update state as the renderer knows it: `null` until read, `failed` when it could not be read. */
export interface UpdatesView {
  state: UpdateState | null
  failed: boolean
}

const UNREAD: UpdatesView = { state: null, failed: false }

/** The app's one update subscription (App); everything else reads it through `useUpdates`. */
export const UpdatesContext = createContext<UpdatesView>(UNREAD)

export function useUpdates(): UpdatesView {
  return useContext(UpdatesContext)
}

/**
 * Reads the state once and follows every pushed change. A push that arrives before the first read
 * resolves is newer than it, so the read is then dropped.
 */
export function useUpdatesSource(): UpdatesView {
  const [view, setView] = useState<UpdatesView>(UNREAD)
  useEffect(() => {
    let alive = true
    let pushed = false
    const off = window.xidao.updates.onState((state) => {
      pushed = true
      if (alive) setView({ state, failed: false })
    })
    window.xidao.updates
      .getState()
      .then((state) => {
        if (alive && !pushed) setView({ state, failed: false })
      })
      .catch(() => {
        if (alive && !pushed) setView({ state: null, failed: true })
      })
    return () => {
      alive = false
      off()
    }
  }, [])
  return view
}

/** A newer release is known and this build can update: the settings buttons carry a dot. */
export function hasNewVersion(state: UpdateState | null): boolean {
  return state !== null && state.unavailable === null && state.release !== null
}

/** Accessible name (and tooltip) of the settings buttons; the dot itself is hidden from assistive technology. */
export function settingsEntryLabel(state: UpdateState | null): string {
  return hasNewVersion(state) ? '设置，有新版本' : '设置'
}
