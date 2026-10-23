import type { PostId } from '../../../../shared/forum'

/** Continuous qualifying time before a post counts as read. */
export const READ_DWELL_MS = 500

/** Geometry of one rendered post relative to the reading viewport, in CSS pixels. */
export interface PostVisibility {
  postId: PostId
  postHeight: number
  /** Height of the part of the post currently inside the reading viewport. */
  visibleHeight: number
}

/**
 * A post qualifies while its visible part is at least half of the smaller of its own height and the
 * viewport height: short posts must be half on screen, long posts must fill half the viewport.
 */
export function qualifiesAsVisible(post: PostVisibility, viewportHeight: number): boolean {
  if (!(post.postHeight > 0) || !(viewportHeight > 0) || !(post.visibleHeight > 0)) return false
  return post.visibleHeight >= Math.min(post.postHeight, viewportHeight) / 2
}

export interface JudgeClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: JudgeClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Dwell-based read judgement for one reader. Only an active reader (foreground tab, visible window)
 * accumulates time; a post is reported once after qualifying continuously for `dwellMs`. Any
 * interruption — scrolling it below the threshold, the reader becoming inactive, the post leaving
 * the rendered set — restarts its dwell. Prefetched, background, preview or indexed content never
 * reaches this judge, so it can never be reported as read.
 */
export class ReadJudge {
  private readonly clock: JudgeClock
  private readonly dwellMs: number
  private readonly onRead: (postIds: PostId[]) => void
  /** Already read or already reported; never reported again. */
  private readonly done = new Set<PostId>()
  /** Qualifying posts and when their current continuous dwell started. */
  private readonly since = new Map<PostId, number>()
  private active = false
  private timer: unknown = null
  private disposed = false

  constructor(options: { onRead: (postIds: PostId[]) => void; clock?: JudgeClock; dwellMs?: number }) {
    this.onRead = options.onRead
    this.clock = options.clock ?? systemClock
    this.dwellMs = options.dwellMs ?? READ_DWELL_MS
  }

  /** Posts known to be read already (e.g. from storage); they are never reported. */
  markKnownRead(postIds: Iterable<PostId>): void {
    for (const id of postIds) {
      this.done.add(id)
      this.since.delete(id)
    }
    this.schedule()
  }

  /** Foreground state of the reader. Becoming inactive discards every dwell in progress. */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return
    this.active = active
    if (!active) this.since.clear()
    this.schedule()
  }

  /**
   * Full snapshot of the posts currently rendered in the reader. Posts missing from the snapshot or
   * below the threshold lose their dwell; qualifying ones keep the time they started qualifying.
   */
  observe(posts: readonly PostVisibility[], viewportHeight: number): void {
    if (this.disposed || !this.active) return
    const now = this.clock.now()
    const qualifying = new Set<PostId>()
    for (const post of posts) {
      if (this.done.has(post.postId) || !qualifiesAsVisible(post, viewportHeight)) continue
      qualifying.add(post.postId)
      if (!this.since.has(post.postId)) this.since.set(post.postId, now)
    }
    for (const id of this.since.keys()) if (!qualifying.has(id)) this.since.delete(id)
    this.flush()
  }

  dispose(): void {
    this.disposed = true
    this.since.clear()
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private flush(): void {
    const now = this.clock.now()
    const due: PostId[] = []
    for (const [id, started] of this.since) {
      if (now - started >= this.dwellMs) due.push(id)
    }
    for (const id of due) {
      this.since.delete(id)
      this.done.add(id)
    }
    this.schedule()
    if (due.length > 0) this.onRead(due)
  }

  private schedule(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    if (this.disposed || !this.active || this.since.size === 0) return
    let earliest = Infinity
    for (const started of this.since.values()) earliest = Math.min(earliest, started)
    const wait = Math.max(0, earliest + this.dwellMs - this.clock.now())
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.flush()
    }, wait)
  }
}
