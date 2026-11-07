// The first-run disclosure of third-party services: the first startup prompt, shown once until
// answered (also to users of earlier versions, whatever they chose for statistics before). Three
// independent switches start off and only change this dialog's choices; nothing takes effect
// until 保存选择. It cannot be dismissed: Esc, the backdrop and a forced close answer nothing;
// only 全部拒绝 or 保存选择 do. A save that fails turns nothing on; a full rejection that could
// not be stored still lets this run go on with everything off.

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ThirdPartyChoices, ThirdPartyResult, ThirdPartyService, ThirdPartyState } from '../../../../shared/third-party'
import { Switch } from '../../app/settingsSections'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Modal } from '../../components/Modal'
import { unavailableText } from '../analytics/analyticsText'
import { ServiceFacts, SERVICE_PURPOSE, THIRD_PARTY_WARNING } from './ServiceFacts'
import { analyticsAvailable, completeOutcome, NO_CHOICES, SERVICE_NAME, type CompleteOutcome } from './thirdPartyState'
import './third-party.css'

const ORDER: readonly ThirdPartyService[] = ['updates', 'search', 'analytics']

/**
 * `initial`: the state read at startup (null when unreadable). `onAnswered`: answered, with the
 * state main returned (null when the request failed and this run goes on with everything off).
 */
export function ThirdPartyDisclosureDialog({
  initial,
  onAnswered,
  fallbackFocus
}: {
  initial: ThirdPartyState | null
  onAnswered: (state: ThirdPartyState | null) => void
  fallbackFocus: () => HTMLElement | null
}) {
  // A platform-forced close (repeated Esc) cannot answer: the dialog opens again at once.
  const [opening, setOpening] = useState(0)
  const reopen = useCallback(() => {
    requestAnimationFrame(() => {
      if (document.querySelector('dialog.third-party-dialog[open]') === null) setOpening((count) => count + 1)
    })
  }, [])
  return <DisclosureBody key={opening} initial={initial} onAnswered={onAnswered} onForcedClose={reopen} fallbackFocus={fallbackFocus} />
}

