import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react'
import type { PostId } from '../../../../shared/forum'
import type { ImageViewId, LoadedImage } from '../../../../shared/images'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Notices'
import { useCover } from '../../lib/appCovered'
import { openLayer } from '../../lib/layers'
import { describeImageError, formatBytes, SAVE_TEXT, UNDECODABLE_TEXT } from './imageView'
import { useImageLoad } from './useImageLoad'
import './image.css'

const MAX_SCALE = 8
const MIN_SCALE = 0.1
const STEP = 1.25
/** Free space kept around the image when it is fitted to the stage. */
const FIT_PADDING = 16
const PAN_STEP = 60
const PAN_STEP_LARGE = 240

interface Size {
  w: number
  h: number
}

/** `fit` follows the stage size; `manual` keeps a scale and the image's top-left corner on the stage. */
type Zoom = { mode: 'fit' } | { mode: 'manual'; scale: number; x: number; y: number }

interface Placement {
  scale: number
  x: number
  y: number
}

function fitScale(natural: Size, stage: Size): number {
  return Math.max(Math.min(1, (stage.w - 2 * FIT_PADDING) / natural.w, (stage.h - 2 * FIT_PADDING) / natural.h), 0.01)
}

function minScale(natural: Size, stage: Size): number {
  return Math.min(MIN_SCALE, fitScale(natural, stage))
}

/** A dimension smaller than the stage is centred; a larger one may not leave a gap at either edge. */
function clampOffset(offset: number, length: number, stageLength: number): number {
  if (length <= stageLength) return (stageLength - length) / 2
  return Math.min(0, Math.max(stageLength - length, offset))
}

function place(zoom: Zoom, natural: Size, stage: Size): Placement {
  if (zoom.mode === 'fit') {
    const scale = fitScale(natural, stage)
    return { scale, x: (stage.w - natural.w * scale) / 2, y: (stage.h - natural.h * scale) / 2 }
  }
  return {
    scale: zoom.scale,
    x: clampOffset(zoom.x, natural.w * zoom.scale, stage.w),
    y: clampOffset(zoom.y, natural.h * zoom.scale, stage.h)
  }
}

