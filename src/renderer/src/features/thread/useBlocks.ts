import { useEffect, useSyncExternalStore } from 'react'
import type { BlockKind, LocalBlock } from '../../../../shared/blocks'

let blocks: readonly LocalBlock[] = []
let failure: string | null = null
/** The block write behind `failure`, kept so 重试 re-sends it; null when the failure was a read. */
let failedWrite: { kind: BlockKind; value: string; blocked: boolean } | null = null
let revision = 0
let loading: Promise<void> | null = null
let initialized = false
const listeners = new Set<() => void>()
const notify = () => { revision++; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

function reloadBlocks() {
  loading ??= window.xidao.blocks.list().then((items) => { blocks = items; failure = null; initialized = true }, () => { failure = '屏蔽列表读取失败' }).finally(() => { failedWrite = null; loading = null; notify() })
  return loading
}

export async function setBlocked(kind: BlockKind, value: string, blocked: boolean) {
  try {
    if (loading !== null) await loading
    const result = await window.xidao.blocks.set({ kind, value, blocked })
    if (!result.saved) throw new Error('not saved')
    blocks = blocks.filter((item) => item.kind !== kind || item.value !== value)
    if (blocked) blocks = [{ kind, value, createdAt: new Date().toISOString() }, ...blocks]
    failure = null
    failedWrite = null
  } catch {
    failure = '屏蔽未保存'
    failedWrite = { kind, value, blocked }
  }
  notify()
}

/** 重试 for the shown failure: re-send the failed block write, or read the list again after a failed read. */
export function retryBlocks(): Promise<void> {
  return failedWrite === null ? reloadBlocks() : setBlocked(failedWrite.kind, failedWrite.value, failedWrite.blocked)
}

export function useBlocks() {
  useSyncExternalStore(subscribe, () => revision)
  useEffect(() => { if (!initialized) void reloadBlocks() }, [])
  return { blocks, failure, retry: retryBlocks, setBlocked }
}
