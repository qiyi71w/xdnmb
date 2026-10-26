import { comparePostIds, type ContentNode, type Post, type PostId } from '../../shared/forum'
import type { ReminderKind } from '../../shared/reminders'
import type { ReminderObservation, RuleSnapshot, ReminderUncertainty } from './contract'

export interface EvaluatedHit {
  postId: PostId
  page: number
  post: Post | null
  kinds: Record<string, number>
  quotedOwnIds: PostId[]
}

function quotedIds(nodes: ContentNode[], ownIds: ReadonlySet<PostId>, result: Set<PostId>): void {
  for (const node of nodes) {
    if (node.type === 'quoteRef' && ownIds.has(node.postId)) result.add(node.postId)
    else if ('children' in node) quotedIds(node.children, ownIds, result)
  }
}

/** Uses observation evidence, never ReplyCount, server time or public author hashes. */
export function evaluateObservedReplies(input: {
  observations: ReminderObservation[]
  rules: RuleSnapshot[]
  thresholds: Map<ReminderKind, PostId | null>
  ownIds: ReadonlySet<PostId>
  target: PostId | null
}): { hits: EvaluatedHit[]; uncertainIds: PostId[]; uncertainty: ReminderUncertainty } {
  const hits = new Map<PostId, EvaluatedHit>()
  const uncertain = new Set<PostId>()
  const uncertainty: ReminderUncertainty = {}
  for (const observation of input.observations) {
    for (let index = 0; index < observation.replyIds.length; index++) {
      const postId = observation.replyIds[index]!
      if (input.target === null || comparePostIds(postId, input.target) > 0) continue
      const post = observation.posts[index] ?? null
      const quoted = new Set<PostId>()
      if (post) quotedIds(post.content, input.ownIds, quoted)
      for (const rule of input.rules) {
        if (rule.watermarkPostId !== null && comparePostIds(postId, rule.watermarkPostId) <= 0) continue
        if (rule.kind === 'quote' && quoted.size === 0) continue
        const threshold = input.thresholds.get(rule.kind) ?? null
        if (threshold === null || comparePostIds(postId, threshold) < 0) {
          uncertain.add(postId)
          const evidence = uncertainty[rule.kind] ??= { generation: rule.generation, postIds: [] }
          if (!evidence.postIds.includes(postId)) evidence.postIds.push(postId)
          continue
        }
        const hit = hits.get(postId) ?? { postId, page: observation.page, post, kinds: {}, quotedOwnIds: [] }
        hit.kinds[rule.kind] = rule.generation
        if (rule.kind === 'quote') hit.quotedOwnIds = [...quoted].sort(comparePostIds)
        hits.set(postId, hit)
      }
    }
  }
  // A post confirmed by one rule is still an uncertain boundary for another; uncertainty stays
  // separate from confirmed counts rather than changing the event/read records.
  return { hits: [...hits.values()], uncertainIds: [...uncertain], uncertainty }
}
