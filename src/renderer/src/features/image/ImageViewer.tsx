import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { PostId } from '../../../../shared/forum'
import type { ImageViewId, LoadedImage } from '../../../../shared/images'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Notices'
import { openLayer } from '../../lib/layers'
import { describeImageError, formatBytes, SAVE_TEXT, UNDECODABLE_TEXT } from './imageView'
import { useImageZoom, ZoomControls, type Size } from './imageZoom'
import { useImageLoad } from './useImageLoad'
import './image.css'

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Viewer of one post image over the reader or thread list that opened it (modal within that view). Fetches the
 * original on open and shows the thumbnail meanwhile; a failed original keeps the thumbnail with the
 * reason and a manual 重试. Zoom and pan by toolbar, wheel, drag and keys; saving is possible only
 * once the original is shown, and always saves the stored original. Unmounting cancels the load.
 */
export function ImageViewer({
  viewId,
  postId,
  initialThumb,
  displayed,
  onClose
}: {
  viewId: ImageViewId
  postId: PostId
  initialThumb: LoadedImage | null
  /** The opening view is displayed (its tab active, its pane shown). */
  displayed: boolean
  onClose: () => void
}) {
  const original = useImageLoad(viewId, postId, 'original')
  const thumbLoad = useImageLoad(viewId, postId, 'thumb')
  const titleId = useId()
  const hintId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  /** “原图尚未取得” no longer holds once the original is shown or fetched again; other outcomes stay. */
  const clearNotLoaded = () => setSaveMessage((message) => (message === SAVE_TEXT['not-loaded'] ? null : message))
  const mounted = useRef(true)

  const { load: loadOriginal } = original
  const { load: loadThumb } = thumbLoad
  useEffect(() => {
    mounted.current = true
    loadOriginal()
    if (initialThumb === null) loadThumb()
    return () => {
      mounted.current = false
    }
  }, [loadOriginal, loadThumb, initialThumb])

  // One closable layer above the quote card that may still be pinned beside the covered reader:
  // Esc closes the viewer first, the card with the next Esc.
  useEffect(() => openLayer().release, [])

  const thumb =
    initialThumb ?? (thumbLoad.state.status === 'ready' && thumbLoad.state.decoded ? thumbLoad.state.image : null)
  /** The viewer's own thumbnail request (the opener had none decoded), loaded but not yet decoded. */
  const thumbProbeUrl =
    initialThumb === null && thumbLoad.state.status === 'ready' && !thumbLoad.state.decoded ? thumbLoad.state.image.url : null
  const originalState = original.state
  const originalImage = originalState.status === 'ready' ? originalState.image : null
  const originalShown = originalState.status === 'ready' && originalState.decoded && natural !== null
  const view = useImageZoom(dialogRef, natural, originalShown)
  const { stageRef } = view

  // Focus moves into the viewer when it opens. Afterwards, whenever focus that was inside falls to
  // the body — the focused control unmounted (重试 once the original loads), or the reader was hidden
  // with its tab and shown again — it returns to the stage, so the viewer keys keep working. Focus
  // the user moved to another control outside (e.g. the tab bar) stays there.
  const focusedOnce = useRef(false)
  const focusInside = useRef(false)
  useLayoutEffect(() => {
    if (!displayed) return
    const active = document.activeElement
    if (!focusedOnce.current || (focusInside.current && (active === null || active === document.body))) {
      focusedOnce.current = true
      stageRef.current?.focus({ preventScroll: true })
    }
  })

  const save = async () => {
    if (saving) return
    if (!originalShown) {
      setSaveMessage(SAVE_TEXT['not-loaded'])
      return
    }
    setSaving(true)
    setSaveMessage(null)
    let message: string
    try {
      message = SAVE_TEXT[(await window.xidao.images.saveOriginal({ postId })).status]
    } catch {
      message = '保存失败：应用内部请求失败'
    }
    if (!mounted.current) return
    setSaving(false)
    setSaveMessage(message)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    const { key } = event
    const command = event.ctrlKey || event.metaKey
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (key === 'Escape') {
      handled()
      onClose()
      return
    }
    if (command && !event.altKey && !event.shiftKey && (key.toLowerCase() === 's' || event.code === 'KeyS')) {
      handled()
      void save()
      return
    }
    if (key === 'Tab' && !command && !event.altKey) {
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      const first = items[0]
      const last = items[items.length - 1]
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        handled()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        handled()
        first.focus()
      }
      return
    }
    // Plain keys only: modified ones stay with the app (Alt+←/→ history, Ctrl+Tab, …).
    if (command || event.altKey) return
    view.onZoomKey(event)
  }

  let status: ReactNode = null
  if (originalState.status === 'idle' || originalState.status === 'loading' || (originalState.status === 'ready' && !originalShown)) {
    status = <Loading live={false}>{thumb === null ? '正在取得原图…' : '正在取得原图，当前显示缩略图…'}</Loading>
  } else if (originalState.status === 'failed' || originalState.status === 'undecodable') {
    const reason =
      originalState.status === 'failed' ? `原图未取得：${describeImageError(originalState.error)}` : `原图无法显示：${UNDECODABLE_TEXT}`
    status = (
      <>
        <p className="image-viewer-error">
          <Icon name="alert" size={14} />
          <span>
            {reason}
            {thumb !== null && '。当前显示的是缩略图'}
          </span>
        </p>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            // This button unmounts as the retry starts: keep focus in the viewer.
            stageRef.current?.focus({ preventScroll: true })
            original.retry()
            clearNotLoaded()
          }}
        >
          <Icon name="refresh" size={14} />
          重试
        </button>
      </>
    )
  } else if (originalImage !== null && natural !== null) {
    status = (
      <p className="image-viewer-info">
        原图 {natural.w}×{natural.h} · {originalImage.format.toUpperCase()} · {formatBytes(originalImage.bytes)}
      </p>
    )
  }

  return (
    <div
      ref={dialogRef}
      className="image-viewer"
      // Colours the window's title-bar controls whenever it reaches them (useAppearance).
      data-titlebar-cover=""
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      onKeyDown={onKeyDown}
      onFocus={() => (focusInside.current = true)}
      onBlur={(event) => {
        // A null target is focus falling to the body (unmounted control, hidden tab, window
        // switch): still the viewer's focus. Only a real control outside takes it away.
        const next = event.relatedTarget as Node | null
        if (next !== null && !event.currentTarget.contains(next)) focusInside.current = false
      }}
    >
      <div className="image-viewer-bar">
        <h2 className="image-viewer-title" id={titleId}>
          No.{postId} 的图片
        </h2>
        <p className="visually-hidden" id={hintId}>
          加号放大，减号缩小，0 适应窗口，1 原始大小，方向键或拖动移动图片，Ctrl 或 Command 加 S 保存原图，Esc 关闭
        </p>
        <div className="image-viewer-tools">
          <ZoomControls zoom={view} />
          <div className="image-viewer-group">
            <button
              type="button"
              className="btn btn-small"
              title="保存原图（Ctrl／⌘+S）"
              onClick={() => void save()}
              disabled={!originalShown}
              // Not `disabled` while saving: the focused button must keep focus (and the viewer its keys).
              aria-disabled={saving || undefined}
            >
              <Icon name="download" size={14} />
              {saving ? '正在保存…' : '保存原图'}
            </button>
            <button type="button" className="btn btn-small" title="关闭（Esc）" onClick={onClose}>
              <Icon name="close" size={14} />
              关闭
            </button>
          </div>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`image-viewer-stage${view.stageClass}`}
        tabIndex={0}
        role="group"
        aria-label={originalShown ? '原图' : thumb !== null ? '缩略图（原图未显示）' : '图片尚未显示'}
        {...view.stageHandlers}
      >
        {!originalShown && thumb !== null && (
          <img className="image-viewer-thumb" src={thumb.url} alt="" draggable={false} />
        )}
        {!originalShown && thumbProbeUrl !== null && (
          // Decoded off-screen, then shown as `thumb` above.
          <img
            className="image-viewer-probe"
            src={thumbProbeUrl}
            alt=""
            onLoad={() => thumbLoad.markDecoded(thumbProbeUrl)}
            onError={() => thumbLoad.markUndecodable(thumbProbeUrl)}
          />
        )}
        {!originalShown && thumb === null && (
          <span className="image-viewer-placeholder" aria-hidden="true">
            <Icon name="image" size={40} />
          </span>
        )}
        {originalImage !== null && (
          <img
            key={originalImage.url}
            className={originalShown ? 'image-viewer-original' : 'image-viewer-probe'}
            src={originalImage.url}
            alt=""
            draggable={false}
            style={view.imageStyle}
            onLoad={(event) => {
              // Shown (and savable) only once the whole image decodes, not just its header.
              const image = event.currentTarget
              const url = originalImage.url
              image.decode().then(
                () => {
                  setNatural({ w: image.naturalWidth || originalImage.width, h: image.naturalHeight || originalImage.height })
                  view.fit()
                  original.markDecoded(url)
                  clearNotLoaded()
                },
                () => original.markUndecodable(url)
              )
            }}
            onError={() => original.markUndecodable(originalImage.url)}
          />
        )}
      </div>

      <div className="image-viewer-footer">
        <div className="image-viewer-status" role="status">
          {status}
        </div>
        <p className="image-viewer-save" role="status">
          {saveMessage}
        </p>
      </div>
    </div>
  )
}
