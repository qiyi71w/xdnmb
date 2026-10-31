// 设置 › 系统 › 使用统计: the statistics choice, the deletion of records linked to this device, and
// the same explanation as the first-run question. The main process decides and stores everything;
// this view shows its state and reports what did not stick.

import { useEffect, useId, useRef, useState } from 'react'
import type { AnalyticsChoiceResult, AnalyticsDeletionResult, AnalyticsState } from '../../../../shared/analytics'
import { Section, SettingRow, Switch } from '../../app/settingsSections'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { AnalyticsDisclosure } from './AnalyticsDisclosure'
import { choiceFailureText, deletionFailureText, unavailableText } from './analyticsText'
import './analytics.css'

type View = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; state: AnalyticsState }
type Busy = 'choice' | 'delete' | null
/** The outcome of the last action in this view. */
type Outcome = { kind: 'choice-failed'; text: string } | { kind: 'deleted' } | { kind: 'delete-failed'; text: string } | null

/** `active`: 设置 is the active tab; each time it becomes active the state is read again. */
export function AnalyticsSection({ active }: { active: boolean }) {
  const labelId = useId()
  const helpId = useId()
  const outcomeId = useId()
  const [view, setView] = useState<View>({ status: 'loading' })
  const [busy, setBusy] = useState<Busy>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const busyRef = useRef<Busy>(null)
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
        if (current && busyRef.current === null) setView({ status: 'ready', state })
      },
      () => {
        if (current && busyRef.current === null) setView((previous) => (previous.status === 'ready' ? previous : { status: 'failed' }))
      }
    )
    return () => {
      current = false
    }
  }, [active])

  const run = <T extends AnalyticsChoiceResult | AnalyticsDeletionResult>(kind: Exclude<Busy, null>, work: () => Promise<T>, done: (result: T | null) => void) => {
    if (busyRef.current !== null) return
    busyRef.current = kind
    setBusy(kind)
    setOutcome(null)
    work()
      .catch((): T | null => null)
      .then((result) => {
        busyRef.current = null
        if (!alive.current) return
        setBusy(null)
        if (result !== null) setView({ status: 'ready', state: result.state })
        done(result)
      })
  }

  const toggle = (state: AnalyticsState) => {
    const choice = state.choice === 'on' ? 'off' : 'on'
    run('choice', () => window.xidao.analytics.setChoice(choice), (result) => {
      if (result?.result !== 'saved') setOutcome({ kind: 'choice-failed', text: choiceFailureText(choice, result) })
    })
  }

  const remove = () => {
    run('delete', () => window.xidao.analytics.deleteData(), (result) => {
      if (result?.result === 'deleted') setOutcome({ kind: 'deleted' })
      else setOutcome({ kind: 'delete-failed', text: result === null ? '应用内部请求失败，记录还没有删除' : deletionFailureText(result.reason) })
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
  const deleting = busy === 'delete'
  return (
    <Section id="settings-analytics" title="使用统计">
      {unavailable !== null ? (
        <p className="analytics-status-line">{unavailable}</p>
      ) : (
        <SettingRow labelId={labelId} label="参与使用统计" helpId={helpId} help={choiceHelp(state)}>
          <Switch
            labelledBy={labelId}
            describedBy={outcome?.kind === 'choice-failed' ? `${helpId} ${outcomeId}` : helpId}
            checked={state.choice === 'on'}
            busy={busy === 'choice'}
            onToggle={() => {
              if (busy === null) toggle(state)
            }}
          />
        </SettingRow>
      )}
      {/* The last action's own message replaces this general one. */}
      {state.deletionPending && outcome === null && (
        <Warning text="上次的统计记录删除还没有完成。统计保持关闭，可以重试删除。" />
      )}
      <div className="analytics-outcome" id={outcomeId} role="status">
        {outcome?.kind === 'choice-failed' && <Warning text={outcome.text} />}
        {outcome?.kind === 'delete-failed' && <Warning text={`${outcome.text}。统计保持关闭，可以重试删除。`} />}
        {outcome?.kind === 'deleted' && (
          <p className="analytics-status-line">
            已删除统计服务上仍与本机标识关联的记录。更早的不含标识的每日汇总无法扣除；再次开启会生成新的统计标识，可能被算作另一个安装。
          </p>
        )}
      </div>
      {/* While on, an identity may appear at any moment (registration runs in the background). */}
      {(state.choice === 'on' || state.hasIdentity || state.deletionPending) && (
        <div className="analytics-delete">
          <button
            type="button"
            className="btn btn-danger btn-page"
            aria-disabled={busy !== null || undefined}
            aria-busy={deleting || undefined}
            aria-describedby={outcomeId}
            onClick={() => {
              if (busy === null) remove()
            }}
          >
            {deleting ? <Spinner /> : <Icon name="trash" size={14} />}
            {state.deletionPending ? '重试删除统计记录' : '关闭统计并删除记录'}
          </button>
        </div>
      )}
      <details className="analytics-details">
        <summary>
          <Icon name="chevron" size={14} className="analytics-details-icon" />
          发送的内容、接收方与保留期
        </summary>
        <AnalyticsDisclosure receiver={state.receiver} />
      </details>
    </Section>
  )
}

function choiceHelp(state: AnalyticsState): string {
  if (state.choice === 'on') return '已开启：每个北京时间自然日前台使用时发送一次'
  if (state.deletionPending) return '已关闭：删除完成后才能重新开启'
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
