// Image reader contract shared by the main process and the renderer.
// The renderer never names a network address or a file path: it asks for the image of a post it
// has shown, and displays the managed file through the app's own image scheme.

import type { PostId } from './forum'

/** Thumbnail (`thumb/`) and original (`image/`) are different forum resources. */
export type ImageKind = 'thumb' | 'original'

/** Encoding detected from the file's own bytes, not from the forum extension or response MIME. */
export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp'

/** File extension used for a detected format (saving, managed file names). */
export const IMAGE_FORMAT_EXTENSION: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
  webp: 'webp'
}

/** Scheme of managed image files served to the renderer (`xidao-image://file/<name>`). */
export const IMAGE_SCHEME = 'xidao-image'

/**
 * Caller-generated ID of one reading view (a mounted reader); 1–64 chars of [A-Za-z0-9_-].
 * Images loaded for a view stay protected from cleanup until the view is released.
 */
export type ImageViewId = string

export interface LoadedImage {
  kind: ImageKind
  /** `xidao-image://file/<managed name>`; changes whenever the stored file is replaced. */
  url: string
  format: ImageFormat
  width: number
  height: number
  bytes: number
  /** ISO-8601 time the file was fetched from the image server. */
  fetchedAt: string
  /** `network`: fetched for this call; `stored`: an already stored managed file was reused. */
  source: 'network' | 'stored'
}

/**
 * Classified image failure. None of these claims the image was deleted by the forum: a missing
 * or replaced image has not been observed, only these transport/content facts.
 * - `no-image`: the post is not stored or has no image.
 * - `not-stored`: a local-only request found neither a usable cached image nor its original.
 * - `unsupported-source`: the stored image path is not a recognised forum image path.
 * - `network` / `timeout`: connection failed, ended early, or exceeded the time limit.
 * - `http-status`: a non-200 status (`httpStatus` carries it); `redirect`: a 3xx, never followed.
 * - `html`: the server returned an HTML page instead of an image.
 * - `not-image`: the bytes are not a supported image encoding (or its header is malformed).
 * - `too-large`: more bytes or pixels than the safety limit.
 * - `storage`: the managed file or its record could not be written; nothing was replaced.
 */
export type ImageErrorReason =
  | 'no-image'
  | 'not-stored'
  | 'unsupported-source'
  | 'network'
  | 'timeout'
  | 'http-status'
  | 'redirect'
  | 'html'
  | 'not-image'
  | 'too-large'
  | 'storage'

export interface ImageError {
  reason: ImageErrorReason
  httpStatus?: number
}

export type ImageLoadOutcome =
  | { status: 'ready'; image: LoadedImage }
  | { status: 'failed'; error: ImageError }
  /** The caller cancelled; the result must be ignored. */
  | { status: 'cancelled' }

/**
 * - `saved`: a copy of the stored original was written where the user chose.
 * - `cancelled`: the user dismissed the save dialog.
 * - `not-loaded`: no stored original exists for the post; a thumbnail is never saved instead.
 * - `failed`: the chosen file could not be written; an existing file there is left unchanged.
 */
export type ImageSaveOutcome =
  | { status: 'saved' }
  | { status: 'cancelled' }
  | { status: 'not-loaded' }
  | { status: 'failed' }

/** Copy never downloads or substitutes a thumbnail; file means the original animation encoding. */
export type ImageCopyOutcome =
  | { status: 'copied'; representation: 'image' | 'file' }
  | { status: 'not-loaded' | 'invalid-image' | 'busy' | 'failed' }

export interface ImageLoadRequest {
  operationId: string
  viewId: ImageViewId
  postId: PostId
  kind: ImageKind
  /**
   * Fetch again even when a stored file exists (manual retry after the renderer failed to decode
   * it). The stored file and record stay in place until the new file is committed.
   */
  refresh?: boolean
  /** Reuse only local files (including an original for a thumbnail); overrides refresh and never downloads. */
  localOnly?: boolean
}
