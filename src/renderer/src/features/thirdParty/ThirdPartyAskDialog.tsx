// The question for one service the user turned down at first, asked when they start something
// that needs it (a search, a manual update check, …). 开启 stores the permission first; the
// action that asked continues once only after that succeeded. 不开启, ×, Esc and the backdrop
// decline for this action and change nothing. While storing, every close and press is ignored.

import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ThirdPartyResult, ThirdPartyState } from '../../../../shared/third-party'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Modal, ModalHeader } from '../../components/Modal'
import { ServiceFacts, SERVICE_PURPOSE, SERVICE_WARNING } from './ServiceFacts'
import type { AskedService } from './thirdPartyAccess'
import { choiceFailureText, granted, SERVICE_NAME } from './thirdPartyState'
import './third-party.css'

export function ThirdPartyAskDialog({
  service,
  onAnswer,
  fallbackFocus
}: {
  service: AskedService
  onAnswer: (granted: boolean, state: ThirdPartyState | null) => void
  fallbackFocus: () => HTMLElement | null
}) {
  const titleId = useId()
  const factsId = useId()
  const failureId = useId()
  const declineRef = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const savingRef = useRef(false)
  const alive = useRef(true)
  const answerRef = useRef(onAnswer)
  useLayoutEffect(() => {
    answerRef.current = onAnswer
  })
  useLayoutEffect(() => {
    alive.current = true
    declineRef.current?.focus()
    return () => {
      alive.current = false
    }
  }, [])

  const name = SERVICE_NAME[service]

  const allow = () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setFailure(null)
    window.xidao.thirdParty
      .setChoice(service, true)
      .catch((): ThirdPartyResult | null => null)
      .then((result) => {
        savingRef.current = false
        if (!alive.current) return
        setSaving(false)
        if (granted(service, result)) {
          answerRef.current(true, result?.state ?? null)
          return
        }
        setFailure(choiceFailureText(service, true, result) ?? `没能开启${name}`)
      })
  }

  const decline = () => {
    if (!savingRef.current) answerRef.current(false, null)
  }

  return (
    <Modal className="third-party-dialog third-party-ask" labelledBy={titleId} onClose={decline} fallbackFocus={fallbackFocus}>
      <ModalHeader title={`开启${name}？`} titleId={titleId} closeLabel={`不开启${name}`} onClose={decline} closeDisabled={saving} />
      <div className="modal-body third-party-body">
        <p className="third-party-lead">{SERVICE_PURPOSE[service]}。开启后可随时在设置中关闭。</p>
        <p className="notice-inline is-warning third-party-warning">
          <Icon name="alert" size={16} />
          <span>{SERVICE_WARNING}</span>
        </p>
        <ServiceFacts service={service} id={factsId} />
      </div>
      <div className="modal-actions third-party-actions">
        {failure !== null && (
          <p className="notice-inline is-warning third-party-outcome" id={failureId} role="alert">
            <Icon name="alert" size={14} />
            <span>
              {failure}
              <KaomojiDecor state="failure" />
            </span>
          </p>
        )}
        <button ref={declineRef} type="button" className="btn" aria-disabled={saving || undefined} onClick={decline}>
          不开启
        </button>
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={saving || undefined}
          aria-busy={saving || undefined}
          aria-describedby={failure !== null ? `${factsId} ${failureId}` : factsId}
          onClick={allow}
        >
          {saving && <Spinner />}
          开启
        </button>
      </div>
    </Modal>
  )
}
