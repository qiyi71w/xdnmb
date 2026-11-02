import type { PostId } from '../../../../shared/forum'
import type { ImageCopyOutcome, ImageError, ImageSaveOutcome, ImageViewId, LoadedImage } from '../../../../shared/images'

/** Thumbnails start loading this far outside the scroller viewport (above and below). */
const NEAR_MARGIN = '800px 0px'

/**
 * One IntersectionObserver for every thumbnail of a view (reader or thread list), rooted at its
 * scroller. Created on first use, when the scroller is mounted.
 */
export class NearViewport {
  private observer: IntersectionObserver | null = null
  private readonly callbacks = new Map<Element, (near: boolean) => void>()
  private readonly root: () => Element | null

  constructor(root: () => Element | null) {
    this.root = root
  }

  observe(element: Element, onChange: (near: boolean) => void): () => void {
    this.observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) this.callbacks.get(entry.target)?.(entry.isIntersecting)
      },
      { root: this.root(), rootMargin: NEAR_MARGIN }
    )
    this.callbacks.set(element, onChange)
    this.observer.observe(element)
    return () => {
      this.callbacks.delete(element)
      this.observer?.unobserve(element)
    }
  }

  disconnect(): void {
    this.observer?.disconnect()
    this.observer = null
    this.callbacks.clear()
  }
}

export interface ViewerRequest {
  postId: PostId
  /** The decoded thumbnail the opener shows, if any; shown while the original loads or failed. */
  thumb: LoadedImage | null
  /** Receives focus back when the viewer closes. */
  trigger: HTMLElement
}

/** Where images of one mounted view load: its view ID and lazy-load observer. */
export interface ImageScope {
  viewId: ImageViewId
  near: NearViewport
  /**
   * List thumbnails show only images already on this machine and never download (历史, 离线).
   * The viewer opened from them still fetches the original.
   */
  localOnly?: boolean
}

/** Images of one mounted reader or thread list: its scope and the viewer it owns. */
export interface ImageView extends ImageScope {
  openViewer: (request: ViewerRequest) => void
}

const REASON_TEXT: Record<ImageError['reason'], string> = {
  'no-image': '本机没有这条发言的图片信息',
  'not-stored': '本机没有保存这张图片',
  'unsupported-source': '图片地址无法识别',
  network: '网络失败',
  timeout: '网络超时',
  'http-status': '服务器返回错误状态',
  redirect: '服务器要求跳转，未跟随',
  html: '服务器返回网页而不是图片',
  'not-image': '内容不是可识别的图片',
  'too-large': '图片超过安全上限',
  storage: '无法保存到本机'
}

/**
 * Reason of an image failure. States only what was observed (a status, a page, the bytes); never
 * that the forum deleted the image. `null` is the IPC call itself failing.
 */
export function describeImageError(error: ImageError | null): string {
  if (error === null) return '应用内部请求失败'
  if (error.reason === 'http-status' && error.httpStatus !== undefined) return `服务器返回 HTTP ${error.httpStatus}`
  return REASON_TEXT[error.reason]
}

export const UNDECODABLE_TEXT = '已取得的文件无法解码显示'

export const SAVE_TEXT: Record<ImageSaveOutcome['status'], string> = {
  saved: '已保存原图',
  cancelled: '已取消保存',
  'not-loaded': '原图尚未取得，未保存',
  failed: '保存失败，未改动已有文件'
}

/** A copy's result: how the original went onto the clipboard, or why it did not. */
type CopyResult =
  | Extract<ImageCopyOutcome, { status: 'copied' }>['representation']
  | Exclude<ImageCopyOutcome, { status: 'copied' }>['status']

/**
 * `image`: the whole decoded still image. `file`: an animation as its original encoded file, which a
 * receiving app may take as an attachment. Every other result put nothing new on the clipboard.
 */
export const COPY_TEXT: Record<CopyResult, string> = {
  image: '已复制原图',
  file: '已复制动图原文件',
  'not-loaded': '原图尚未取得，未复制',
  'invalid-image': '原图文件校验未通过，未复制',
  busy: '剪贴板操作进行中，未复制，请稍后再试',
  failed: '复制失败，未能写入剪贴板'
}

export function describeCopyOutcome(outcome: ImageCopyOutcome): string {
  return COPY_TEXT[outcome.status === 'copied' ? outcome.representation : outcome.status]
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
