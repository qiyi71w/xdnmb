import { createContext, useContext } from 'react'
import type { ForumId, ReadingMode, ThreadId } from '../../../../shared/forum'
import type { SearchState } from './searchState'
import type { SearchCommands } from './useSearch'

/** What a 搜索 entry point asks the shell for. */
export type SearchRequest =
  | { view: 'local' }
  /** The thread the reader of history entry `entryKey` shows, searched in `mode` first. */
  | { view: 'thread'; entryKey: number; threadId: ThreadId; mode: ReadingMode; title: string | null }

/** Opens the search sheet of the tab the request comes from (the active tab). Null outside the shell. */
export const SearchOpenerContext = createContext<((request: SearchRequest) => void) | null>(null)

export function useSearchOpener(): ((request: SearchRequest) => void) | null {
  return useContext(SearchOpenerContext)
}

/** PROTOTYPE: the app's local search, for the 本机 side of 搜索 pages. Null outside the prototype. */
export interface LocalSearchHost {
  state: SearchState
  commands: SearchCommands
  forums: ReadonlyMap<ForumId, string>
}

export const LocalSearchContext = createContext<LocalSearchHost | null>(null)
