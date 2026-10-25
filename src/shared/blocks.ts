import type { Post } from './forum'

export type BlockKind = 'post' | 'cookie'
export interface LocalBlock { kind: BlockKind; value: string; createdAt: string }
export interface BlocksApi {
  list(): Promise<LocalBlock[]>
  set(input: { kind: BlockKind; value: string; blocked: boolean }): Promise<{ saved: boolean }>
}

export function isPostBlocked(post: Pick<Post, 'id' | 'userHash'>, blocks: readonly LocalBlock[]): boolean {
  return blocks.some((block) => block.kind === 'post' ? block.value === post.id : post.userHash !== null && block.value === post.userHash)
}
