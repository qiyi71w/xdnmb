// 设置 › 系统 › 公告: the latest announcement obtained (this run's read or the kept copy), viewable
// any number of times. Opening 设置 only reads what the main process holds (waiting for the
// cold-start read if it is still running); only 重新获取 reads the announcement source again.

import { useEffect, useId, useRef, useState } from 'react'
import type { AnnouncementState } from '../../../../shared/announcements'
import { Section } from '../../app/settingsSections'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { formatRecordTime } from '../../lib/time'
import { AnnouncementBody } from './AnnouncementBody'
import { announcementStatus } from './announcementText'
import './announcements.css'

type View = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; state: AnnouncementState }

/** `active`: 设置 is the active tab; each time it becomes active the held state is read again. */
export function AnnouncementSection({ active }: { active: boolean }) {
  const statusId = useId()
  const textLabelId = useId()
  const [view, setView] = useState<View>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const refreshingRef = useRef(false)
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
    window.xidao.announcements.getState().then(
      (state) => {
        // A 重新获取 answered meanwhile is newer than this read.
        if (current && !refreshingRef.current) setView({ status: 'ready', state })
      },
      () => {
        if (current && !refreshingRef.current) setView((previous) => (previous.status === 'ready' ? previous : { status: 'failed' }))
      }
    )
    return () => {
      current = false
    }
  }, [active])

  const refresh = () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setRefreshFailed(false)
    window.xidao.announcements.refresh().then(
      (state) => {
        refreshingRef.current = false
        if (!alive.current) return
        setRefreshing(false)
        setView({ status: 'ready', state })
      },
      () => {
        refreshingRef.current = false
        if (!alive.current) return
        setRefreshing(false)
        setRefreshFailed(true)
      }
    )
  }

  const busy = refreshing || view.status === 'loading'
  const latest = view.status === 'ready' ? view.state.latest : null

  return (
    <Section id="settings-announcements" title="公告">
      <div className="announcement-check">
        <div className="announcement-status" id={statusId} role="status">
          <Status view={view} refreshing={refreshing} />
          {refreshFailed && (
            <p className="notice-inline is-warning">
              <Icon name="alert" size={14} />
              <span>
                没能重新获取：应用内部请求失败
                <KaomojiDecor state="failure" />
              </span>
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-page"
          aria-disabled={busy || undefined}
          aria-busy={refreshing || undefined}
          aria-describedby={statusId}
          onClick={() => {
            if (!busy) refresh()
          }}
        >
          <Icon name="refresh" size={14} />
          重新获取
        </button>
      </div>
      {latest !== null && (
        <div className="announcement-view">
          <span className="visually-hidden" id={textLabelId}>
            公告内容
          </span>
          <AnnouncementBody nodes={latest.nodes} className="is-settings" displayed={active} labelledBy={textLabelId} />
        </div>
      )}
    </Section>
  )
}

function Status({ view, refreshing }: { view: View; refreshing: boolean }) {
  if (refreshing) {
    return (
      <p className="announcement-status-line">
        <Spinner />
        正在获取公告…
      </p>
    )
  }
  if (view.status === 'loading') {
    return (
      <p className="announcement-status-line">
        <Spinner />
        正在读取公告…
      </p>
    )
  }
  if (view.status === 'failed') {
    return (
      <p className="notice-inline is-warning">
        <Icon name="alert" size={14} />
        <span>
          未能读取公告状态
          <KaomojiDecor state="failure" />
        </span>
      </p>
    )
  }
  return announcementStatus(view.state, (iso) => formatRecordTime(iso)).map((line) =>
    line.tone === 'warning' ? (
      <p key={line.text} className="notice-inline is-warning">
        <Icon name="alert" size={14} />
        <span>{line.text}</span>
      </p>
    ) : (
      <p key={line.text} className="announcement-status-line">
        {line.text}
      </p>
    )
  )
}
