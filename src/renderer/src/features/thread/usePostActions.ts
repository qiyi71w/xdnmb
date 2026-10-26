import { useMemo } from 'react'
import type { IdentityChoice, PostTarget } from '../../../../shared/drafts'
import type { Post } from '../../../../shared/forum'
import { rememberComposeOpener } from '../directory/navStore'
import { useEditorWorkspace } from '../editor/workspace'
import { focusKey } from '../editor/useEditorsStore'
import { isOwnPost, ownCookieIds } from './ownPosts'

export function usePostActions(tabId: number | null, threadId: string) {
  const { store, identities } = useEditorWorkspace()
  // Follows the shared identity overview, so an import or a 饼干 ID change applies at once.
  const ownIds = useMemo(() => ownCookieIds(identities.overview), [identities.overview])
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
  return {
    isOwn: (post: Post) => isOwnPost(post, ownIds),
    reply: (postId: string, opener: HTMLElement | null) => void open(postId, false, opener),
    report: (postId: string, opener: HTMLElement | null) => void open(postId, true, opener)
  }
}
