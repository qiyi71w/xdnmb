import type { PublicationAttempt } from './publication'

/**
 * Window lifecycle shared by the main process and the renderer. One main process owns the database
 * and every forum write; the window is only its front end.
 *
 * - 后台驻留 hides the window. Editors, pages and the running app stay as they are; the tray
 *   (Windows/Linux) or the Dock (macOS) opens it again.
 * - 退出汐岛 is a real quit: the renderer first handles every unsaved editor and saves the workspace,
 *   then the window closes, the main process waits for sends that already started (never past
 *   their original deadline, never sending again) and the process ends.
 */

/** What the window's close button does. `ask`: show the choice every time. */
export type CloseAction = 'ask' | 'background' | 'quit'

export const CLOSE_ACTIONS: readonly CloseAction[] = ['ask', 'background', 'quit']

/** Main process → renderer. */
export type LifecycleRequest =
  /** The close button was pressed and the setting is `ask`: offer 后台驻留 / 退出汐岛. */
  | { kind: 'close' }
  /**
   * A real quit was requested (the close choice, the remembered setting, the tray or app menu).
   * The renderer handles unsaved editors and saves the workspace, then answers with `completeQuit`
   * or `cancelQuit`. Sent again if quit is requested again while it is still being handled.
   */
  | { kind: 'quit' }
  /**
   * The operating system is ending the session (shutdown, restart, log-off). The renderer saves
   * pending drafts and the workspace at once without asking anything; the system may end the process
   * at any moment, so nothing waits for an answer. Ignored while a real quit is being handled.
   */
  | { kind: 'session-end' }

/** Upper bound of the serialized workspace accepted over IPC (UTF-16 code units). */
export const MAX_WORKSPACE_LENGTH = 2_000_000

export type WorkspaceLoadResult = { ok: true; workspace: string | null } | { ok: false }

export type LaunchNoticesResult = { ok: true; attempts: PublicationAttempt[] } | { ok: false }

/**
 * Sends that ended while finishing a quit but whose result could not be written to storage. The
 * quit stopped for them and the window came back; each shows the result it should have recorded.
 */
export type UnstoredResults = { attempts: PublicationAttempt[] }

export interface LifecycleApi {
  /** Receives main-process requests; returns the unsubscribe function. */
  onRequest(listener: (request: LifecycleRequest) => void): () => void
  /** 后台驻留: hides the window. Nothing is saved or closed. */
  reside(): Promise<void>
  /** Starts a real quit; the renderer then receives `{ kind: 'quit' }`. */
  requestQuit(): Promise<void>
  /** While a quit is being handled: shows the window (also when resident) so its questions can be answered. */
  presentQuit(): Promise<void>
  /** The quit was cancelled or could not save; the app keeps running unchanged. */
  cancelQuit(): Promise<void>
  /**
   * The unsaved editors and the workspace were handled: the window closes and the main
   * process finishes sends that already started, then exits. Opening the app again before that
   * cancels the exit. `saved: false`: the user quit although some drafts or the workspace could not
   * be saved; no update is installed at this exit.
   */
  completeQuit(input: { saved: boolean }): Promise<void>
  /** The workspace saved at the last real quit, as written by `saveWorkspace`; `null` when none. */
  loadWorkspace(): Promise<WorkspaceLoadResult>
  /**
   * Replaces the saved workspace. `ok: false`: not saved (storage unavailable, read-only or failed).
   * `writable: false`: storage refuses every write for the rest of this run (read-only or
   * unavailable), so retrying cannot save it; the previously saved workspace stays as it was.
   */
  saveWorkspace(input: { workspace: string }): Promise<{ ok: boolean; writable: boolean }>
  /**
   * Sends whose result became failed or unknown while no window was open (finishing after a quit),
   * or that were found unfinished at startup. Each stays listed until dismissed.
   */
  listLaunchNotices(): Promise<LaunchNoticesResult>
  dismissLaunchNotices(input: { attemptIds: string[] }): Promise<{ ok: boolean }>
  /** Results that could not be stored while finishing the last quit; empty normally. */
  listUnstoredResults(): Promise<UnstoredResults>
  /**
   * Writes those results again (never sends anything). `ok: true`: all stored, nothing stops a quit
   * any more; `ok: false`: some are still not stored and stay listed.
   */
  retryUnstoredResults(): Promise<{ ok: boolean }>
}
