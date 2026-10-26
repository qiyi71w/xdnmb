import type { Post } from '../../../../shared/forum'
import type { IdentityOverview } from '../../../../shared/identity'

/** The known 饼干 IDs of the imported cookies; a cookie whose ID is unknown contributes nothing. */
export function ownCookieIds(overview: IdentityOverview | null): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const credential of overview?.credentials ?? []) {
    if (credential.cookieId !== null) ids.add(credential.cookieId)
  }
  return ids
}

/** A post is the user's own when its public 饼干 ID equals one of `ids`; a post without an ID never is. */
export function isOwnPost(post: Pick<Post, 'userHash'>, ids: ReadonlySet<string>): boolean {
  return post.userHash !== null && ids.has(post.userHash)
}
