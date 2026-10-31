import { describe, expect, it } from 'vitest'
import type { AnalyticsState } from '../../src/shared/analytics'
import {
  choicePromptReducer,
  choiceSettled,
  INITIAL_CHOICE_PROMPT,
  type ChoicePromptAction,
  type ChoicePromptState
} from '../../src/renderer/src/features/analytics/choicePrompt'

function state(patch: Partial<AnalyticsState>): AnalyticsState {
  return { availability: 'available', choice: 'unset', saved: 'unset', hasIdentity: false, deletionPending: false, receiver: 'stats.example', ...patch }
}

function run(actions: ChoicePromptAction[], from: ChoicePromptState = INITIAL_CHOICE_PROMPT): ChoicePromptState {
  return actions.reduce(choicePromptReducer, from)
}

describe('first-run statistics question', () => {
  it('holds later startup prompts until it is answered; a quit only takes it off screen', () => {
    expect(choiceSettled(INITIAL_CHOICE_PROMPT)).toBe(false)
    const waiting = run([{ type: 'read', state: state({}) }])
    expect(waiting).toEqual({ phase: 'waiting' })
    expect(choiceSettled(waiting)).toBe(false)
    const shown = run([{ type: 'show' }], waiting)
    expect(choiceSettled(shown)).toBe(false)
    const dropped = run([{ type: 'drop' }], shown)
    expect(dropped).toEqual({ phase: 'waiting' })
    expect(choiceSettled(dropped)).toBe(false)
    const answered = run([{ type: 'show' }, { type: 'close' }], dropped)
    expect(choiceSettled(answered)).toBe(true)
    // Answered once, never shown again this run.
    expect(run([{ type: 'read', state: state({}) }, { type: 'show' }], answered)).toEqual({ phase: 'done' })
  })

  it('asks only while unanswered on disk and for this run, and only where statistics can run; an unreadable state asks nothing', () => {
    const settledAfter = (value: AnalyticsState | null) => choiceSettled(run([{ type: 'read', state: value }]))
    expect(settledAfter(state({ saved: 'off', choice: 'off' }))).toBe(true)
    expect(settledAfter(state({ saved: 'on', choice: 'on' }))).toBe(true)
    // A failed save of 关闭 earlier this run: not asked again.
    expect(settledAfter(state({ saved: 'unset', choice: 'off' }))).toBe(true)
    expect(settledAfter(state({ availability: 'not-configured' }))).toBe(true)
    expect(settledAfter(state({ availability: 'unsupported-platform' }))).toBe(true)
    expect(settledAfter(state({ availability: 'storage-unavailable' }))).toBe(true)
    expect(settledAfter(null)).toBe(true)
    expect(settledAfter(state({}))).toBe(false)
  })
})
