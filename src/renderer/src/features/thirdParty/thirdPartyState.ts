import type { ThirdPartyChoices, ThirdPartyResult, ThirdPartyService, ThirdPartyState } from '../../../../shared/third-party'

/** What users call each service, everywhere it is named. */
export const SERVICE_NAME: Record<ThirdPartyService, string> = {
  updates: '软件更新',
  search: '联网搜索',
  analytics: '使用统计'
}

/** Whether this run may use the service now. */
export function serviceAllowed(state: ThirdPartyState, service: ThirdPartyService): boolean {
  return service === 'analytics' ? state.analytics.choice === 'on' : state[service]
}

/** Statistics can be turned on only where they can run at all. */
export function analyticsAvailable(state: ThirdPartyState | null): boolean {
  return state !== null && state.analytics.availability === 'available'
}

// ---------- The first-run disclosure ----------

/**
 * This run's first-run disclosure. It is the first startup prompt: the automatic announcement waits
 * until it is settled, and nothing third-party runs before it is answered (main enforces that).
 * - `reading`: waiting for the state.
 * - `none`: answered already (on disk, or for this run after a failed full rejection).
 * - `waiting`: to be shown once the app may show it.
 * - `shown` / `done`: on screen / answered — never shown again this run. A quit only takes it off
 *   screen (`drop`): unanswered, it comes back if the quit is cancelled, and at the next start.
 * An unreadable state shows it too: nothing may be assumed answered.
 */
export type DisclosureState = { phase: 'reading' } | { phase: 'none' } | { phase: 'waiting' } | { phase: 'shown' } | { phase: 'done' }

export type DisclosureAction =
  | { type: 'read'; state: ThirdPartyState | null }
  | { type: 'show' }
  | { type: 'close' }
  | { type: 'drop' }

export const INITIAL_DISCLOSURE: DisclosureState = { phase: 'reading' }

export function needsDisclosure(state: ThirdPartyState | null): boolean {
  return state === null || !state.acknowledged
}

export function disclosureReducer(state: DisclosureState, action: DisclosureAction): DisclosureState {
  switch (action.type) {
    case 'read':
      if (state.phase !== 'reading') return state
      return needsDisclosure(action.state) ? { phase: 'waiting' } : { phase: 'none' }
    case 'show':
      return state.phase === 'waiting' ? { phase: 'shown' } : state
    case 'close':
      return state.phase === 'shown' ? { phase: 'done' } : state
    case 'drop':
      return state.phase === 'shown' ? { phase: 'waiting' } : state
  }
}

/** Later startup prompts (the announcement) may appear only after the disclosure is out of the way. */
export function disclosureSettled(state: DisclosureState): boolean {
  return state.phase === 'none' || state.phase === 'done'
}

export const NO_CHOICES: ThirdPartyChoices = { updates: false, search: false, analytics: false }

export function allOff(choices: ThirdPartyChoices): boolean {
  return !choices.updates && !choices.search && !choices.analytics
}

/**
 * What answering the disclosure came to. `close`: answered and stored. `continue`: answered for
 * this run only (every service stays off); the dialog says so and offers to go on. `retry`: not
 * answered, nothing turned on; the dialog stays. `null` result: the request itself failed.
 */
export type CompleteOutcome = { kind: 'close' } | { kind: 'continue'; text: string } | { kind: 'retry'; text: string }

const UNSAVED_ALL_OFF = '没能保存选择。本次运行不会使用任何第三方服务，下次启动会再问一次。'

export function completeOutcome(choices: ThirdPartyChoices, result: ThirdPartyResult | null): CompleteOutcome {
  if (result === null) {
    // Main never opened anything unanswered; going on with everything off is exactly that.
    return allOff(choices) ? { kind: 'continue', text: UNSAVED_ALL_OFF } : { kind: 'retry', text: '没能保存选择，没有开启任何服务。可以重试，或全部拒绝后继续。' }
  }
  if (result.result === 'saved') return { kind: 'close' }
  if (result.state.acknowledged) {
    // Answered elsewhere already (a repeated answer is refused), or a full rejection held for this run only.
    return result.result === 'refused' ? { kind: 'close' } : { kind: 'continue', text: UNSAVED_ALL_OFF }
  }
  if (result.result === 'refused' && result.reason === 'protection-unavailable') {
    return { kind: 'retry', text: '系统凭据保护不可用，无法开启使用统计。取消勾选使用统计后再保存。' }
  }
  return { kind: 'retry', text: '没能保存选择，没有开启任何服务。可以重试，或全部拒绝后继续。' }
}

// ---------- One service, later ----------

/**
 * Why changing one service did not end as asked, or `null` when it did. `null` result: the request
 * itself failed, so whether a revoke took effect is unknown until the state is read again.
 */
export function choiceFailureText(service: ThirdPartyService, allowed: boolean, result: ThirdPartyResult | null): string | null {
  const name = SERVICE_NAME[service]
  if (result === null) return allowed ? `没能开启${name}` : `没能确认${name}是否已关闭`
  const now = serviceAllowed(result.state, service)
  if (allowed) {
    if (now && result.result === 'saved') return null
    if (result.result === 'refused') {
      switch (result.reason) {
        case 'protection-unavailable':
          return '系统凭据保护不可用，无法安全保存统计凭证，使用统计保持关闭'
        case 'disclosure-required':
          return `${name}保持关闭：先在启动时的说明里作出选择`
        case 'unavailable':
          return `现在无法开启${name}`
      }
    }
    return `没能保存，${name}保持关闭`
  }
  if (!now && result.result === 'saved') return null
  if (!now) return `本次运行已关闭${name}，但没能保存，下次启动可能仍会开启`
  return `没能关闭${name}`
}

/** A grant for this one action: the service must be on for this run and stored. */
export function granted(service: ThirdPartyService, result: ThirdPartyResult | null): boolean {
  return result !== null && result.result === 'saved' && serviceAllowed(result.state, service)
}
