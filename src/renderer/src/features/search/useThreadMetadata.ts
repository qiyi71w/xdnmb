import { useEffect, useMemo, useState } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import type { ThreadFilterMetadata } from '../../../../shared/search'

/** IDs per `threadMetadata` call (the API's bound). */
const CHUNK = 200

export type MetadataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; byId: ReadonlyMap<ThreadId, ThreadFilterMetadata> }
  /** Local metadata could not be read: every item counts as unknown. */
  | { status: 'failed' }

/**
 * Local filter metadata (main post fields) of the threads a list shows, read only while `enabled`.
 * Local only: no download, no reading-state write. Results for an older ID list are dropped.
 */
export function useThreadMetadata(threadIds: readonly ThreadId[], enabled: boolean): MetadataState {
  const key = useMemo(() => threadIds.join(','), [threadIds])
  const [state, setState] = useState<{ key: string; value: MetadataState }>({ key: '', value: { status: 'idle' } })

  useEffect(() => {
    if (!enabled || key === '') return
    let alive = true
    const ids = key.split(',')
    // Enabled again for the same list: what it showed stays until the new answer arrives.
    setState((previous) => (previous.key === key && previous.value.status === 'ready' ? previous : { key, value: { status: 'loading' } }))
    const run = async () => {
      const byId = new Map<ThreadId, ThreadFilterMetadata>()
      for (let start = 0; start < ids.length; start += CHUNK) {
        const result = await window.xidao.search.threadMetadata({ threadIds: ids.slice(start, start + CHUNK) })
        if (!alive) return
        if (!result.ok) {
          setState({ key, value: { status: 'failed' } })
          return
        }
        for (const item of result.value) byId.set(item.threadId, item)
      }
      setState({ key, value: { status: 'ready', byId } })
    }
    run().catch(() => {
      if (alive) setState({ key, value: { status: 'failed' } })
    })
    return () => {
      alive = false
    }
  }, [key, enabled])

  if (!enabled || key === '') return { status: 'idle' }
  return state.key === key ? state.value : { status: 'loading' }
}
