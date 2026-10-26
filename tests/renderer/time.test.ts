import { describe, expect, it } from 'vitest'
import { formatForumTime, formatRecordTime } from '../../src/renderer/src/lib/time'

const NEW_YORK = 'America/New_York' // UTC-4 on 2026-10-26 (EDT)
const SHANGHAI = 'Asia/Shanghai'

describe('formatForumTime', () => {
  it('reads forum text as UTC+8 and shows it in the local zone', () => {
    // 13:12 Beijing = 05:12 UTC = 01:12 New York, same day.
    const now = new Date('2026-10-26T10:00:00Z') // 06:00 New York, 18:00 Shanghai: the 26th in both
    expect(formatForumTime('2026-10-26(一)13:12:00', { timeZone: NEW_YORK, now })).toBe('01:12:00')
    expect(formatForumTime('2026-10-26(一)13:12:00', { timeZone: SHANGHAI, now })).toBe('13:12:00')
  })

  it('moves across midnight into the previous local day and shows the date', () => {
    // 07:30 Beijing on the 26th = 19:30 New York on the 25th.
    const now = new Date('2026-10-26T18:00:00Z')
    expect(formatForumTime('2026-10-26(一)07:30:05', { timeZone: NEW_YORK, now })).toBe('2026-10-25 19:30:05')
  })

  it('decides "today" by the local calendar, not the forum calendar', () => {
    const text = '2026-10-26(一)23:59:59' // 2026-10-26T15:59:59Z
    // Shanghai: just before local midnight it is the same day; one second later it is not.
    expect(formatForumTime(text, { timeZone: SHANGHAI, now: new Date('2026-10-26T15:59:59Z') })).toBe('23:59:59')
    expect(formatForumTime(text, { timeZone: SHANGHAI, now: new Date('2026-10-26T16:00:00Z') })).toBe('2026-10-26 23:59:59')
    // New York: the same instant is 11:59:59 on the 26th, so "today" there even after Beijing's midnight.
    expect(formatForumTime(text, { timeZone: NEW_YORK, now: new Date('2026-10-26T16:00:00Z') })).toBe('11:59:59')
  })

  it('accepts the account page form without a weekday', () => {
    const now = new Date('2027-01-01T00:00:00Z')
    expect(formatForumTime('2026-01-01 12:00:00', { timeZone: NEW_YORK, now })).toBe('2025-12-31 23:00:00')
  })

  it('shows unparsable text as is', () => {
    const context = { timeZone: NEW_YORK, now: new Date('2026-10-26T18:00:00Z') }
    for (const text of ['昨天 13:12', '2026-10-26', '2026-02-31(二)10:00:00', '2026-10-26(一)24:00:00', '2026-10-26T05:12:00Z', '']) {
      expect(formatForumTime(text, context)).toBe(text)
    }
  })
})

describe('formatRecordTime', () => {
  it('shows ISO records in the local zone with the same today rule', () => {
    const now = new Date('2026-10-26T18:00:00Z')
    expect(formatRecordTime('2026-10-26T05:12:00.000Z', { timeZone: NEW_YORK, now })).toBe('01:12:00')
    expect(formatRecordTime('2026-10-26T03:00:00.000Z', { timeZone: NEW_YORK, now })).toBe('2026-10-25 23:00:00')
    expect(formatRecordTime('2026-10-26T03:00:00.000Z', { timeZone: SHANGHAI, now })).toBe('2026-10-26 11:00:00')
  })

  it('agrees with the forum formatter for the same instant', () => {
    const context = { timeZone: NEW_YORK, now: new Date('2026-11-01T00:00:00Z') }
    expect(formatRecordTime('2026-10-26T05:12:00Z', context)).toBe(formatForumTime('2026-10-26(一)13:12:00', context))
  })

  it('shows unparsable text as is', () => {
    expect(formatRecordTime('not a time', { timeZone: NEW_YORK })).toBe('not a time')
  })
})
