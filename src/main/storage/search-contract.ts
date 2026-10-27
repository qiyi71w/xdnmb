import type { SearchBatch, SearchScope, SearchFilters, ThreadFilterMetadata } from '../../shared/search'

export interface SearchScan {
  query: string
  scope: SearchScope
  filters: SearchFilters
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
