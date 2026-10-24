import type { ContentFilters } from './search'

/** Recognized server calendar only; no timezone is inferred. */
export function serverCalendarDate(value: string | null): string | null {
  if (value === null) return null
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|[ T(])/.exec(value)
  if (!match) return null
  const date = match[1]!
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null
}

export function matchContentFilters(metadata: { forumId: string | null; createdAt: string | null; hasImage: boolean | null }, filters: ContentFilters): { matches: boolean; uncertain: boolean } {
  let uncertain = false
  if (filters.forumId !== null) {
    if (metadata.forumId === null) uncertain = true
    else if (metadata.forumId !== filters.forumId) return { matches: false, uncertain: false }
  }
  if (filters.fromDate !== null || filters.toDate !== null) {
    const date = serverCalendarDate(metadata.createdAt)
    if (date === null) uncertain = true
    else if ((filters.fromDate !== null && date < filters.fromDate) || (filters.toDate !== null && date > filters.toDate)) return { matches: false, uncertain: false }
  }
  if (filters.image !== 'any') {
    if (metadata.hasImage === null) uncertain = true
    else if (metadata.hasImage !== (filters.image === 'with')) return { matches: false, uncertain: false }
  }
  return { matches: true, uncertain }
}
