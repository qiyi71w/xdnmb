// The first-run usage-statistics question: asked once while never answered, as the first startup
// prompt (the announcement waits for it). 开启 and 关闭 are equal choices with focus on 关闭;
// × and Esc answer 关闭. Only a stored answer closes it; a failed save stays visible, and closing
// once more then keeps the answer for this run only.

import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { AnalyticsChoiceResult, AnalyticsState } from '../../../../shared/analytics'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Modal, ModalHeader } from '../../components/Modal'
import { AnalyticsDisclosure } from './AnalyticsDisclosure'
import { choicePromptReducer, choiceSettled, INITIAL_CHOICE_PROMPT } from './choicePrompt'
import { choiceFailureText } from './analyticsText'
import './analytics.css'

/**
 * This run's first-run question. `eligible` / `stillEligible` as for every startup prompt (see
 * `promptEligible`). `settled`: nothing more will be asked, so later startup prompts may show.
 * `drop` takes it off screen unanswered (a quit closes competing dialogs).
 */
export function useAnalyticsChoicePrompt(eligible: boolean, stillEligible: () => boolean) {
  const [prompt, dispatch] = useReducer(choicePromptReducer, INITIAL_CHOICE_PROMPT)
  const [state, setState] = useState<AnalyticsState | null>(null)

  useEffect(() => {
    let alive = true
    window.xidao.analytics.getState().then(
      (value) => {
        if (!alive) return
        setState(value)
        dispatch({ type: 'read', state: value })
      },
      () => {
        if (alive) dispatch({ type: 'read', state: null })
      }
    )
    return () => {
      alive = false
    }
  }, [])

  const check = useRef(stillEligible)
  useLayoutEffect(() => {
    check.current = stillEligible
  })
  const waiting = prompt.phase === 'waiting'
  useEffect(() => {
    if (waiting && eligible && check.current()) dispatch({ type: 'show' })
  }, [waiting, eligible])

  const close = useCallback(() => dispatch({ type: 'close' }), [])
  const drop = useCallback(() => dispatch({ type: 'drop' }), [])
  return {
    receiver: prompt.phase === 'shown' && state !== null ? state.receiver : null,
    shown: prompt.phase === 'shown',
    settled: choiceSettled(prompt),
    close,
    drop
  }
}

export function AnalyticsChoiceDialog({
  receiver,
  onClose,
  fallbackFocus
}: {
  receiver: string | null
  onClose: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const titleId = useId()
  const failureId = useId()
  const offRef = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState<'on' | 'off' | null>(null)
  /** The failed answer and why; a failed 关闭 already applies to this run. */
  const [failure, setFailure] = useState<{ choice: 'on' | 'off'; text: string } | null>(null)
  const savingRef = useRef(false)
  const alive = useRef(true)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  useLayoutEffect(() => {
    alive.current = true
    offRef.current?.focus()
    return () => {
      alive.current = false
    }
  }, [])

  const choose = (choice: 'on' | 'off') => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(choice)
    window.xidao.analytics
      .setChoice(choice)
      .catch((): AnalyticsChoiceResult | null => null)
      .then((result) => {
        savingRef.current = false
        if (!alive.current) return
        setSaving(null)
        if (result?.result === 'saved') closeRef.current()
        else setFailure({ choice, text: choiceFailureText(choice, result) })
      })
  }

  /** 关闭, ×, Esc: once 关闭 failed to save, closes with this run already off. */
  const dismiss = () => {
    if (savingRef.current) return
    if (failure?.choice === 'off') onClose()
    else choose('off')
  }

  const busy = saving !== null
  return (
    <Modal className="analytics-dialog" labelledBy={titleId} onClose={dismiss} fallbackFocus={fallbackFocus}>
      <ModalHeader title="使用统计" titleId={titleId} closeLabel="关闭，不开启统计" onClose={dismiss} closeDisabled={busy} />
      <div className="modal-body analytics-dialog-body">
        <p className="analytics-lead">是否开启使用统计？不开启就不会发送任何统计。</p>
        <AnalyticsDisclosure receiver={receiver} />
      </div>
      <div className="modal-actions analytics-actions">
        {failure !== null && (
          <p className="notice-inline is-warning analytics-failure" id={failureId} role="alert">
            <Icon name="alert" size={14} />
            <span>
              {failure.text}
              <KaomojiDecor state="failure" />
            </span>
          </p>
        )}
        <button
          ref={offRef}
          type="button"
          className="btn"
          aria-disabled={busy || undefined}
          aria-busy={saving === 'off' || undefined}
          aria-describedby={failure !== null ? failureId : undefined}
          onClick={dismiss}
        >
          {saving === 'off' && <Spinner />}
          关闭
        </button>
        <button
          type="button"
          className="btn"
          aria-disabled={busy || undefined}
          aria-busy={saving === 'on' || undefined}
          aria-describedby={failure !== null ? failureId : undefined}
          onClick={() => choose('on')}
        >
          {saving === 'on' && <Spinner />}
          开启
        </button>
      </div>
    </Modal>
  )
}
