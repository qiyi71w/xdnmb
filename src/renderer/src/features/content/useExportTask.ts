import { useSyncExternalStore } from 'react'
import type { ExportEstimate, ExportOptions } from '../../../../shared/api'
import { exportTaskReducer, isBusy, type ExportTask, type ExportTaskEvent } from './exportState'

/*
 * The window's one export task. It lives outside React so that closing the export dialog or the
 * 设置 tab keeps it; progress events are taken from the first use on, for the window's lifetime.
 */

let task: ExportTask = { phase: 'idle' }
const listeners = new Set<() => void>()
let listening = false
/** Outcomes heard so far; an estimate asked for before the latest one is older than it. */
let outcomes = 0

function dispatch(event: ExportTaskEvent): void {
  if (event.type === 'progress' && event.progress.status !== 'running') outcomes++
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
  /**
   * Reads the estimate; null while unknown (the IPC call failed). Also tells the task what runs
   * now, unless an outcome was heard while it was read (what it says running has ended since).
   */
  async estimate(): Promise<ExportEstimate | null> {
    const heard = outcomes
    let estimate: ExportEstimate
    try {
      estimate = await window.xidao.personalData.exportEstimate()
    } catch {
      return null
    }
    if (estimate.available && outcomes === heard) dispatch({ type: 'sync', running: estimate.running })
    return estimate
  },
  /**
   * Save dialog, space check, start. Ignored while an export starts or runs. Resolves whether the
   * export started (the passphrase then lives only in the main process).
   */
  async start(options: ExportOptions): Promise<boolean> {
    if (isBusy(task)) return false
    dispatch({ type: 'start' })
    const result = await window.xidao.personalData.startExport(options).catch(() => null)
    dispatch({ type: 'start-result', result })
    return result?.status === 'started'
  },
  async cancel(): Promise<void> {
    if (task.phase !== 'running' || task.cancelling) return
    dispatch({ type: 'cancel' })
    await window.xidao.personalData.cancelExport().catch(() => undefined)
  }
}
