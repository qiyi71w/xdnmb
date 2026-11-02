import type { AnalyticsState } from '../../../../shared/analytics'

/**
 * The first-run statistics question of this run. It is the first startup prompt: the automatic
 * announcement waits until it is `settled`.
 * - `reading`: waiting for the statistics state.
 * - `none`: nothing to ask (already answered, unavailable, or the state could not be read).
 * - `waiting`: to be asked once a startup prompt is eligible.
 * - `shown` / `done`: on screen / answered — never asked again this run. A quit only takes it off
 *   screen (`drop`): unanswered, it is asked again if the quit is cancelled, and at the next start.
 */
export type ChoicePromptState = { phase: 'reading' } | { phase: 'none' } | { phase: 'waiting' } | { phase: 'shown' } | { phase: 'done' }

export type ChoicePromptAction =
  | { type: 'read'; state: AnalyticsState | null }
  | { type: 'show' }
  | { type: 'close' }
  | { type: 'drop' }

export const INITIAL_CHOICE_PROMPT: ChoicePromptState = { phase: 'reading' }

/** Asked only while never answered, both for this run and on disk, and statistics can run here. */
export function needsChoice(state: AnalyticsState | null): boolean {
  return state !== null && state.availability === 'available' && state.choice === 'unset' && state.saved === 'unset'
}

export function choicePromptReducer(state: ChoicePromptState, action: ChoicePromptAction): ChoicePromptState {
  switch (action.type) {
    case 'read':
      if (state.phase !== 'reading') return state
      return needsChoice(action.state) ? { phase: 'waiting' } : { phase: 'none' }
    case 'show':
      return state.phase === 'waiting' ? { phase: 'shown' } : state
    case 'close':
      return state.phase === 'shown' ? { phase: 'done' } : state
    case 'drop':
      return state.phase === 'shown' ? { phase: 'waiting' } : state
  }
}

/** Later startup prompts (the announcement) may appear only after this one is out of the way. */
export function choiceSettled(state: ChoicePromptState): boolean {
  return state.phase === 'none' || state.phase === 'done'
}
