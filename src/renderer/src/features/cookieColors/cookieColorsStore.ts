// 饼干标色 in the renderer: one shared copy of the stored colors, read once and updated in place
// after each saved change, so every shown 饼干 ID follows a change at once.

import { useEffect, useSyncExternalStore } from 'react'
import type { CookieColor, CookieColorName } from '../../../../shared/cookieColors'

/** Oldest first (添加时间), as stored. */
let entries: readonly CookieColor[] = []
let colors: ReadonlyMap<string, CookieColorName> = new Map()
let failure: string | null = null
/** The write behind `failure`, kept so 重试 re-sends it; null when the failure was a read. */
let failedWrite: { cookieId: string; color: CookieColorName | null } | null = null
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
 * Reads the stored colors again. Called after identity changes that may have given a 饼干 ID the
 * default color in the main process (imports, a filled or changed 饼干 ID).
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

/**
 * Colors `cookieId` (an already colored ID keeps its place and changes color), or clears it with
 * `null`. `cookieId` must already pass `validateCookieId` (trimmed). Resolves whether it was saved.
 */
export async function setCookieColor(cookieId: string, color: CookieColorName | null): Promise<boolean> {
  try {
    const result = await window.xidao.cookieColors.set({ cookieId, color })
    if (!result.saved) throw new Error('not saved')
    if (color === null) adopt(entries.filter((entry) => entry.cookieId !== cookieId))
    else if (colors.has(cookieId)) adopt(entries.map((entry) => (entry.cookieId === cookieId ? { ...entry, color } : entry)))
    else adopt([...entries, { cookieId, color, createdAt: new Date().toISOString() }])
    failure = null
    failedWrite = null
    // A read still on its way began before this write: read again rather than apply it.
    if (loading !== null) void reloadCookieColors()
    notify()
    return true
  } catch {
    failure = '饼干颜色未保存'
    failedWrite = { cookieId, color }
    notify()
    return false
  }
}

/** 重试 for the shown failure: re-send the failed write, or read the list again after a failed read. */
export function retryCookieColors(): Promise<unknown> {
  return failedWrite === null ? reloadCookieColors() : setCookieColor(failedWrite.cookieId, failedWrite.color)
}

/** The stored color of one 饼干 ID (undefined when it has none); re-renders only when that changes. */
export function useCookieColor(cookieId: string): CookieColorName | undefined {
  const color = useSyncExternalStore(subscribe, () => colors.get(cookieId))
  useEffect(ensureLoaded, [])
  return color
}

/** Every colored 饼干 ID with the read/write state, for managing them. */
export function useCookieColors() {
  useSyncExternalStore(subscribe, () => revision)
  useEffect(ensureLoaded, [])
  return { entries, colors, loaded, failure, retry: retryCookieColors, set: setCookieColor }
}
