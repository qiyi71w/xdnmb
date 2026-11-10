import { describe, expect, it } from 'vitest'
import type { AnalyticsState } from '../../src/shared/analytics'
import type { ThirdPartyChoices, ThirdPartyResult, ThirdPartyState } from '../../src/shared/third-party'
import {
  choiceFailureText,
  completeOutcome,
  disclosureReducer,
  disclosureSettled,
  granted,
  INITIAL_DISCLOSURE,
  NO_CHOICES,
  serviceAllowed,
  type DisclosureAction,
  type DisclosureState
} from '../../src/renderer/src/features/thirdParty/thirdPartyState'

function analytics(patch: Partial<AnalyticsState> = {}): AnalyticsState {
  return { availability: 'available', choice: 'unset', saved: 'unset', ...patch }
}

function state(patch: Partial<ThirdPartyState> = {}): ThirdPartyState {
  return { acknowledged: true, updates: false, search: false, analytics: analytics(), ...patch }
}

function run(actions: DisclosureAction[], from: DisclosureState = INITIAL_DISCLOSURE): DisclosureState {
  return actions.reduce(disclosureReducer, from)
}

const SOME: ThirdPartyChoices = { updates: true, search: false, analytics: false }

describe('first-run third-party disclosure', () => {
  it('holds later startup prompts until answered; a quit only takes it off screen', () => {
    expect(disclosureSettled(INITIAL_DISCLOSURE)).toBe(false)
    const waiting = run([{ type: 'read', state: state({ acknowledged: false }) }])
    expect(waiting).toEqual({ phase: 'waiting' })
    const shown = run([{ type: 'show' }], waiting)
    expect(disclosureSettled(shown)).toBe(false)
    const dropped = run([{ type: 'drop' }], shown)
    expect(dropped).toEqual({ phase: 'waiting' })
    const answered = run([{ type: 'show' }, { type: 'close' }], dropped)
    expect(disclosureSettled(answered)).toBe(true)
    expect(run([{ type: 'read', state: state({ acknowledged: false }) }, { type: 'show' }], answered)).toEqual({ phase: 'done' })
  })

  it('is shown whenever the disclosure was not answered, whatever statistics were before or can do', () => {
    const settledAfter = (value: ThirdPartyState | null) => disclosureSettled(run([{ type: 'read', state: value }]))
    expect(settledAfter(state())).toBe(true)
    // A legacy statistics choice is not an answer.
    expect(settledAfter(state({ acknowledged: false, analytics: analytics({ choice: 'unset', saved: 'unset' }) }))).toBe(false)
    expect(settledAfter(state({ acknowledged: false, analytics: analytics({ availability: 'not-configured' }) }))).toBe(false)
    expect(settledAfter(state({ acknowledged: false, analytics: analytics({ availability: 'unsupported-platform' }) }))).toBe(false)
    // Unreadable: nothing may be assumed answered.
    expect(settledAfter(null)).toBe(false)
  })

  it('closes only on a stored answer; a failed full rejection lets this run go on, a failed grant keeps it open', () => {
    expect(completeOutcome(SOME, { result: 'saved', state: state({ updates: true }) })).toEqual({ kind: 'close' })
    expect(completeOutcome(NO_CHOICES, { result: 'not-saved', state: state() }).kind).toBe('continue')
    expect(completeOutcome(NO_CHOICES, null).kind).toBe('continue')
    expect(completeOutcome(SOME, { result: 'not-saved', state: state({ acknowledged: false }) }).kind).toBe('retry')
    expect(completeOutcome(SOME, null).kind).toBe('retry')
    expect(
      completeOutcome({ ...NO_CHOICES, analytics: true }, { result: 'refused', reason: 'protection-unavailable', state: state({ acknowledged: false }) }).kind
    ).toBe('retry')
    // Already answered elsewhere: nothing left to ask.
    expect(completeOutcome(SOME, { result: 'refused', reason: 'unavailable', state: state() })).toEqual({ kind: 'close' })
  })
})

describe('one service later', () => {
  const saved = (patch: Partial<ThirdPartyState>): ThirdPartyResult => ({ result: 'saved', state: state(patch) })

  it('continues the asking action only once the grant is on and stored', () => {
    expect(granted('search', saved({ search: true }))).toBe(true)
    expect(granted('search', { result: 'not-saved', state: state() })).toBe(false)
    expect(granted('search', { result: 'refused', reason: 'disclosure-required', state: state({ acknowledged: false }) })).toBe(false)
    expect(granted('updates', null)).toBe(false)
    expect(granted('updates', saved({ search: true }))).toBe(false)
  })

  it('reports what did not stick, including a revoke that holds for this run only', () => {
    expect(choiceFailureText('search', true, saved({ search: true }))).toBeNull()
    expect(choiceFailureText('search', false, saved({}))).toBeNull()
    expect(choiceFailureText('search', true, { result: 'not-saved', state: state() })).not.toBeNull()
    expect(choiceFailureText('updates', false, { result: 'not-saved', state: state() })).not.toBeNull()
    expect(choiceFailureText('updates', false, null)).not.toBeNull()
    expect(choiceFailureText('analytics', true, { result: 'refused', reason: 'protection-unavailable', state: state() })).not.toBeNull()
  })

  it('reads statistics from the existing choice', () => {
    expect(serviceAllowed(state({ analytics: analytics({ choice: 'on', saved: 'on' }) }), 'analytics')).toBe(true)
    expect(serviceAllowed(state({ analytics: analytics({ choice: 'off' }) }), 'analytics')).toBe(false)
    expect(serviceAllowed(state({ updates: true }), 'updates')).toBe(true)
  })
})
