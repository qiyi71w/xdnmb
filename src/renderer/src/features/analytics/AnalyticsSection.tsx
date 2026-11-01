// 设置 › 系统 › 使用统计: the statistics choice and the same explanation as the first-run question.
// The main process decides and stores everything; this view shows its state and reports what did
// not stick.

import { useEffect, useId, useRef, useState } from 'react'
import type { AnalyticsChoiceResult, AnalyticsState } from '../../../../shared/analytics'
import { Section, SettingRow, Switch } from '../../app/settingsSections'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { AnalyticsDisclosure } from './AnalyticsDisclosure'
import { choiceFailureText, unavailableText } from './analyticsText'
import './analytics.css'

type View = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; state: AnalyticsState }
/** Why the last choice did not stick, if it did not. */
type Failure = string | null

/** `active`: 设置 is the active tab; each time it becomes active the state is read again. */
export function AnalyticsSection({ active }: { active: boolean }) {
  const labelId = useId()
  const helpId = useId()
  const failureId = useId()
  const [view, setView] = useState<View>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure>(null)
  const busyRef = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let current = true
    window.xidao.analytics.getState().then(
      (state) => {
        // An action answered meanwhile is newer than this read.
        if (current && !busyRef.current) setView({ status: 'ready', state })
      },
      () => {
        if (current && !busyRef.current) setView((previous) => (previous.status === 'ready' ? previous : { status: 'failed' }))
      }
    )
    return () => {
      current = false
    }
  }, [active])

  const toggle = (state: AnalyticsState) => {
    if (busyRef.current) return
    const choice = state.choice === 'on' ? 'off' : 'on'
    busyRef.current = true
    setBusy(true)
    setFailure(null)
    window.xidao.analytics
      .setChoice(choice)
      .catch((): AnalyticsChoiceResult | null => null)
      .then((result) => {
        busyRef.current = false
        if (!alive.current) return
        setBusy(false)
        if (result !== null) setView({ status: 'ready', state: result.state })
        if (result?.result !== 'saved') setFailure(choiceFailureText(choice, result))
      })
  }

  if (view.status !== 'ready') {
    return (
      <Section id="settings-analytics" title="使用统计">
        {view.status === 'loading' ? (
          <p className="analytics-status-line">
            <Spinner />
            正在读取统计状态…
          </p>
        ) : (
          <Warning text="未能读取统计状态" />
        )}
      </Section>
    )
  }

  const { state } = view
  const unavailable = unavailableText(state)
  return (
    <Section id="settings-analytics" title="使用统计">
      {unavailable !== null ? (
        <p className="analytics-status-line">{unavailable}</p>
      ) : (
        <SettingRow labelId={labelId} label="参与使用统计" helpId={helpId} help={choiceHelp(state)}>
          <Switch
            labelledBy={labelId}
            describedBy={failure !== null ? `${helpId} ${failureId}` : helpId}
            checked={state.choice === 'on'}
            busy={busy}
            onToggle={() => toggle(state)}
          />
        </SettingRow>
      )}
      <div className="analytics-outcome" id={failureId} role="status">
        {failure !== null && <Warning text={failure} />}
      </div>
      <details className="analytics-details">
        <summary>
          <Icon name="chevron" size={14} className="analytics-details-icon" />
          发送的内容
        </summary>
        <AnalyticsDisclosure />
      </details>
    </Section>
  )
}

function choiceHelp(state: AnalyticsState): string {
  if (state.choice === 'on') return '已开启：每个北京时间自然日前台使用时发送一次'
  if (state.choice === 'unset') return '尚未选择，不会发送'
  return '已关闭，不会发送'
}

function Warning({ text }: { text: string }) {
  return (
    <p className="notice-inline is-warning analytics-warning">
      <Icon name="alert" size={14} />
      <span>
        {text}
        <KaomojiDecor state="failure" />
      </span>
    </p>
  )
}