function DisclosureBody({
  initial,
  onAnswered,
  onForcedClose,
  fallbackFocus
}: {
  initial: ThirdPartyState | null
  onAnswered: (state: ThirdPartyState | null) => void
  onForcedClose: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const titleId = useId()
  const leadId = useId()
  const outcomeId = useId()
  const firstRef = useRef<HTMLButtonElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  const [choices, setChoices] = useState<ThirdPartyChoices>(NO_CHOICES)
  const [saving, setSaving] = useState<'all-off' | 'chosen' | null>(null)
  const [outcome, setOutcome] = useState<Exclude<CompleteOutcome, { kind: 'close' }> | null>(null)
  /** What this run goes on with once 继续使用 is pressed. */
  const settledState = useRef<ThirdPartyState | null>(null)
  const savingRef = useRef(false)
  const alive = useRef(true)
  const answeredRef = useRef(onAnswered)
  useLayoutEffect(() => {
    answeredRef.current = onAnswered
  })
  useLayoutEffect(() => {
    alive.current = true
    firstRef.current?.focus()
    return () => {
      alive.current = false
    }
  }, [])

  const statsAvailable = initial === null || analyticsAvailable(initial)
  const statsUnavailable = initial === null ? null : unavailableText(initial.analytics)

  const save = (chosen: ThirdPartyChoices, kind: 'all-off' | 'chosen') => {
    if (savingRef.current || outcome?.kind === 'continue') return
    savingRef.current = true
    setSaving(kind)
    setOutcome(null)
    window.xidao.thirdParty
      .complete(chosen)
      .catch((): ThirdPartyResult | null => null)
      .then((result) => {
        savingRef.current = false
        if (!alive.current) return
        setSaving(null)
        const next = completeOutcome(chosen, result)
        if (next.kind === 'close') {
          answeredRef.current(result?.state ?? null)
          return
        }
        settledState.current = result?.state ?? null
        setOutcome(next)
        if (next.kind === 'continue') requestAnimationFrame(() => continueRef.current?.focus())
      })
  }

  const busy = saving !== null
  const locked = busy || outcome?.kind === 'continue'
  const toggle = (service: ThirdPartyService) => {
    if (locked) return
    if (service === 'analytics' && !statsAvailable) return
    setChoices((previous) => ({ ...previous, [service]: !previous[service] }))
  }

  return (
    <Modal className="third-party-dialog" labelledBy={titleId} onClose={onForcedClose} fallbackFocus={fallbackFocus}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          开启哪些第三方服务？
        </h2>
      </header>
      <div className="modal-body third-party-body">
        <p className="notice-inline is-warning third-party-warning" id={leadId}>
          <Icon name="alert" size={16} />
          <span>{THIRD_PARTY_WARNING}</span>
        </p>
        <p className="third-party-lead">
          打开要使用的服务，点“保存选择”后生效。不开启也能照常浏览、发串和回复，以后可在 设置 › 系统 › 第三方服务 中更改。
        </p>
        <fieldset className="third-party-choices" aria-describedby={leadId}>
          <legend className="visually-hidden">选择要开启的服务</legend>
          {ORDER.map((service, index) => {
            const disabled = service === 'analytics' && !statsAvailable
            const note = disabled ? statsUnavailable : null
            const factsId = `${titleId}-${service}-facts`
            const nameId = `${titleId}-${service}-name`
            const purposeId = `${titleId}-${service}-purpose`
            const noteId = `${titleId}-${service}-note`
            return (
              <div className={disabled ? 'third-party-choice is-unavailable' : 'third-party-choice'} key={service}>
                <div className="third-party-choice-head">
                  <span className="third-party-choice-text">
                    <span className="third-party-choice-name" id={nameId}>
                      {SERVICE_NAME[service]}
                    </span>
                    <span className="third-party-choice-purpose" id={purposeId}>
                      {SERVICE_PURPOSE[service]}
                    </span>
                  </span>
                  <Switch
                    ref={index === 0 ? firstRef : undefined}
                    labelledBy={nameId}
                    describedBy={note !== null ? `${purposeId} ${noteId} ${factsId}` : `${purposeId} ${factsId}`}
                    checked={choices[service]}
                    locked={disabled || locked}
                    onToggle={() => toggle(service)}
                  />
                </div>
                {note !== null && (
                  <p className="third-party-choice-note" id={noteId}>
                    {note}
                  </p>
                )}
                <ServiceFacts service={service} id={factsId} />
              </div>
            )
          })}
        </fieldset>
      </div>
      <div className="modal-actions third-party-actions">
        {outcome !== null && (
          <p className="notice-inline is-warning third-party-outcome" id={outcomeId} role="alert">
            <Icon name="alert" size={14} />
            <span>
              {outcome.text}
              <KaomojiDecor state="failure" />
            </span>
          </p>
        )}
        {outcome?.kind === 'continue' ? (
          <button ref={continueRef} type="button" className="btn btn-primary" aria-describedby={outcomeId} onClick={() => answeredRef.current(settledState.current)}>
            继续使用
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              aria-disabled={busy || undefined}
              aria-busy={saving === 'all-off' || undefined}
              aria-describedby={outcome !== null ? outcomeId : undefined}
              onClick={() => save(NO_CHOICES, 'all-off')}
            >
              {saving === 'all-off' && <Spinner />}
              全部拒绝
            </button>
            <button
              type="button"
              className="btn btn-primary"
              aria-disabled={busy || undefined}
              aria-busy={saving === 'chosen' || undefined}
              aria-describedby={outcome !== null ? outcomeId : undefined}
              onClick={() => save(statsAvailable ? choices : { ...choices, analytics: false }, 'chosen')}
            >
              {saving === 'chosen' && <Spinner />}
              保存选择
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
