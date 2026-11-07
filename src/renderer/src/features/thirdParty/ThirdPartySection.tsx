// 设置 › 系统 › 第三方服务: each optional service with its own switch and the same facts as the
// first-run disclosure. Turning one off stops it for this run before anything is stored; turning
// one on stores it first. The main process decides; this view shows its state and what did not stick.

import { useEffect, useId, useRef, useState } from 'react'
import type { ThirdPartyResult, ThirdPartyService, ThirdPartyState } from '../../../../shared/third-party'
import { Section, SettingRow, Switch } from '../../app/settingsSections'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { unavailableText } from '../analytics/analyticsText'
import { ServiceFacts, SERVICE_PURPOSE, THIRD_PARTY_WARNING } from './ServiceFacts'
import { useThirdParty } from './thirdPartyAccess'
import { choiceFailureText, SERVICE_NAME, serviceAllowed } from './thirdPartyState'
import './third-party.css'

const ORDER: readonly ThirdPartyService[] = ['updates', 'search', 'analytics']

/** `active`: 设置 is the active tab; each time it becomes active the state is read again. */
export function ThirdPartySection({ active }: { active: boolean }) {
  const { state, apply } = useThirdParty()
  const [readFailed, setReadFailed] = useState(false)
  const busyRef = useRef(false)

  useEffect(() => {
    if (!active) return
    let current = true
    window.xidao.thirdParty.getState().then(
      (value) => {
        // An action answered meanwhile is newer than this read.
        if (current && !busyRef.current) {
          setReadFailed(false)
          apply(value)
        }
      },
      () => {
        if (current) setReadFailed(true)
      }
    )
    return () => {
      current = false
    }
  }, [active, apply])

  return (
    <Section id="settings-third-party" title="第三方服务">
      <p className="notice-inline is-warning third-party-warning">
        <Icon name="alert" size={16} />
        <span>{THIRD_PARTY_WARNING}</span>
      </p>
      {state === null ? (
        readFailed ? (
          <Warning text="未能读取第三方服务状态" />
        ) : (
          <p className="third-party-status-line">
            <Spinner />
            正在读取第三方服务状态…
          </p>
        )
      ) : (
        ORDER.map((service) => <ServiceRow key={service} service={service} state={state} busyRef={busyRef} onState={apply} />)
      )}
    </Section>
  )
}

function ServiceRow({
  service,
  state,
  busyRef,
  onState
}: {
  service: ThirdPartyService
  state: ThirdPartyState
  busyRef: { current: boolean }
  onState: (state: ThirdPartyState) => void
}) {
  const labelId = useId()
  const helpId = useId()
  const failureId = useId()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const on = serviceAllowed(state, service)
  const unavailable = service === 'analytics' ? unavailableText(state.analytics) : null
  const blocked = !state.acknowledged

  const toggle = () => {
    if (busy || busyRef.current || blocked || (unavailable !== null && !on)) return
    const allowed = !on
    busyRef.current = true
    setBusy(true)
    setFailure(null)
    window.xidao.thirdParty
      .setChoice(service, allowed)
      .catch((): ThirdPartyResult | null => null)
      .then((result) => {
        busyRef.current = false
        if (result !== null) onState(result.state)
        else window.xidao.thirdParty.getState().then(onState, () => undefined)
        if (!alive.current) return
        setBusy(false)
        setFailure(choiceFailureText(service, allowed, result))
      })
  }

  const help = blocked ? '先在启动时的说明里作出选择' : unavailable ?? statusText(service, on, state)
  return (
    <div className="third-party-row">
      <SettingRow labelId={labelId} label={SERVICE_NAME[service]} helpId={helpId} help={help}>
        <Switch
          labelledBy={labelId}
          describedBy={failure !== null ? `${helpId} ${failureId}` : helpId}
          checked={on}
          busy={busy}
          disabled={blocked || (unavailable !== null && !on)}
          onToggle={toggle}
        />
      </SettingRow>
      <div className="third-party-outcome-slot" id={failureId} role="status">
        {failure !== null && <Warning text={failure} />}
      </div>
      <details className="third-party-details">
        <summary>
          <Icon name="chevron" size={14} className="third-party-details-icon" />
          接收方、数据与保留
        </summary>
        <p className="third-party-details-purpose">{SERVICE_PURPOSE[service]}。</p>
        <ServiceFacts service={service} />
      </details>
    </div>
  )
}

function statusText(service: ThirdPartyService, on: boolean, state: ThirdPartyState): string {
  switch (service) {
    case 'updates':
      return on ? '已开启，自动检查按“关于”中的更新设置进行' : '已关闭，不检查或下载更新'
    case 'search':
      return on ? '已开启，只在你搜索、翻页或重试时发送请求' : '已关闭，搜索词不会发出'
    case 'analytics':
      if (!on) return '已关闭，不发送统计'
      return state.analytics.saved === 'on' ? '已开启，每个北京时间自然日首次在前台使用时发送一次' : '仅本次运行开启，下次启动不会保留'
  }
}

function Warning({ text }: { text: string }) {
  return (
    <p className="notice-inline is-warning third-party-outcome">
      <Icon name="alert" size={14} />
      <span>
        {text}
        <KaomojiDecor state="failure" />
      </span>
    </p>
  )
}
