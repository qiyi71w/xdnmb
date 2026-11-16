import type { ExportEstimate, ExportFailure, ExportProgress, ExportRunning, ExportStartResult } from '../../../../shared/api'
import { formatBytes } from './contentText'

/*
 * 导出个人数据 as the renderer sees it: one export task for the window (it outlives the dialog and
 * the 设置 tab: closing the dialog while it runs leaves its progress in 存储与缓存), and the
 * dialog's own choice. Pure; `useExportTask` holds the task state.
 */

export type ExportTask =
  | { phase: 'idle' }
  /** 导出… pressed: the save dialog and the disk space check. */
  | { phase: 'starting' }
  | { phase: 'running'; writtenBytes: number; totalBytes: number; cancelling: boolean }
  | { phase: 'done'; fileName: string }
  | { phase: 'failed'; failure: ExportFailure }
  | { phase: 'cancelled' }

export type ExportTaskEvent =
  | { type: 'start' }
  | { type: 'start-result'; result: ExportStartResult | null }
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'cancel' }
  /** What the main process reports running now (from the estimate). */
  | { type: 'sync'; running: ExportRunning | null }
  /** A finished outcome was seen and is put away (settings left, dialog reopened). */
  | { type: 'dismiss' }

const IDLE: ExportTask = { phase: 'idle' }

export function isBusy(task: ExportTask): boolean {
  return task.phase === 'starting' || task.phase === 'running'
}

export function exportTaskReducer(task: ExportTask, event: ExportTaskEvent): ExportTask {
  switch (event.type) {
    case 'start':
      return isBusy(task) ? task : { phase: 'starting' }
    case 'start-result': {
      if (task.phase !== 'starting') return task
      const result = event.result
      if (result === null) return { phase: 'failed', failure: { reason: 'read' } }
      if (result.status === 'dismissed') return IDLE
      if (result.status === 'failed') return { phase: 'failed', failure: result.failure }
      return { phase: 'running', writtenBytes: 0, totalBytes: 0, cancelling: false }
    }
    case 'progress': {
      const progress = event.progress
      if (progress.status === 'running') {
        return { phase: 'running', writtenBytes: progress.writtenBytes, totalBytes: progress.totalBytes, cancelling: task.phase === 'running' && task.cancelling }
      }
      if (progress.status === 'done') return { phase: 'done', fileName: progress.fileName }
      if (progress.status === 'failed') return { phase: 'failed', failure: progress.failure }
      return { phase: 'cancelled' }
    }
    case 'cancel':
      return task.phase === 'running' && !task.cancelling ? { ...task, cancelling: true } : task
    case 'sync':
      if (event.running !== null && !isBusy(task)) {
        return { phase: 'running', writtenBytes: event.running.writtenBytes, totalBytes: event.running.totalBytes, cancelling: false }
      }
      // Nothing runs any more: an outcome this window did not hear about.
      return event.running === null && task.phase === 'running' ? IDLE : task
    case 'dismiss':
      return isBusy(task) ? task : IDLE
  }
}

/** The 离线副本 choice: shown only when there are offline copies; on by default. */
export function offlineChoiceText(offline: { threads: number; bytes: number }): string {
  return `离线副本（${offline.threads} 个串，约 ${formatBytes(offline.bytes)}）`
}

/** Why the entry is unavailable; null when exporting is possible. */
export function unavailableText(estimate: ExportEstimate | null): string | null {
  if (estimate === null || estimate.available) return null
  return estimate.reason === 'read-only' ? '当前数据库只读，不能导出或导入' : '存储不可用，不能导出或导入'
}

export function exportFailureText(failure: ExportFailure): string {
  switch (failure.reason) {
    case 'space': return `导出失败：磁盘空间不足，还需约 ${formatBytes(failure.shortBytes)}`
    case 'sending': return '导出失败：有发言正在发送，完成后再导出'
    case 'storage': return '导出失败：存储当前不能写入'
    case 'busy': return '导出失败：已有导出正在进行'
    case 'read': return '导出失败：读取本机数据时出错'
    case 'write': return '导出失败：无法写入所选位置'
  }
}

/** `正在导出 1.2 MB / 40 MB`; before the size is known, `正在导出`. */
export function exportProgressText(task: Extract<ExportTask, { phase: 'running' }>): string {
  return task.totalBytes === 0 ? '正在导出' : `正在导出 ${formatBytes(task.writtenBytes)} / ${formatBytes(task.totalBytes)}`
}

/** Whole percent written, for the progress bar; null before the size is known. */
export function exportPercent(task: Extract<ExportTask, { phase: 'running' }>): number | null {
  return task.totalBytes === 0 ? null : Math.min(100, Math.floor((task.writtenBytes / task.totalBytes) * 100))
}