/** Scale around a stage point (the pointer, or the stage centre), keeping that point of the image under it. */
function zoomAround(zoom: Zoom, scale: number, point: { x: number; y: number }, natural: Size, stage: Size): Zoom {
  const current = place(zoom, natural, stage)
  const next = Math.min(MAX_SCALE, Math.max(minScale(natural, stage), scale))
  const ratio = next / current.scale
  return {
    mode: 'manual',
    scale: next,
    x: point.x - (point.x - current.x) * ratio,
    y: point.y - (point.y - current.y) * ratio
  }
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Viewer of one post image over the reader that opened it (modal within that reader). Fetches the
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
  /** The reader is displayed (its tab active, its pane shown). */
  displayed: boolean
  onClose: () => void
}) {
  const original = useImageLoad(viewId, postId, 'original')
  const thumbLoad = useImageLoad(viewId, postId, 'thumb')
  const titleId = useId()
  const hintId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<Size | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit' })
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null)
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
  // It covers the reader it opened in: nothing there is judged read while it is open.
  useCover(true)

  const thumb =
    initialThumb ?? (thumbLoad.state.status === 'ready' && thumbLoad.state.decoded ? thumbLoad.state.image : null)
  /** The viewer's own thumbnail request (the opener had none decoded), loaded but not yet decoded. */
  const thumbProbeUrl =
    initialThumb === null && thumbLoad.state.status === 'ready' && !thumbLoad.state.decoded ? thumbLoad.state.image.url : null
  const originalState = original.state
  const originalImage = originalState.status === 'ready' ? originalState.image : null
  const originalShown = originalState.status === 'ready' && originalState.decoded && natural !== null
  const placement = originalShown && stage !== null && natural !== null ? place(zoom, natural, stage) : null
  const canPan =
    placement !== null &&
    stage !== null &&
    natural !== null &&
    (natural.w * placement.scale > stage.w + 0.5 || natural.h * placement.scale > stage.h + 0.5)

  // Latest geometry for event handlers registered outside React (wheel).
  const geometry = useRef({ stage, natural, originalShown })
  useLayoutEffect(() => {
    geometry.current = { stage, natural, originalShown }
  })

  useLayoutEffect(() => {
    const element = stageRef.current
    if (element === null) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      if (width > 0 && height > 0) setStage((previous) => (previous?.w === width && previous.h === height ? previous : { w: width, h: height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

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

  const zoomBy = useCallback((factor: number, point?: { x: number; y: number }) => {
    const { stage, natural, originalShown } = geometry.current
    if (!originalShown || stage === null || natural === null) return
    setZoom((previous) => {
      const current = place(previous, natural, stage)
      return zoomAround(previous, current.scale * factor, point ?? { x: stage.w / 2, y: stage.h / 2 }, natural, stage)
    })
  }, [])

  const zoomTo = useCallback((scale: number) => {
    const { stage, natural, originalShown } = geometry.current
    if (!originalShown || stage === null || natural === null) return
    setZoom((previous) => zoomAround(previous, scale, { x: stage.w / 2, y: stage.h / 2 }, natural, stage))
  }, [])

  const fit = useCallback(() => setZoom({ mode: 'fit' }), [])

  const panBy = (dx: number, dy: number) => {
    if (!canPan || placement === null) return
    setZoom({ mode: 'manual', scale: placement.scale, x: placement.x + dx, y: placement.y + dy })
  }

  // Wheel over the stage zooms around the pointer; nothing under the viewer scrolls. Registered
  // natively: React's wheel listener is passive.
  useEffect(() => {
    const dialog = dialogRef.current
    const element = stageRef.current
    if (dialog === null || element === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const { stage } = geometry.current
      if (stage === null || !element.contains(event.target as Node | null)) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.h : 1
      const rect = element.getBoundingClientRect()
      zoomBy(Math.exp(-event.deltaY * unit * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    dialog.addEventListener('wheel', onWheel, { passive: false })
    return () => dialog.removeEventListener('wheel', onWheel)
  }, [zoomBy])

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
    switch (key) {
      case '+':
      case '=':
        handled()
        zoomBy(STEP)
        return
      case '-':
      case '_':
        handled()
        zoomBy(1 / STEP)
        return
      case '0':
        handled()
        fit()
        return
      case '1':
        handled()
        zoomTo(1)
        return
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        handled()
        const step = event.shiftKey ? PAN_STEP_LARGE : PAN_STEP
        // Arrows move the view like scrolling: → shows more of the right side.
        if (key === 'ArrowLeft') panBy(step, 0)
        else if (key === 'ArrowRight') panBy(-step, 0)
        else if (key === 'ArrowUp') panBy(0, step)
        else panBy(0, -step)
        return
      }
      case 'PageUp':
      case 'PageDown':
      case 'Home':
      case 'End':
        // Nothing underneath may scroll.
        event.preventDefault()
        return
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !canPan || placement === null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus({ preventScroll: true })
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: placement.x, y: placement.y }
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId || placement === null) return
    setZoom({
      mode: 'manual',
      scale: placement.scale,
      x: current.x + event.clientX - current.startX,
      y: current.y + event.clientY - current.startY
    })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }

  const scaleMin = stage !== null && natural !== null ? minScale(natural, stage) : MIN_SCALE
  const percent = placement === null ? null : Math.round(placement.scale * 100)

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
          <div className="image-viewer-group" role="group" aria-label="缩放">
            <button
              type="button"
              className="icon-btn"
              aria-label="缩小"
              title="缩小（-）"
              onClick={() => zoomBy(1 / STEP)}
              disabled={placement === null || placement.scale <= scaleMin + 1e-6}
            >
              <Icon name="minus" />
            </button>
            <span className="image-viewer-zoom">
              <span className="visually-hidden">缩放比例 </span>
              {percent === null ? '—' : `${percent}%`}
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label="放大"
              title="放大（+）"
              onClick={() => zoomBy(STEP)}
              disabled={placement === null || placement.scale >= MAX_SCALE - 1e-6}
            >
              <Icon name="plus" />
            </button>
            <button
              type="button"
              className="btn btn-small"
              title="适应窗口（0）"
              aria-pressed={placement === null ? undefined : zoom.mode === 'fit'}
              onClick={fit}
              disabled={placement === null}
            >
              <Icon name="fit" size={14} />
              适应窗口
            </button>
            <button type="button" className="btn btn-small" title="原始大小（1）" onClick={() => zoomTo(1)} disabled={placement === null}>
              原始大小
            </button>
          </div>
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
        className={`image-viewer-stage${canPan ? ' is-pannable' : ''}${dragging ? ' is-dragging' : ''}`}
        tabIndex={0}
        role="group"
        aria-label={originalShown ? '原图' : thumb !== null ? '缩略图（原图未显示）' : '图片尚未显示'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
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
            style={
              placement === null || natural === null
                ? undefined
                : {
                    width: natural.w * placement.scale,
                    height: natural.h * placement.scale,
                    transform: `translate(${placement.x}px, ${placement.y}px)`
                  }
            }
            onLoad={(event) => {
              // Shown (and savable) only once the whole image decodes, not just its header.
              const image = event.currentTarget
              const url = originalImage.url
              image.decode().then(
                () => {
                  setNatural({ w: image.naturalWidth || originalImage.width, h: image.naturalHeight || originalImage.height })
                  setZoom({ mode: 'fit' })
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
