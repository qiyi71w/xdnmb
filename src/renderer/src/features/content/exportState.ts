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
  /**
   * What the main process reports running now (from the estimate). Only a window that has not
   * heard how an export ended takes a running one up: idle, or refused as busy by one it missed.
   */
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
      if (event.running !== null) {
        // A finished outcome this window heard stays: a running report can only predate it.
        const unseen = task.phase === 'idle' || (task.phase === 'failed' && task.failure.reason === 'busy')
        return unseen ? { phase: 'running', writtenBytes: event.running.writtenBytes, totalBytes: event.running.totalBytes, cancelling: false } : task
      }
      // Nothing runs any more: an outcome this window did not hear about.
      return task.phase === 'running' ? IDLE : task
    case 'dismiss':
      return isBusy(task) ? task : IDLE
  }
}

/** The 离线副本 choice: shown only when there are offline copies; on by default. */
export function offlineChoiceText(offline: { threads: number; bytes: number }): string {
  return `离线副本（${offline.threads} 个串，约 ${formatBytes(offline.bytes)}）`
}

/**
 * The 饼干与 App UUID choice (off by default) and its 导出口令, typed twice. `edited`: either
 * field has been typed in since the fields were last empty and untouched.
 */
export interface SecretsChoice {
  include: boolean
  passphrase: string
  confirmation: string
  edited: boolean
}

export const NO_SECRETS: SecretsChoice = { include: false, passphrase: '', confirmation: '', edited: false }

/** Typing in a passphrase field. */
export function editSecrets(choice: SecretsChoice, typed: { passphrase: string } | { confirmation: string }): SecretsChoice {
  return { ...choice, ...typed, edited: true }
}

/** Once the export has the passphrase: both fields empty again, as if never typed in. */
export function clearedSecrets(choice: SecretsChoice): SecretsChoice {
  return { ...choice, passphrase: '', confirmation: '', edited: false }
}

export const EMPTY_PASSPHRASE_TEXT = '口令不能为空'

/**
 * The passphrase fields. `ready`: 导出… may start with this choice (without secrets always; with
 * them only for a non-empty passphrase typed the same twice, of any length and strength).
 * `mismatch`: the second entry, once typed, differs; said beside it. `empty`: once a field has been
 * typed in, the passphrase is empty; said beside the first field (not on the form just ticked).
 */
export function secretsState(choice: SecretsChoice): { ready: boolean; mismatch: boolean; empty: boolean } {
  if (!choice.include) return { ready: true, mismatch: false, empty: false }
  return {
    ready: choice.passphrase.length > 0 && choice.passphrase === choice.confirmation,
    mismatch: choice.confirmation.length > 0 && choice.confirmation !== choice.passphrase,
    empty: choice.edited && choice.passphrase.length === 0
  }
}

/** What 导出… sends for this choice: the passphrase, or null without secrets. */
export function exportPassphrase(choice: SecretsChoice): string | null {
  return choice.include ? choice.passphrase : null
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
    case 'secrets': return '导出失败：本机的饼干或 App UUID 无法解密'
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
