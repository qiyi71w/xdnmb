import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StorageStatus } from '../../../shared/api'
import type { FeedRef, Post, ThreadId, ThreadSummary } from '../../../shared/forum'
import { Icon } from '../components/Icon'
import { feedKey, findFeed, forumNames, type FeedInfo } from '../features/directory/feeds'
import { Navigation } from '../features/directory/Navigation'
import { useDirectory } from '../features/directory/useDirectory'
import { FeedPane } from '../features/feed/FeedPane'
import { ThreadPane } from '../features/thread/ThreadPane'
import './layout.css'

function StorageBanner({ storage }: { storage: StorageStatus | null }) {
  if (storage === null || storage.state === 'ready') return null
  const text =
    storage.state === 'read-only' ? '数据库来自更新版本，当前只读，新内容不会保存' : '本地存储不可用，内容不会被保存'
  return (
    <div className="storage-banner" role="status">
      <Icon name="alert" />
      <span>{text}</span>
    </div>
  )
}

export function App() {
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const directory = useDirectory()
  const { start: startDirectory } = directory
  const [feed, setFeed] = useState<FeedInfo | null>(null)
  const [thread, setThread] = useState<{ id: ThreadId; head: Post } | null>(null)

  useEffect(() => {
    let alive = true
    window.xidao.app
      .getStatus()
      .then((status) => {
        if (alive) setStorage(status.storage)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) startDirectory()
      })
    return () => {
      alive = false
    }
  }, [startDirectory])

  // A refreshed directory replaces names and rules of the selected feed; a feed that disappeared
  // from the directory keeps its last known details.
  const dirData = directory.state.directory
  useEffect(() => {
    if (dirData === null) return
    setFeed((current) => (current === null ? current : (findFeed(dirData, current.ref) ?? current)))
  }, [dirData])

  const names = useMemo(() => forumNames(dirData), [dirData])
  const forumName = useCallback((forumId: string | null) => (forumId === null ? null : (names.get(forumId) ?? null)), [names])

  const selectFeed = useCallback(
    (ref: FeedRef) => {
      if (dirData === null) return
      setFeed((current) => (current !== null && feedKey(current.ref) === feedKey(ref) ? current : findFeed(dirData, ref)))
    },
    [dirData]
  )

  const openThread = useCallback((summary: ThreadSummary) => {
    setThread((current) => (current?.id === summary.head.id ? current : { id: summary.head.id, head: summary.head }))
  }, [])

  return (
    <div className="app">
      <StorageBanner storage={storage} />
      <div className="workspace">
        <Navigation state={directory.state} selected={feed?.ref ?? null} onSelect={selectFeed} onRetry={directory.retry} />

        <div className="list-column">
          {feed === null ? (
            <div className="pane-empty">
              <p className="pane-empty-title">选择时间线或版面</p>
              <p className="pane-empty-text">串列表会显示在这里。</p>
            </div>
          ) : (
            <FeedPane
              key={feedKey(feed.ref)}
              info={feed}
              forumNames={names}
              selectedThreadId={thread?.id ?? null}
              onOpenThread={openThread}
            />
          )}
        </div>

        <main className="reader-column-wrap">
          {thread === null ? (
            <div className="pane-empty">
              <p className="pane-empty-title">选择一个串开始阅读</p>
              <p className="pane-empty-text">主帖与回复会显示在这里，接近底部时自动读取下一页。</p>
            </div>
          ) : (
            <ThreadPane key={thread.id} threadId={thread.id} initialHead={thread.head} forumName={forumName} />
          )}
        </main>
      </div>
    </div>
  )
}
