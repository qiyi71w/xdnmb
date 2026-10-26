import { comparePostIds, type ContentNode, type Post, type PostId } from '../../shared/forum'
import type { ReminderKind } from '../../shared/reminders'
import type { ReminderObservation, RuleSnapshot, ReminderUncertainty } from './contract'

export interface EvaluatedHit {
  postId: PostId
  page: number
  post: Post | null
  kinds: Record<string, number>
  /** Quoted posts whose 饼干 ID matches an imported cookie. */
  quotedOwnIds: PostId[]
}

/** IDs this content explicitly quotes (`>>No.x`), in order of first appearance. */
export function quotedPostIds(nodes: ContentNode[], result: Set<PostId> = new Set()): Set<PostId> {
  for (const node of nodes) {
    if (node.type === 'quoteRef') result.add(node.postId)
    else if ('children' in node) quotedPostIds(node.children, result)
  }
  return result
}

/**
 * Uses observation evidence, never ReplyCount or server time. A quote is "of mine" when the quoted
 * post's 饼干 ID matches an imported cookie's; a quoted post whose ID is unknown (not obtained) makes
 * the reply unverified for the quote rule, never a non-match.
 */
export function evaluateObservedReplies(input: {
  observations: ReminderObservation[]
  rules: RuleSnapshot[]
  thresholds: Map<ReminderKind, PostId | null>
  /** 饼干 IDs of the imported cookies; empty means no quote can match. */
  cookieIds: ReadonlySet<string>
  /** Stored quoted post, or `null` when its content is not available locally. */
  quotedPost: (postId: PostId) => Post | null
  target: PostId | null
}): { hits: EvaluatedHit[]; uncertainIds: PostId[]; uncertainty: ReminderUncertainty; quoteUnverifiedIds: PostId[] } {
  const hits = new Map<PostId, EvaluatedHit>()
  const uncertain = new Set<PostId>()
  const unverified = new Set<PostId>()
  const uncertainty: ReminderUncertainty = {}
  for (const observation of input.observations) {
    for (let index = 0; index < observation.replyIds.length; index++) {
      const postId = observation.replyIds[index]!
      if (input.target === null || comparePostIds(postId, input.target) > 0) continue
      const post = observation.posts[index] ?? null
      const quoted = new Set<PostId>()
      let quoteUnknown = false
      if (post && input.cookieIds.size > 0) {
        for (const id of quotedPostIds(post.content)) {
          const cookieId = input.quotedPost(id)?.userHash ?? null
          if (cookieId === null) quoteUnknown = true
          else if (input.cookieIds.has(cookieId)) quoted.add(id)
        }
      }
      for (const rule of input.rules) {
        if (rule.watermarkPostId !== null && comparePostIds(postId, rule.watermarkPostId) <= 0) continue
        // A quoted post without a known 饼干 ID stays an open gap even when another quote matched.
        if (rule.kind === 'quote' && quoteUnknown) unverified.add(postId)
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
  // separate from confirmed counts rather than changing the event records.
  return { hits: [...hits.values()], uncertainIds: [...uncertain], uncertainty, quoteUnverifiedIds: [...unverified] }
}
