import { useCallback, useEffect, useRef, useState } from 'react'
import type { IdentityOverview } from '../../../../shared/identity'

export interface IdentitiesState {
  /** Last overview received; kept while a refresh runs or fails. */
  overview: IdentityOverview | null
  /** The latest `getOverview()` call rejected. */
  failed: boolean
  /** Re-reads the overview; every consumer (navigation footer, settings) follows the result. */
  refresh: () => Promise<void>
}

/** Identity overview (names, sources, roles, protection) shared by the app shell. Never holds a secret. */
export function useIdentities(): IdentitiesState {
  const [overview, setOverview] = useState<IdentityOverview | null>(null)
  const [failed, setFailed] = useState(false)
  // Only the newest request may apply its result, so a slow earlier read never overwrites a newer one.
  const latest = useRef(0)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    const request = ++latest.current
    try {
      const next = await window.xidao.identities.getOverview()
      if (!alive.current || request !== latest.current) return
      setOverview(next)
      setFailed(false)
    } catch {
      if (!alive.current || request !== latest.current) return
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  return { overview, failed, refresh }
}
