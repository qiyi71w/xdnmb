import type { ThreadId } from '../../shared/forum'
import type { ThreadReadingState } from '../../shared/reading'
import { computeCoverage } from './coverage'

/** Reading state when storage is unavailable: nothing saved, nothing observed. */
export function emptyReadingState(threadId: ThreadId): ThreadReadingState {
  return {
    threadId,
    mode: 'all',
    positions: { all: null, po: null },
    coverage: { all: computeCoverage(threadId, 'all', [], null), po: computeCoverage(threadId, 'po', [], null) }
  }
}
