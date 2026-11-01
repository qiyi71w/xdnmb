// Statistics days are Beijing calendar dates (UTC+8, no daylight saving).
// Days are `YYYY-MM-DD` strings, so lexical order equals calendar order.

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Linked daily records and identities cover today plus the previous 30 days. */
export const DETAIL_RETENTION_DAYS = 31
/** Active-instance window: today plus the previous 29 days. */
export const ACTIVE_WINDOW_DAYS = 30
/** Anonymous per-day summaries cover today back to the same date 12 months earlier. */
export const SUMMARY_RETENTION_MONTHS = 12

export function statDayAt(epochMs: number): string {
  return new Date(epochMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

export function addDays(day: string, days: number): string {
  return new Date(dayStart(day) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Calendar-month shift; the day of month is clamped to the target month's length. */
export function addMonths(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const index = year * 12 + (month - 1) + months
  const targetYear = Math.floor(index / 12)
  const targetMonth = index - targetYear * 12
  const lastDate = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(date, lastDate))).toISOString().slice(0, 10)
}

export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const start = dayStart(day)
  return Number.isFinite(start) && new Date(start).toISOString().slice(0, 10) === day
}

/** First day whose linked records and identities are still retained. */
export function detailCutoff(today: string): string {
  return addDays(today, -(DETAIL_RETENTION_DAYS - 1))
}

export function activeWindowStart(today: string): string {
  return addDays(today, -(ACTIVE_WINDOW_DAYS - 1))
}

/** First day whose anonymous summary is still retained. */
export function summaryCutoff(today: string): string {
  return addMonths(today, -SUMMARY_RETENTION_MONTHS)
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`)
}
