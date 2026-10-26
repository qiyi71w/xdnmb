import { useEffect, useState } from 'react'
import type { IdentityChoice, PostTarget } from '../../../../shared/drafts'
import { rememberComposeOpener } from '../directory/navStore'
import { useEditorWorkspace } from '../editor/workspace'
import { focusKey } from '../editor/useEditorsStore'

export function usePostActions(tabId: number | null, threadId: string) {
  const { store } = useEditorWorkspace()
  const [ownIds, setOwnIds] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (tabId === null) return
    let alive = true
    void window.xidao.publication.listOwnPosts().then((result) => {
      if (alive && result.ok) setOwnIds(new Set(result.posts.map((post) => post.postId)))
    }).catch(() => undefined)
    return () => { alive = false }
  }, [tabId, store.publicationRevision])
  const open = async (postId: string, report: boolean, opener: HTMLElement | null) => {
    if (tabId === null) return
    const target: PostTarget = report ? { kind: 'thread', forumId: '18' } : { kind: 'reply', threadId }
    const key = focusKey(tabId, target)
    if (opener !== null) rememberComposeOpener(key, opener)
    const identity = await window.xidao.posting.identityFor({ target }).catch((): IdentityChoice => ({ source: 'unknown' }))
    store.dispatch(report ? { type: 'open-report', tabId, identity, postId } : { type: 'open-quote', tabId, target, identity, postId })
    store.clearPublished(key)
    store.requestFocus(key)
  }
  return { ownIds, reply: (postId: string, opener: HTMLElement | null) => void open(postId, false, opener), report: (postId: string, opener: HTMLElement | null) => void open(postId, true, opener) }
}
