// Normalized forum content shared by the main process and the renderer.
// The renderer never receives raw forum JSON or HTML.

/** Forum identifiers are decimal strings; never JS numbers, array positions or floor numbers. */
export type PostId = string
export type ThreadId = string
export type ForumId = string
export type TimelineId = string

/** Orders decimal-string post IDs numerically without losing precision. */
export function comparePostIds(a: PostId, b: PostId): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Safe, structured post body. Produced only by the main-process content parser.
 * There is no node that carries raw HTML, styles, event attributes or scripts.
 */
export type ContentNode =
  | { type: 'text'; text: string }
  | { type: 'lineBreak' }
  /** Explicit reference to another post, e.g. `>>No.50000001`. Interaction belongs to quote navigation. */
  | { type: 'quoteRef'; postId: PostId; raw: string }
  | { type: 'emphasis'; style: EmphasisStyle; children: ContentNode[] }
  /** Forum quote styling (`<font color="#789922">`), rendered as a semantic quote span. */
  | { type: 'greentext'; children: ContentNode[] }
  /** Absolute http(s) link only; anything else is reduced to its text children. */
  | { type: 'link'; href: string; children: ContentNode[] }

export type EmphasisStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'small' | 'sup' | 'sub'

/** Image metadata as provided by the forum. Thumbnail/original loading belongs to the image reader. */
export interface PostImage {
  /** Forum `img` path, e.g. `2022-07-21/62d8ca6cdfabd`. */
  path: string
  /** Forum `ext`, e.g. `.jpg`. Extension may not match the real encoding. */
  ext: string
}

/** A main post (主帖) or reply (回复). Unprovided fields stay `null` (unknown), never zero/false. */
export interface Post {
  id: PostId
  forumId: ForumId | null
  /** Server `now` text as provided; timezone and precision are unverified. */
  createdAt: string | null
  /** Public 饼干标识 (not a credential). */
  userHash: string | null
  name: string | null
  title: string | null
  isAdmin: boolean | null
  isSage: boolean | null
  content: ContentNode[]
  /** Searchable plain text derived from `content`; line breaks are `\n`. */
  plainText: string
  image: PostImage | null
}

/** One thread entry in a forum or timeline list. */
export interface ThreadSummary {
  head: Post
  /** Server-reported reply count; `null` when not provided. Never proof of completeness. */
  replyCount: number | null
  /** Recent replies shown in the list, Tips excluded. Not a page observation. */
  recentReplies: Post[]
  remainReplies: number | null
}

export interface Forum {
  id: ForumId
  groupId: string
  groupName: string
  name: string
  /** `showName` when provided, otherwise `name`. */
  displayName: string
  /** 版规／说明 parsed into safe content. */
  rules: ContentNode[]
  /** Published posting interval in seconds; `null` when not provided. */
  postIntervalSeconds: number | null
}

export interface Timeline {
  id: TimelineId
  name: string
  displayName: string
  notice: ContentNode[]
  maxPage: number | null
}

export interface ForumGroup {
  id: string
  name: string
  forums: Forum[]
}

export interface BoardDirectory {
  groups: ForumGroup[]
  timelines: Timeline[]
  /** Groups/forums/timelines present in the responses but malformed. `> 0` means a partial directory. */
  skippedItems: number
}

export type FeedRef = { kind: 'forum'; id: ForumId } | { kind: 'timeline'; id: TimelineId }

export interface FeedPage {
  feed: FeedRef
  page: number
  threads: ThreadSummary[]
  /** Items present in the response but not usable (malformed). `> 0` means a partial page. */
  skippedItems: number
}

/** Reading mode of a thread page observation. PO pages never stand in for `all` coverage. */
export type ReadingMode = 'all' | 'po'

export interface ThreadPage {
  threadId: ThreadId
  mode: ReadingMode
  page: number
  head: Post
  /** Real replies on this page: Tips excluded, deduplicated by post ID, in server order. */
  replies: Post[]
  replyCount: number | null
  /** Items present but malformed. `> 0` means partial; such a page is never an end candidate. */
  skippedItems: number
  /** Valid target and structure with zero real replies and nothing skipped. A candidate, not proof. */
  endCandidate: boolean
}

export interface CoveragePage {
  page: number
  fetchedAt: string
  replyIds: PostId[]
  endCandidate: boolean
  skippedItems: number
}

/** What has actually been observed for a thread in one mode. */
export interface ThreadCoverage {
  threadId: ThreadId
  mode: ReadingMode
  /** Observed pages, ascending. */
  pages: CoveragePage[]
  /** Page numbers between 1 and the highest observed page that were never observed. */
  gaps: number[]
  /** Lowest observed end-candidate page, or `null`. */
  endCandidatePage: number | null
  /** Latest server-reported ReplyCount, or `null` when never provided. */
  reportedReplyCount: number | null
  /** Distinct reply IDs across observed pages. */
  obtainedReplyCount: number
  /**
   * `null` unless pages 1..endCandidatePage are all observed without skipped items;
   * then whether the reported count differs from the obtained count.
   */
  countMismatch: boolean | null
}
