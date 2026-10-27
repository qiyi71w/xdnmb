/**
 * Software updates. The source is fixed at build time to the stable GitHub Releases of
 * `qiyi71w/xdnmb`; there is no other source and nothing the user can point elsewhere.
 *
 * - Windows downloads the NSIS installer and installs it only when the user really quits (with
 *   「退出时自动安装更新」, after every editor, the workspace and started sends are settled) or
 *   through 「安装并重启」, which goes through the same quit. Hiding to the tray, a system
 *   shutdown/restart or a cancelled quit never installs.
 * - macOS downloads the DMG for the running architecture; the user opens it and replaces the app.
 *   Opening it is not an upgrade: only the version actually running counts.
 */

export const UPDATE_REPOSITORY_URL = 'https://github.com/qiyi71w/xdnmb'
export const UPDATE_AUTHOR_URL = 'https://github.com/qiyi71w'

/** Automatic checks run at cold start and then every 24 hours while the app runs (also in the tray). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Network used by update checks and package downloads only; forum, images, search and login are unaffected. */
export type UpdateNetwork = 'system' | 'direct'
export const UPDATE_NETWORKS: readonly UpdateNetwork[] = ['system', 'direct']

/** How this build installs a newer release. */
export type UpdatePlatform = 'windows' | 'mac' | 'none'

/**
 * Why this build cannot update itself:
 * - `not-installed`: not an installed build (unpacked trial copy or development run);
 * - `platform`: the operating system has no update path (Linux).
 */
export type UpdateUnavailable = 'not-installed' | 'platform'

/** Release-notes text. Links are absolute `https:` URLs; nothing here is HTML. */
export type NoteInline =
  | { kind: 'text'; text: string; strong?: true; emphasis?: true; code?: true }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'break' }

/** One release-notes block; list items carry a nesting depth (0 = top level). */
export type NoteBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; content: NoteInline[] }
  | { kind: 'paragraph'; content: NoteInline[] }
  | { kind: 'list'; ordered: boolean; items: { depth: 0 | 1 | 2; content: NoteInline[] }[] }
  | { kind: 'code'; text: string }

export interface ReleaseInfo {
  /** Strict `major.minor.patch`, newer than the running version. */
  version: string
  /** ISO time from the release metadata; `null` when absent or invalid. */
  releaseDate: string | null
  /** The release's own notes; empty when it has none (never generated text). */
  notes: NoteBlock[]
  /** The release page, always under `UPDATE_REPOSITORY_URL`. */
  pageUrl: string
}

/**
 * - `network`: GitHub could not be reached (offline, timeout, proxy refused, server error);
 * - `source`: no usable release metadata for this system, or a request left the allowed addresses;
 * - `integrity`: the downloaded file does not match the release's checksum (it is discarded);
 * - `storage`: the package could not be written or read locally (disk full, permission);
 * - `install`: the installer / DMG could not be started or opened.
 */
export type UpdateFailure = 'network' | 'source' | 'integrity' | 'storage' | 'install'

export type UpdateDownload =
  /** Not downloaded. `failure`: the last attempt failed; `cancelled`: the user cancelled the last attempt. */
  | { status: 'none'; failure: UpdateFailure | null; cancelled: boolean }
  /** `total` is null when the size is unknown. */
  | { status: 'downloading'; transferred: number; total: number | null }
  /** Bytes received; the checksum is being confirmed. Nothing can be installed or opened yet. */
  | { status: 'verifying' }
  /** A verified package is on disk (kept across restarts until installed or superseded). */
  | { status: 'ready' }

export interface UpdateCheckResult {
  /** ISO time the check finished. */
  at: string
  outcome: 'up-to-date' | 'available' | 'failed'
  failure: UpdateFailure | null
}

/** Everything the About section shows. Pushed to the renderer on every change. */
export interface UpdateState {
  /** `app.getVersion()` of the running app. */
  currentVersion: string
  platform: UpdatePlatform
  /** Non-null: this build cannot check or install updates; `release` is then always null. */
  unavailable: UpdateUnavailable | null
  /** A check is running (automatic or manual); another one cannot start. */
  checking: boolean
  /** The last finished check of this run; `null` before the first one. */
  lastCheck: UpdateCheckResult | null
  /** The newest known release newer than the running version; `null` when none is known. */
  release: { info: ReleaseInfo; download: UpdateDownload } | null
  /** Windows: the ready package will be installed when the user quits (setting on, package ready). */
  installOnQuit: boolean
  /**
   * A one-time in-app notice owed for `release`: `available` when a version is found for the first
   * time, `ready` at launch when a downloaded package is still waiting. Cleared by `acknowledgeNotice`.
   */
  notice: { version: string; kind: 'available' | 'ready' } | null
}

export type InstallResult = { started: true } | { started: false; failure: UpdateFailure | 'not-ready' }

export interface UpdatesApi {
  getState(): Promise<UpdateState>
  /** Every state change; returns the unsubscribe function. */
  onState(listener: (state: UpdateState) => void): () => void
  /** Manual 「检查更新」. Does nothing while a check, download or verification is running. */
  check(): Promise<void>
  /** 「下载更新」 / 「重试」 for the known release. Does nothing when already downloading or ready. */
  download(): Promise<void>
  /** 「取消下载」. The partial file is discarded; automatic download does not restart it in this run. */
  cancelDownload(): Promise<void>
  /**
   * Windows 「安装并重启」: confirms the package, then starts a real quit; once every editor, the
   * workspace and started sends are settled the installer runs and reopens the app. A cancelled or
   * failed quit, or reopening the app while finishing, installs nothing and keeps the package.
   */
  installAndRestart(): Promise<InstallResult>
  /** macOS 「打开安装包」: confirms the DMG and opens it. Not an upgrade. */
  openInstaller(): Promise<InstallResult>
  /** The notice for `version` was shown and dismissed or acted on. */
  acknowledgeNotice(input: { version: string }): Promise<void>
}

export const UPDATE_STATE_CHANNEL = 'updates:state'
