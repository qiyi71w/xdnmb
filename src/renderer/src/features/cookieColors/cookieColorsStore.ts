// 饼干颜色 in the renderer: one shared copy of the listed 饼干 IDs, read once and updated in place
// after each saved change, so every shown 饼干 ID follows a change at once.

import { useEffect, useSyncExternalStore } from 'react'
import type { CookieColor, CookieColorName } from '../../../../shared/cookieColors'

type CookieColorWrite =
  | { kind: 'add'; cookieId: string }
  | { kind: 'set'; cookieId: string; color: CookieColorName | null }
  | { kind: 'remove'; cookieId: string }

const FAILURE_TEXT: Record<CookieColorWrite['kind'], string> = {
  add: '饼干 ID 未添加',
  set: '饼干颜色未保存',
  remove: '饼干 ID 未删除'
}

/** Oldest first (添加时间), as stored. */
let entries: readonly CookieColor[] = []
/** Listed IDs: a palette color, or null for 默认. */
let colors: ReadonlyMap<string, CookieColorName | null> = new Map()
let failure: string | null = null
/** The write behind `failure`, kept so 重试 re-sends it; null when the failure was a read. */
let failedWrite: CookieColorWrite | null = null
let loading: Promise<void> | null = null
/** Whether the first read has begun; after a failed read, 重试 or the next reload reads again. */
let started = false
/** Whether a read has succeeded (until then an empty list is not known to be empty). */
let loaded = false
/** Only the latest read is applied: a read started before a write or a later read is stale. */
let readSeq = 0
let revision = 0
const listeners = new Set<() => void>()
const notify = () => {
  revision++
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function adopt(next: readonly CookieColor[]) {
  entries = next
  colors = new Map(next.map((entry) => [entry.cookieId, entry.color]))
}

/**
 * Reads the listed 饼干 IDs again. Called after identity changes that may have given a 饼干 ID the
 * imported color in the main process (imports, a filled or changed 饼干 ID).
 */
export function reloadCookieColors(): Promise<void> {
  started = true
  const seq = ++readSeq
  const read: Promise<void> = window.xidao.cookieColors
    .list()
    .then(
      (items) => {
        if (seq !== readSeq) return
        adopt(items)
        failure = null
        loaded = true
      },
      () => {
        if (seq === readSeq) failure = '饼干颜色读取失败'
      }
    )
    .finally(() => {
      if (seq === readSeq) failedWrite = null
      if (loading === read) loading = null
      notify()
    })
  loading = read
  return read
}

function ensureLoaded() {
  if (!started) void reloadCookieColors()
}

/** Applies a saved write to the shared copy. */
function applied(write: CookieColorWrite, added: boolean) {
  const { cookieId } = write
  if (write.kind === 'remove') adopt(entries.filter((entry) => entry.cookieId !== cookieId))
  else if (colors.has(cookieId)) {
    if (write.kind === 'set') adopt(entries.map((entry) => (entry.cookieId === cookieId ? { ...entry, color: write.color } : entry)))
  } else if (write.kind === 'set' || added) {
    adopt([...entries, { cookieId, color: write.kind === 'set' ? write.color : null, createdAt: new Date().toISOString() }])
  }
}

/** Sends one write; resolves whether it was saved and, for 添加, whether the ID was new. */
async function send(write: CookieColorWrite): Promise<{ saved: boolean; added: boolean }> {
  try {
    let added = false
    if (write.kind === 'add') {
      const result = await window.xidao.cookieColors.add({ cookieId: write.cookieId })
      if (!result.saved) throw new Error('not saved')
      added = result.added
    } else {
      const result = write.kind === 'set'
        ? await window.xidao.cookieColors.set({ cookieId: write.cookieId, color: write.color })
        : await window.xidao.cookieColors.remove({ cookieId: write.cookieId })
      if (!result.saved) throw new Error('not saved')
    }
    applied(write, added)
    failure = null
    failedWrite = null
    // A read still on its way began before this write, or this copy did not know the ID 添加 found
    // already listed: read again rather than guess.
    if (loading !== null || (write.kind === 'add' && !added && !colors.has(write.cookieId))) void reloadCookieColors()
    notify()
    return { saved: true, added }
  } catch {
    failure = FAILURE_TEXT[write.kind]
    failedWrite = write
    notify()
    return { saved: false, added: false }
  }
}

/**
 * Lists `cookieId` in 默认. An ID already listed keeps its color and place (`added` false).
 * `cookieId` must already pass `validateCookieId` (trimmed).
 */
export function addCookieId(cookieId: string): Promise<{ saved: boolean; added: boolean }> {
  return send({ kind: 'add', cookieId })
}

/**
 * Gives `cookieId` a palette color, or 默认 with `null`; a listed ID keeps its place, an unlisted
 * one is added. Resolves whether it was saved.
 */
export async function setCookieColor(cookieId: string, color: CookieColorName | null): Promise<boolean> {
  return (await send({ kind: 'set', cookieId, color })).saved
}

/** Takes `cookieId` off the list; resolves whether it was saved. */
export async function removeCookieId(cookieId: string): Promise<boolean> {
  return (await send({ kind: 'remove', cookieId })).saved
}

/** 重试 for the shown failure: re-send the failed write, or read the list again after a failed read. */
export function retryCookieColors(): Promise<unknown> {
  return failedWrite === null ? reloadCookieColors() : send(failedWrite)
}

/**
 * How one 饼干 ID is shown: its palette color, null for 默认, undefined when it is not listed (also
 * shown in 默认). Re-renders only when that changes.
 */
export function useCookieColor(cookieId: string): CookieColorName | null | undefined {
  const color = useSyncExternalStore(subscribe, () => colors.get(cookieId))
  useEffect(ensureLoaded, [])
  return color
}

/** Every listed 饼干 ID with the read/write state, for managing them. */
export function useCookieColors() {
  useSyncExternalStore(subscribe, () => revision)
  useEffect(ensureLoaded, [])
  return { entries, loaded, failure, retry: retryCookieColors, add: addCookieId, set: setCookieColor, remove: removeCookieId }
}
