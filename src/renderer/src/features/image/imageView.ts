import type { PostId } from '../../../../shared/forum'
import type { ImageError, ImageSaveOutcome, ImageViewId, LoadedImage } from '../../../../shared/images'

/** Thumbnails start loading this far outside the reader viewport (above and below). */
const NEAR_MARGIN = '800px 0px'

/**
 * One IntersectionObserver for every thumbnail of a reader, rooted at the reader scroller.
 * Created on first use, when the scroller is mounted.
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

/** Images of one mounted reader: its view ID, lazy-load observer and the viewer it owns. */
export interface ImageView {
  viewId: ImageViewId
  near: NearViewport
  openViewer: (request: ViewerRequest) => void
}

const REASON_TEXT: Record<ImageError['reason'], string> = {
  'no-image': '本机没有这条发言的图片信息',
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
