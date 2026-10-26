/**
 * Every time shown to the user goes through this module.
 *
 * Display form: `YYYY-MM-DD HH:MM:SS` in the computer's time zone, or just `HH:MM:SS` when it
 * falls on the same local calendar day as now. Forum text (`YYYY-MM-DD(星期)HH:MM:SS` in posts,
 * `YYYY-MM-DD HH:MM:SS` on account pages) is Beijing time (UTC+8) without a zone marker; local
 * records are ISO UTC. Anything unparsable (including date-only forum text) is shown as is.
 *
 * Display only: reminder boundaries, publication checks and search date filters keep using the
 * forum's server calendar and must not depend on this module.
 */

/** Test seams; production callers omit both (system time zone, current time). */
export interface TimeContext {
  /** IANA zone, e.g. `America/New_York`. */
  timeZone?: string
  now?: Date
}

interface Parts {
  day: string
  clock: string
}

const partsFormats = new Map<string, Intl.DateTimeFormat>()

function partsFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  let format = partsFormats.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    partsFormats.set(key, format)
  }
  return format
}

function partsOf(date: Date, timeZone: string | undefined): Parts {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const part of partsFormat(timeZone).formatToParts(date)) values[part.type] = part.value
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    clock: `${values.hour}:${values.minute}:${values.second}`
  }
}

function display(date: Date, context: TimeContext): string {
  const shown = partsOf(date, context.timeZone)
  const today = partsOf(context.now ?? new Date(), context.timeZone)
  return shown.day === today.day ? shown.clock : `${shown.day} ${shown.clock}`
}

const FORUM_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:\([^()]*\)| )(\d{2}):(\d{2}):(\d{2})$/
const FORUM_OFFSET_HOURS = 8

/** Forum `YYYY-MM-DD(星期)HH:MM:SS` or `YYYY-MM-DD HH:MM:SS` (UTC+8) in local time; the original text when unparsable. */
export function formatForumTime(text: string, context: TimeContext = {}): string {
  const match = FORUM_TIME.exec(text)
  if (match === null) return text
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day, hour - FORUM_OFFSET_HOURS, minute, second))
  // Reject impossible fields (2026-02-31, 25:00:00) instead of letting Date roll them over.
  const back = new Date(utc.getTime() + FORUM_OFFSET_HOURS * 3_600_000)
  const valid =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second
  return valid ? display(utc, context) : text
}

/** Local record (ISO timestamp) in local time; the original text when unparsable. */
export function formatRecordTime(iso: string, context: TimeContext = {}): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : display(date, context)
}

const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
const dayClockFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * `HH:MM` of an ISO timestamp, with the date in front when it is not today; raw text when unparsable.
 * Only for the reminder pane's last check and rate-limit retry times, which stay minute-precision.
 */
export function formatClockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toDateString() === new Date().toDateString() ? clockFormat.format(date) : dayClockFormat.format(date)
}
