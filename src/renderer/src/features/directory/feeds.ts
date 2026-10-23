import type { BoardDirectory, ContentNode, FeedRef, ForumId } from '../../../../shared/forum'

/** What the list pane needs to know about the selected forum or timeline. */
export interface FeedInfo {
  ref: FeedRef
  name: string
  /** Forum 版规 or timeline 说明, shown separately from the thread list. */
  description: ContentNode[]
  /** Timeline page limit when the forum publishes one. */
  maxPage: number | null
}

export function feedKey(ref: FeedRef): string {
  return `${ref.kind}:${ref.id}`
}

export function findFeed(directory: BoardDirectory, ref: FeedRef): FeedInfo | null {
  if (ref.kind === 'timeline') {
    const timeline = directory.timelines.find((item) => item.id === ref.id)
    return timeline === undefined ? null : { ref, name: timeline.displayName, description: timeline.notice, maxPage: timeline.maxPage }
  }
  for (const group of directory.groups) {
    const forum = group.forums.find((item) => item.id === ref.id)
    if (forum !== undefined) return { ref, name: forum.displayName, description: forum.rules, maxPage: null }
  }
  return null
}

export function forumNames(directory: BoardDirectory | null): ReadonlyMap<ForumId, string> {
  const names = new Map<ForumId, string>()
  if (directory === null) return names
  for (const group of directory.groups) {
    for (const forum of group.forums) names.set(forum.id, forum.displayName)
  }
  return names
}
