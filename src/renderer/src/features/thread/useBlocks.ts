import { useEffect, useSyncExternalStore } from 'react'
import type { BlockKind, LocalBlock } from '../../../../shared/blocks'
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'

const NO_BLOCKS: readonly LocalBlock[] = []
let blocks: readonly LocalBlock[] = []
let failure: string | null = null
let revision = 0
let loading: Promise<void> | null = null
let initialized = false
const listeners = new Set<() => void>()
const notify = () => { revision++; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function reloadBlocks() {
  loading ??= window.xidao.blocks.list().then((items) => { blocks = items; failure = null; initialized = true }, () => { failure = '屏蔽列表读取失败' }).finally(() => { loading = null; notify() })
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
  } catch { failure = '屏蔽设置未保存，请重试' }
  notify()
}

export function useBlocks() {
  useSyncExternalStore(subscribe, () => revision)
  useEffect(() => { if (PROTOTYPE_ENABLED && !initialized) void reloadBlocks() }, [])
  return { blocks: PROTOTYPE_ENABLED ? blocks : NO_BLOCKS, failure, reload: reloadBlocks, setBlocked }
}
