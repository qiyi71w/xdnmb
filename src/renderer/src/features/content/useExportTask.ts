import { useSyncExternalStore } from 'react'
import { exportTaskReducer, isBusy, type ExportTask, type ExportTaskEvent } from './exportState'

/*
 * The window's one export task. It lives outside React so that closing the export dialog or the
 * 设置 tab keeps it; progress events are taken from the first use on, for the window's lifetime.
 */

let task: ExportTask = { phase: 'idle' }
const listeners = new Set<() => void>()
let listening = false

function dispatch(event: ExportTaskEvent): void {
  const next = exportTaskReducer(task, event)
  if (next === task) return
  task = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  if (!listening) {
    listening = true
    window.xidao.personalData.onExportProgress((progress) => dispatch({ type: 'progress', progress }))
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useExportTask(): ExportTask {
  return useSyncExternalStore(subscribe, () => task)
}

export const exportTask = {
  dispatch,
  /** Save dialog, space check, start. Ignored while an export starts or runs. */
  async start(includeOffline: boolean): Promise<void> {
    if (isBusy(task)) return
    dispatch({ type: 'start' })
    const result = await window.xidao.personalData.startExport({ includeOffline }).catch(() => null)
    dispatch({ type: 'start-result', result })
  },
  async cancel(): Promise<void> {
    if (task.phase !== 'running' || task.cancelling) return
    dispatch({ type: 'cancel' })
    await window.xidao.personalData.cancelExport().catch(() => undefined)
  }
}
