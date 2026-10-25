import { createContext, useContext } from 'react'
import type { Post, ReadingMode, ThreadId } from '../../../../shared/forum'

/**
 * Opens a thread as a page in a new active tab (split as the global “新标签默认开启分栏”), leaving
 * the current tab as it is. `head`, when the caller already has the main post, shows at once until
 * page 1 arrives. Without `fromStartIn` the thread opens by the usual resume rules (saved position);
 * with it, at the top of page 1 in that mode (a mode other than the saved preference shows only
 * temporarily). `null` outside the app shell: callers then offer no such action.
 */
export type ThreadTabOpener = (threadId: ThreadId, head?: Post | null, fromStartIn?: ReadingMode) => void

export const ThreadTabOpenerContext = createContext<ThreadTabOpener | null>(null)

export function useOpenThreadInTab(): ThreadTabOpener | null {
  return useContext(ThreadTabOpenerContext)
}
