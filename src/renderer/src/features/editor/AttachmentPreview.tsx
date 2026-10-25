// PROTOTYPE (throwaway): the attached image, large, from the float compose panel's thumbnail chip.
// The post image viewer (features/image/ImageViewer.tsx) fetches post images by id; this shows the
// local draft copy in its look and with its zoom (useImageZoom): fitted to the window at first
// (never enlarged), then toolbar, wheel, drag and keys. Esc, 关闭 or a press beside the image closes
// it, and focus returns to the chip.

import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { DraftAttachment } from '../../../../shared/drafts'
import { Icon } from '../../components/Icon'
import { openLayer } from '../../lib/layers'
import { formatBytes } from '../image/imageView'
import { useImageZoom, ZoomControls, type Size } from '../image/imageZoom'
import '../image/image.css'

/** A press that moved less than this is a click, not a drag. */
const CLICK_SLOP = 4

export function AttachmentPreview({
  attachment,
  returnFocus,
  onClose
}: {
  attachment: DraftAttachment
  returnFocus: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const hintId = useId()
  /** The press began beside the image (not on it, nor on the bars), here. */
  const pressedOutside = useRef<{ x: number; y: number } | null>(null)
  // The stored size places the image at once; the decoded one replaces it if it differs.
  const [natural, setNatural] = useState<Size>({ w: attachment.width, h: attachment.height })
  const view = useImageZoom(dialogRef, natural, true)
  const { stageRef } = view

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const layer = openLayer()
    if (!dialog.open) dialog.showModal()
    // The stage takes the keys, as in the post image viewer.
    stageRef.current?.focus({ preventScroll: true })
    const opener = returnFocus.current
    return () => {
      layer.release()
      // Out of the top layer first: the chip behind it is inert until then.
      if (dialog.open) dialog.close()
      opener?.focus({ preventScroll: true })
    }
  }, [returnFocus, stageRef])

  /** Beside the image: the stage or the dialog itself, not the image or the bars. */
  const outside = (target: EventTarget) => target === dialogRef.current || target === stageRef.current

  return (
    <dialog
      ref={dialogRef}
      className="image-viewer compose-image-preview"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      // Colours the window's title-bar controls with its top bar (useAppearance).
      data-titlebar-cover=""
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      // The compose panel's own keys (send, Tab cycling) stay out of the preview.
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
        view.onZoomKey(event)
      }}
      onPointerDown={(event) => {
        pressedOutside.current = outside(event.target) ? { x: event.clientX, y: event.clientY } : null
      }}
      onClick={(event) => {
        event.stopPropagation()
        const press = pressedOutside.current
        pressedOutside.current = null
        // A drag that began beside the image pans; only a still press closes.
        if (press !== null && outside(event.target) && Math.hypot(event.clientX - press.x, event.clientY - press.y) < CLICK_SLOP) onClose()
      }}
    >
      <div className="image-viewer-bar">
        <h2 className="image-viewer-title compose-image-preview-title" id={titleId}>
          {attachment.originalName}
        </h2>
        <p className="visually-hidden" id={hintId}>
          加号放大，减号缩小，0 适应窗口，1 原始大小，方向键或拖动移动图片，Esc 关闭
        </p>
        <div className="image-viewer-tools">
          <ZoomControls zoom={view} />
          <div className="image-viewer-group">
            <button type="button" className="btn btn-small" aria-keyshortcuts="Escape" title="关闭（Esc）" onClick={onClose}>
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
        aria-label="附图"
        {...view.stageHandlers}
      >
        <img
          className="image-viewer-original"
          src={attachment.url}
          alt={`附图：${attachment.originalName}`}
          draggable={false}
          // Unplaced until the stage is measured (the dialog opens after the first layout).
          style={view.imageStyle ?? { visibility: 'hidden' }}
          onLoad={(event) => {
            const { naturalWidth: w, naturalHeight: h } = event.currentTarget
            if (w > 0 && h > 0 && (w !== natural.w || h !== natural.h)) {
              setNatural({ w, h })
              view.fit()
            }
          }}
        />
      </div>
      <div className="image-viewer-footer">
        <p className="image-viewer-info">
          {attachment.width}×{attachment.height} · {attachment.format.toUpperCase()} · {formatBytes(attachment.bytes)}
        </p>
      </div>
    </dialog>
  )
}
