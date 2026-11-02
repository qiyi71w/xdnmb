import { describe, expect, it } from 'vitest'
import type { Announcement, AnnouncementState } from '../../src/shared/announcements'
import {
  automaticReducer,
  INITIAL_AUTOMATIC,
  promptEligible,
  type AutomaticAction,
  type AutomaticState,
  type PromptConditions
} from '../../src/renderer/src/features/announcements/startupPrompt'

const announcement: Announcement = {
  date: '2026103101',
  content: '公告正文',
  enable: true,
  fetchedAt: '2026-10-31T01:00:00.000Z',
  nodes: [{ type: 'text', text: '公告正文' }]
}

function state(patch: Partial<AnnouncementState>): AnnouncementState {
  return { latest: announcement, source: 'current', outcome: 'ready', saved: true, storageAvailable: true, ...patch }
}

function run(actions: AutomaticAction[], from: AutomaticState = INITIAL_AUTOMATIC): AutomaticState {
  return actions.reduce(automaticReducer, from)
}

const open: PromptConditions = { restored: true, foreground: true, covered: false, typing: false, sending: false }

describe('startup prompt eligibility', () => {
  it('needs the restored, foreground, uncovered app with no typing or settling send', () => {
    expect(promptEligible(open)).toBe(true)
    const blocked: Partial<PromptConditions>[] = [
      { restored: false }, { foreground: false }, { covered: true }, { typing: true }, { sending: true }
    ]
    for (const patch of blocked) expect(promptEligible({ ...open, ...patch })).toBe(false)
  })
})

describe('automatic announcement', () => {
  it('never asks for a grant without a fresh enabled read of this run', () => {
    for (const read of [
      null,
      state({ source: 'cached', outcome: 'network-error' }),
      state({ source: 'cached', outcome: 'invalid' }),
      state({ outcome: 'disabled', latest: { ...announcement, enable: false } }),
      state({ latest: null, source: 'none', outcome: 'not-fetched' })
    ]) {
      expect(run([{ type: 'read', state: read }, { type: 'eligible' }, { type: 'take' }])).toEqual({ phase: 'none' })
    }
  })

  it('holds a grant that arrives after the moment passed and shows it once, then never again', () => {
    const held = run([{ type: 'read', state: state({}) }, { type: 'take' }, { type: 'taken', announcement }])
    expect(held).toEqual({ phase: 'held', announcement })
    // A quit closing dialogs before it was shown keeps it for a later eligible moment.
    expect(automaticReducer(held, { type: 'close' })).toBe(held)
    const shown = automaticReducer(held, { type: 'show' })
    expect(shown).toEqual({ phase: 'shown', announcement })
    const done = automaticReducer(shown, { type: 'close' })
    expect(run([{ type: 'eligible' }, { type: 'take' }, { type: 'taken', announcement }, { type: 'show' }], done)).toEqual({ phase: 'done' })
  })

  it('asks again only after a new eligible moment when nothing was granted', () => {
    const refused = run([{ type: 'read', state: state({}) }, { type: 'take' }, { type: 'taken', announcement: null }])
    expect(refused).toEqual({ phase: 'waiting', armed: false })
    expect(automaticReducer(refused, { type: 'take' })).toBe(refused)
    expect(run([{ type: 'eligible' }, { type: 'take' }], refused)).toEqual({ phase: 'taking' })
  })

  it('ignores an answer that arrives while not asking', () => {
    const held = run([{ type: 'read', state: state({}) }, { type: 'take' }, { type: 'taken', announcement }])
    expect(automaticReducer(held, { type: 'taken', announcement: null })).toBe(held)
  })
})

