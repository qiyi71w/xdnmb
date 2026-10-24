import type { SearchBatch, SearchScope, ContentFilters, ThreadFilterMetadata } from '../../shared/search'

export interface SearchScan {
  query: string
  scope: SearchScope
  filters: ContentFilters
  after: number
  upper: number
}
export interface SearchStore {
  searchBoundary(): Promise<number>
  searchBatch(input: SearchScan): Promise<{ batch: SearchBatch; cursor: number }>
  beginSearchRebuild(): Promise<void>
  rebuildSearchBatch(): Promise<boolean>
  searchMetadata(threadIds: string[]): Promise<ThreadFilterMetadata[]>
}
