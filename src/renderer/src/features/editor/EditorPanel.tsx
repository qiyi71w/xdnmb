import { REPORT_REASONS, reportReason } from '../../../../shared/report'
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { sameTarget, type IdentityChoice, type PostFields, type PostTarget } from '../../../../shared/drafts'
import type { CredentialId } from '../../../../shared/identity'
import { isSendShortcut, saveAriaShortcut, sendAriaShortcut, sendShortcutLabel, shortcutLabel } from '../../app/shortcuts'
import { Icon, Spinner } from '../../components/Icon'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { usePopover } from '../../lib/usePopover'
import { formatLocalTime } from '../../lib/format'
import { formatBytes } from '../image/imageView'
import { ATTEMPT_PROBLEM_TEXT, ATTEMPT_STATE_DETAIL, ATTEMPT_STATE_LABEL, PROBLEM_TEXT } from '../publication/publicationText'
import type { IdentitiesState } from '../identity/useIdentities'
import { ROLE_INFO } from '../identity/identityText'
import { ATTACH_FAILURE_TEXT, editorStateText, forumLabel, SAVE_FAILURE_TEXT, targetText } from './editorText'
import { editorFor, identityStatus, isUnsaved, type Editor, type IdentityStatus } from './editorsState'
import { focusKey } from './useEditorsStore'
import { useEditorWorkspace } from './workspace'
import { AttachmentPreview } from './AttachmentPreview'
import { useComposeTips } from './composeTips'
import { KaomojiPicker } from './KaomojiPicker'
import './editor.css'

/**
 * Opening or continuing this tab's editor for a target, as its entry (the 回复 / 发新串 buttons)
 * does it: an existing editor is expanded, otherwise a new one
 * starts with the identity the target would use. Either way its panel asks for focus.
 */
export function useComposeOpen(tabId: number, target: PostTarget, editor: Editor | null) {
  const { store } = useEditorWorkspace()
  const [opening, setOpening] = useState(false)
  const barKey = focusKey(tabId, target)
  const expand = async () => {
    store.clearPublished(barKey)
    if (editor !== null) {
      store.dispatch({ type: 'open', tabId, target, identity: { source: 'unknown' } })
      store.requestFocus(focusKey(tabId, target))
      return
    }
    if (opening) return
    setOpening(true)
    const identity = await window.xidao.posting.identityFor({ target }).catch((): IdentityChoice => ({ source: 'unknown' }))
    setOpening(false)
    store.dispatch({ type: 'open', tabId, target, identity })
    store.requestFocus(focusKey(tabId, target))
  }
  return { opening, expand }
}

/**
 * The editor of one target, as the floating panel lays it out: one header line (target as the title
 * that opens 更改目标, the 发言饼干 pill, close), the 举报 reasons, the optional 标题／名称／E-mail row,
 * the text as the page, and a bottom toolbar (image, fields, 颜文字, status; 放弃修改, 保存草稿, 发送).
 */
export function EditorPanel({
  tabId,
  editor,
  label,
  displayed,
  focusBar
}: {
  tabId: number
  editor: Editor
  label: string
  displayed: boolean
  focusBar: RefObject<boolean>
}) {
  const { store, platform, openAttempts, showTarget } = useEditorWorkspace()
  const { focusRequest, requestFocus } = store
  const ids = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const retargetRef = useRef<HTMLButtonElement>(null)
  const editorId = editor.id
  const unsaved = isUnsaved(editor)
  const saving = store.saving.has(editorId)
  const saveError = store.saveErrors.get(editorId) ?? null
  const attach = useAttachImage(editor)
  const [retargeting, setRetargeting] = useState(false)
  const [identityNotice, setIdentityNotice] = useState<string | null>(null)
  const [reportError, setReportError] = useState(false)
  /** The attached image shown large, opened from its thumbnail chip. */
  const [previewing, setPreviewing] = useState(false)
  const thumbRef = useRef<HTMLButtonElement>(null)
  const attachmentId = editor.attachment?.id ?? null
  useEffect(() => setPreviewing(false), [attachmentId])
  useComposeTips(panelRef)
  const hasExtraFields = editor.fields.title !== '' || editor.fields.name !== '' || editor.fields.email !== ''
  /** The 标题／名称／E-mail row is shown whenever one of its fields holds something. */
  const [fieldsOpen, setFieldsOpen] = useState(hasExtraFields)
  useEffect(() => {
    if (hasExtraFields) setFieldsOpen(true)
  }, [hasExtraFields])
  /** The row was opened from the toolbar: its first field takes focus once rendered. */
  const focusFields = useRef(false)
  useEffect(() => {
    if (!fieldsOpen || !focusFields.current) return
    focusFields.current = false
    document.getElementById(`${ids}-title`)?.focus()
  }, [fieldsOpen, ids])
  const publication = editor.publication
  /** A send holds this editor: its content, target and identity are fixed. */
  const locked = publication !== null
  const attemptState = publication?.phase === 'attempt' ? publication.attempt.state : null
  const ended = attemptState === 'unknown' || attemptState === 'unconfirmed'

  // Focus the text once a requested panel is on screen (opened, continued, retargeted).
  const key = focusKey(tabId, editor.target)
  useEffect(() => {
    if (!displayed || focusRequest !== key) return
    requestFocus(null)
    textareaRef.current?.focus()
  }, [displayed, focusRequest, key, requestFocus])

  // A placed caret (a quoted >>No. at the end): the text and its scrolling body follow it.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!displayed || editor.caret === undefined || textarea === null) return
    textarea.focus()
    textarea.setSelectionRange(editor.caret.offset, editor.caret.offset)
    textarea.scrollTop = textarea.scrollHeight
    const body = bodyRef.current
    if (body !== null) body.scrollTop = body.scrollHeight
  }, [displayed, editor.caret])

  // The panel going away with focus inside (sent and confirmed, ended) hands focus to the bar.
  useLayoutEffect(() => {
    const panel = panelRef.current
    return () => {
      if (panel?.contains(document.activeElement)) focusBar.current = true
    }
  }, [focusBar])

  const edit = (patch: Partial<PostFields>) => store.dispatch({ type: 'edit', editorId, patch })

  /** Caret to place once a text written without the editing command has rendered. */
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    const textarea = textareaRef.current
    if (caret === null || textarea === null) return
    pendingCaret.current = null
    textarea.setSelectionRange(caret, caret)
  })

  /**
   * 颜文字: `inserted` goes into the text at its caret, over its selection, even when
   * focus was elsewhere (标题／名称); focus ends in the text with the caret after the insertion.
   */
  const insertText = (inserted: string) => {
    const textarea = textareaRef.current
    if (textarea === null || locked) return
    const { selectionStart: start, selectionEnd: end, value } = textarea
    textarea.focus()
    textarea.setSelectionRange(start, end)
    // As if typed: one native undo step, the caret after it, the change through onChange.
    if (document.execCommand('insertText', false, inserted)) return
    const next = value.slice(0, start) + inserted + value.slice(end)
    pendingCaret.current = start + inserted.length
    if (report !== undefined) store.dispatch({ type: 'edit-report', editorId, patch: { text: next } })
    else edit({ content: next })
  }

  const collapse = () => {
    focusBar.current = true
    store.dispatch({ type: 'set-expanded', editorId, expanded: false })
  }

  const save = () => {
    if (!unsaved || saving || locked) return
    void store.save(editorId)
  }

  const report = editor.report
  const send = () => {
    if (report !== undefined && reportReason(report) === null) { setReportError(true); return }
    if (!locked) void store.send(editorId)
  }

  // 编辑器内发送: the same handler as the button, from any of the editor's own controls. Plain
  // Enter keeps inserting a newline; the retarget form keeps its own keys.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (platform === null || !isSendShortcut(event.nativeEvent, platform)) return
    if (event.target instanceof Element && event.target.closest('.editor-retarget') !== null) return
    event.preventDefault()
    send()
  }

  const discard = () => {
    store.dispatch({ type: 'discard-undoable', editorId })
    const draft = editor.draft
    if (draft !== null && editorFor(store.state, draft.target) === null) showTarget(tabId, draft.target)
    textareaRef.current?.focus()
  }

  const chooseIdentity = async (credentialId: CredentialId) => {
    if (locked) return
    store.dispatch({ type: 'set-identity', editorId, credentialId })
    setIdentityNotice(null)
    if (editor.target.kind !== 'reply') return
    const failed = '未能记住该串的饼干选择'
    try {
      const result = await window.xidao.posting.selectThreadIdentity({ threadId: editor.target.threadId, credentialId })
      if (!result.ok) setIdentityNotice(failed)
    } catch {
      setIdentityNotice(failed)
    }
  }

  const canDiscard = !saving && !locked && (unsaved || (editor.draft === null && editor.discarded === undefined))
  const saveShortcut = shortcutLabel('save', platform)
  const sendShortcut = sendShortcutLabel(platform)
  const statusText = saving ? '正在保存…' : editorStateText(editor)
  const sendLabel = report !== undefined ? '发送举报' : '发送'
  /** Text buttons without frames. */
  const textButton = 'compose-text-btn'

  const retargetForm = retargeting && !locked && (
    <RetargetForm
      editor={editor}
      onDone={() => {
        setRetargeting(false)
        retargetRef.current?.focus()
      }}
    />
  )

  const reportReasons = report !== undefined && (
    <fieldset className="report-reasons" disabled={locked}>
      <legend className="visually-hidden">举报理由</legend>
      <div className="report-reason-options">
        {REPORT_REASONS.map((reason) => (
          <label key={reason} className="report-reason">
            <input
              type="radio"
              name={`${ids}-reason`}
              checked={report.reason === reason}
              onChange={() => {
                setReportError(false)
                store.dispatch({ type: 'edit-report', editorId, patch: { reason } })
              }}
            />
            <span>{reason}</span>
          </label>
        ))}
      </div>
      {report.reason === '其他' && (
        <label className="report-custom">
          <span>理由</span>
          <input
            type="text"
            required
            maxLength={80}
            aria-invalid={reportError || undefined}
            value={report.customReason}
            onChange={(event) => {
              setReportError(false)
              store.dispatch({ type: 'edit-report', editorId, patch: { customReason: event.target.value } })
            }}
          />
        </label>
      )}
      {reportError && (
        <p className="notice-inline is-warning" role="alert">
          <Icon name="alert" size={14} />
          请选择举报理由{report.reason === '其他' ? '并填写理由' : ''}
        </p>
      )}
    </fieldset>
  )

  const text = (
    <>
      <label className="visually-hidden" htmlFor={`${ids}-content`}>
        {report !== undefined ? '举报内容' : '正文'}
      </label>
      <textarea
        ref={textareaRef}
        id={`${ids}-content`}
        className="editor-content"
        placeholder={report !== undefined ? '举报内容' : '正文'}
        value={report?.text ?? editor.fields.content}
        readOnly={locked}
        aria-keyshortcuts={sendAriaShortcut(platform)}
        onChange={(event) => report !== undefined
          ? store.dispatch({ type: 'edit-report', editorId, patch: { text: event.target.value } })
          : edit({ content: event.target.value })}
      />
    </>
  )

  const fields = (
    <div className="compose-fields">
      <FieldInput id={`${ids}-title`} label="标题" value={editor.fields.title} readOnly={locked} onChange={(title) => edit({ title })} />
      <FieldInput id={`${ids}-name`} label="名称" value={editor.fields.name} readOnly={locked} onChange={(name) => edit({ name })} />
      <FieldInput
        id={`${ids}-email`}
        label="E-mail"
        value={editor.fields.email}
        readOnly={locked}
        onChange={(email) => edit({ email })}
        type="email"
      />
    </div>
  )

  const status = (
    <div className="editor-status" role="status">
      {editor.discarded !== undefined ? <>
        <span className="editor-state">已放弃修改</span>
        <button type="button" className="btn btn-small btn-quiet" disabled={locked} onClick={() => {
          store.dispatch({ type: 'undo-discard', editorId })
          if (editor.discarded !== undefined) showTarget(tabId, editor.discarded.target)
          textareaRef.current?.focus()
        }}>撤销</button>
      </> : <span className="editor-state">{statusText}</span>}
    </div>
  )

  const saveFailure = saveError !== null && !saving && !locked && (
    <p className="notice-inline is-warning editor-error" role="alert">
      <Icon name="alert" size={14} />
      {SAVE_FAILURE_TEXT[saveError]}
    </p>
  )

  const saveTip = locked ? '发送进行中，不能另存' : unsaved ? (saveShortcut === '' ? undefined : saveShortcut) : '没有需要保存的内容'
  const sendText =
    publication === null
      ? sendLabel
      : publication.phase === 'prompt'
        ? '等待选择饼干…'
        : publication.phase === 'submitting'
          ? '正在提交…'
          : '正在发送…'

  const actions = (
    <div className="editor-actions">
      {ended ? (
        <>
          <button type="button" className={textButton} onClick={openAttempts}>
            <Icon name="history" />
            查看发送记录
          </button>
          <button type="button" className={textButton} onClick={() => store.endPublication(editorId)}>
            结束编辑
          </button>
        </>
      ) : publication?.phase === 'uncertain' ? (
        <button
          type="button"
          className="btn btn-primary"
          aria-busy={publication.checking || undefined}
          aria-disabled={publication.checking || undefined}
          onClick={() => void store.recheck(editorId)}
        >
          <Icon name="refresh" />
          {publication.checking ? '正在核对…' : '重新核对'}
        </button>
      ) : (
        <>
          <button
            type="button"
            className={textButton}
            disabled={!canDiscard}
            onClick={discard}
          >
            放弃修改
          </button>
          <button
            type="button"
            className={textButton}
            aria-label="保存草稿"
            aria-keyshortcuts={saveAriaShortcut(platform)}
            aria-disabled={!unsaved || saving || locked}
            aria-busy={saving || undefined}
            data-tip={saveTip}
            onClick={save}
          >
            保存草稿
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-label={sendText}
            aria-keyshortcuts={sendAriaShortcut(platform)}
            aria-disabled={locked || undefined}
            aria-busy={locked || undefined}
            data-tip={!locked && sendShortcut !== '' ? sendShortcut : undefined}
            data-tip-place="end"
            onClick={send}
          >
            {locked && <Spinner />}
            {sendText}
          </button>
        </>
      )}
    </div>
  )

  const attachment = editor.attachment
  const fieldsHidden = !fieldsOpen && hasExtraFields
  return (
    <div className="editor-panel is-float" data-editor-id={editorId} ref={panelRef} onKeyDown={onKeyDown}>
      <header className="compose-head">
        <h2 className="compose-title">
          {report !== undefined ? (
            <span className="compose-title-static">
              <span className="compose-title-text">举报</span>
              <span className="compose-subtitle">&gt;&gt;No.{report.postId}</span>
            </span>
          ) : locked ? (
            <span className="compose-title-static">
              <span className="compose-title-text">{label}</span>
            </span>
          ) : (
            <button
              ref={retargetRef}
              type="button"
              className="compose-target"
              aria-label={`${label}，更改目标`}
              aria-expanded={retargeting}
              data-tip="更改目标"
              data-tip-place="below start"
              onClick={() => setRetargeting((open) => !open)}
            >
              <span className="compose-title-text">{label}</span>
              <Icon name="chevron" size={14} className="compose-target-chevron" />
            </button>
          )}
        </h2>
        {locked && <span className="editor-fixed">已固定</span>}
        <CookiePill editor={editor} onChoose={(id) => void chooseIdentity(id)} />
        <button
          type="button"
          className="icon-btn"
          aria-label="收起"
          aria-keyshortcuts="Escape"
          data-tip="收起 · Esc"
          data-tip-place="below end"
          onClick={collapse}
        >
          <Icon name="close" />
        </button>
      </header>

      {retargetForm}
      {reportReasons}
      {fieldsOpen && fields}

      <div className="compose-body" ref={bodyRef}>
        {text}
      </div>

      <footer className="compose-foot">
        <div className="compose-notes">
          {saveFailure}
          {identityNotice !== null && (
            <p className="notice-inline is-warning" role="alert">
              <Icon name="alert" size={14} />
              {identityNotice}
            </p>
          )}
          {attach.error !== null && (
            <p className="notice-inline is-warning" role="alert">
              <Icon name="alert" size={14} />
              {attach.error}
            </p>
          )}
          <SendStatus editor={editor} />
        </div>
        <div className="compose-toolbar">
          <div className="compose-tools">
            <button
              type="button"
              className="icon-btn"
              aria-label={attach.busy ? '正在选择图片…' : attachment === null ? '添加图片' : '更换图片'}
              aria-busy={attach.busy || undefined}
              disabled={attach.busy || locked}
              data-tip={attachment === null ? '添加图片' : '更换图片'}
              data-tip-place="start"
              onClick={() => void attach.choose()}
            >
              {attach.busy ? <Spinner /> : <Icon name="image" />}
            </button>
            {attachment !== null && (
              <span className="compose-attachment">
                {attach.previewFailed === attachment.id ? (
                  <span
                    className="compose-thumb is-failed"
                    data-tip={`${attachment.width}×${attachment.height} · ${attachment.format.toUpperCase()} · ${formatBytes(attachment.bytes)}`}
                    data-tip-place="start"
                  >
                    <Icon name="image" size={16} />
                    <span className="visually-hidden">无法显示预览：{attachment.originalName}</span>
                  </span>
                ) : (
                  <button
                    ref={thumbRef}
                    type="button"
                    className="compose-thumb"
                    aria-label={`查看附图：${attachment.originalName}`}
                    aria-haspopup="dialog"
                    data-tip={`${attachment.width}×${attachment.height} · ${attachment.format.toUpperCase()} · ${formatBytes(attachment.bytes)}`}
                    data-tip-place="start"
                    onClick={() => setPreviewing(true)}
                  >
                    <img src={attachment.url} alt="" onError={() => attach.markPreviewFailed(attachment.id)} />
                  </button>
                )}
                <button
                  type="button"
                  className="compose-chip-remove"
                  aria-label="移除图片"
                  disabled={attach.busy || locked}
                  data-tip="移除图片"
                  data-tip-place="start"
                  onClick={attach.remove}
                >
                  <Icon name="close" size={12} />
                </button>
                {previewing && attach.previewFailed !== attachment.id && (
                  <AttachmentPreview attachment={attachment} returnFocus={thumbRef} onClose={() => setPreviewing(false)} />
                )}
              </span>
            )}
            {attachment !== null && <WatermarkSwitch editor={editor} />}
            <button
              type="button"
              className="icon-btn compose-fields-toggle"
              aria-label={fieldsHidden ? '标题、名称、E-mail（已填写）' : '标题、名称、E-mail'}
              aria-pressed={fieldsOpen}
              data-tip={fieldsHidden ? '标题 · 名称 · E-mail（已填写）' : '标题 · 名称 · E-mail'}
              data-tip-place="start"
              onClick={() => {
                focusFields.current = !fieldsOpen
                setFieldsOpen((open) => !open)
              }}
            >
              <Icon name="fields" />
              {fieldsHidden && <span className="compose-dot" aria-hidden="true" />}
            </button>
            <KaomojiPicker disabled={locked} onInsert={insertText} />
            {status}
          </div>
          {actions}
        </div>
      </footer>
    </div>
  )
}

/** The send part of the editor's status line: progress, the unresolved state, or the last result. */
function SendStatus({ editor }: { editor: Editor }) {
  const publication = editor.publication
  if (publication === null) {
    const notice = editor.sendNotice
    if (notice === null) return null
    const text =
      notice.kind === 'refused'
        ? `没有发送：${PROBLEM_TEXT[notice.reason]}`
        : notice.kind === 'failed'
          ? `发送失败${notice.problem === null ? '' : `：${ATTEMPT_PROBLEM_TEXT[notice.problem]}`}${notice.saved ? '，已保存为草稿' : '，草稿未能自动保存'}`
          : '这次发送没有发出，可以再次发送'
    return (
      <p className="notice-inline is-warning editor-send-notice">
        <Icon name="alert" size={14} />
        {text}
      </p>
    )
  }
  switch (publication.phase) {
    // The send button says these itself (正在提交…, 等待选择饼干…, 正在核对…).
    case 'submitting':
    case 'prompt':
      return null
    case 'uncertain':
      if (publication.checking) return null
      return (
        <p className="notice-inline is-warning editor-send-notice">
          <Icon name="alert" size={14} />
          无法确认这次发送是否已记录
        </p>
      )
    case 'attempt': {
      const state = publication.attempt.state
      if (state === 'sending') {
        return (
          <>
            <span className="editor-note">{ATTEMPT_STATE_DETAIL.sending}</span>
            {publication.readFailed && (
              <p className="notice-inline is-warning editor-send-notice">
                <Icon name="alert" size={14} />
                暂时读不到发送状态，正在重新读取
              </p>
            )}
          </>
        )
      }
      if (state !== 'unknown' && state !== 'unconfirmed') return null
      return (
        <div className="editor-attempt-card">
          <p className="editor-attempt-title">
            <Icon name="alert" size={14} />
            {ATTEMPT_STATE_LABEL[state]}
            {publication.attempt.problem !== null && `：${ATTEMPT_PROBLEM_TEXT[publication.attempt.problem]}`}
          </p>
          <p>{ATTEMPT_STATE_DETAIL[state]}</p>
          <p className="editor-note">开始于 {formatLocalTime(publication.attempt.createdAt)}</p>
        </div>
      )
    }
  }
}

function FieldInput({
  id,
  label,
  value,
  readOnly,
  onChange,
  type = 'text'
}: {
  id: string
  label: string
  value: string
  readOnly: boolean
  onChange: (value: string) => void
  type?: 'text' | 'email'
}) {
  return (
    <div className="editor-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        autoComplete="off"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

/** The editor's image chooser: whether a choice is open, the last failure, and its actions. */
interface AttachImage {
  busy: boolean
  error: string | null
  /** Attachment whose preview failed to load. */
  previewFailed: string | null
  markPreviewFailed: (attachmentId: string) => void
  choose: () => Promise<void>
  remove: () => void
}

/** Choosing, replacing and removing the editor's single image, with the last failure to say. */
function useAttachImage(editor: Editor): AttachImage {
  const { store } = useEditorWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const attachment = editor.attachment
  const editorId = editor.id
  const locked = editor.publication !== null

  const choose = async () => {
    if (busy || locked) return
    const replacing = attachment !== null
    setBusy(true)
    setError(null)
    let reason: string | null = null
    try {
      const result = await window.xidao.drafts.attachImage({ editorId })
      if (result.ok) store.dispatch({ type: 'set-attachment', editorId, attachment: result.attachment })
      else if (result.reason !== 'cancelled') reason = ATTACH_FAILURE_TEXT[result.reason]
    } catch {
      reason = ATTACH_FAILURE_TEXT.internal
    }
    setBusy(false)
    if (reason !== null) setError(`未能${replacing ? '更换' : '添加'}图片：${reason}`)
  }

  const remove = () => {
    setError(null)
    store.dispatch({ type: 'set-attachment', editorId, attachment: null })
  }

  return { busy, error, previewFailed, markPreviewFailed: setPreviewFailed, choose, remove }
}

/** 水印, shown beside an attached image. */
function WatermarkSwitch({ editor }: { editor: Editor }) {
  const { store } = useEditorWorkspace()
  const ids = useId()
  const on = editor.fields.watermark
  const disabled = editor.publication !== null
  return (
    <span className={`editor-watermark${disabled ? ' is-disabled' : ''}`}>
      <label className="editor-watermark-label" id={`${ids}-label`} htmlFor={`${ids}-switch`}>
        水印
      </label>
      <button
        id={`${ids}-switch`}
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-labelledby={`${ids}-label`}
        disabled={disabled}
        onClick={() => store.dispatch({ type: 'edit', editorId: editor.id, patch: { watermark: !on } })}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
    </span>
  )
}

/** The 发言饼干 pill's text while nothing is selected: why. */
function identityPlaceholder(status: IdentityStatus, identities: IdentitiesState): string {
  const { overview, failed } = identities
  if (overview === null) return failed ? '饼干列表读取失败' : '读取中…'
  if (status.state === 'missing') return '已移除，需要重新选择'
  if (status.state === 'unknown') return '无法读取原选择，请选择'
  return overview.credentials.length === 0 ? '尚未导入饼干' : '请选择饼干'
}

/** Typed letters within this pause extend one typeahead search. */
const TYPEAHEAD_PAUSE = 500

/**
 * Header: the 发言饼干 as a compact pill (`饼干 名称 ▾`, or `选择饼干` in warning ink).
 * The pill opens a listbox under it: the cookies in the user's order (the current one checked, the
 * browsing and default ones tagged as in settings), then 管理饼干. Arrow keys, Home/End and typed
 * letters move; Enter or Space chooses; Esc closes with focus back on the pill.
 */
function CookiePill({ editor, onChoose }: { editor: Editor; onChoose: (credentialId: CredentialId) => void }) {
  const { identities } = useEditorWorkspace()
  const openSettings = useSettingsOpener()
  const { overview, failed } = identities
  const status = identityStatus(editor, overview)
  const credentials = overview?.credentials ?? []
  const value = status.state === 'selected' ? status.credentialId : ''
  const locked = editor.publication !== null
  const placeholder = identityPlaceholder(status, identities)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const menu = usePopover(triggerRef, panelRef)
  const ids = useId()
  const selectedIndex = credentials.findIndex((credential) => credential.id === value)
  /** The option the keys act on (aria-activedescendant), by position. */
  const [active, setActive] = useState(0)
  const typeahead = useRef({ text: '', at: 0 })

  const disabled = overview === null || credentials.length === 0 || locked
  const { close: closeMenu } = menu
  useEffect(() => {
    if (disabled) closeMenu(false)
  }, [disabled, closeMenu])

  /** Opens or closes the list; each opening starts on the current cookie (else the first). */
  const toggleList = () => {
    if (!menu.open) setActive(Math.max(selectedIndex, 0))
    menu.toggle()
  }

  if (overview !== null && credentials.length === 0 && openSettings !== null && !locked) {
    return (
      <button
        type="button"
        className="compose-cookie is-warning"
        aria-label="导入饼干"
        data-tip={placeholder}
        data-tip-place="below end"
        onClick={() => openSettings('cookies')}
      >
        <Icon name="alert" size={13} />
        导入饼干
      </button>
    )
  }

  const selected = selectedIndex < 0 ? undefined : credentials[selectedIndex]
  const loading = overview === null && !failed
  const warning = selected === undefined && !loading
  const browsingId = credentials[0]?.id
  const defaultRole = overview?.roles['default-post']
  const defaultId = defaultRole?.state === 'selected' ? defaultRole.credentialId : undefined
  const current = Math.min(active, credentials.length - 1)
  const optionId = (index: number) => `${ids}-option-${index}`

  const choose = (index: number) => {
    const credential = credentials[index]
    if (credential === undefined) return
    menu.close()
    if (credential.id !== value) onChoose(credential.id)
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    const last = credentials.length - 1
    let next: number | null = null
    if (event.key === 'ArrowDown') next = Math.min(current + 1, last)
    else if (event.key === 'ArrowUp') next = Math.max(current - 1, 0)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      choose(current)
      return
    } else if (event.key.length === 1 && event.key !== ' ') {
      // Typeahead: the next name starting with what was typed; one letter repeated cycles.
      const now = event.timeStamp
      const previous = typeahead.current
      const text = (now - previous.at < TYPEAHEAD_PAUSE ? previous.text : '') + event.key.toLowerCase()
      typeahead.current = { text, at: now }
      const cycling = [...text].every((letter) => letter === text[0])
      const search = cycling ? text[0]! : text
      const start = cycling || text.length === 1 ? current + 1 : current
      for (let step = 0; step < credentials.length; step++) {
        const index = (start + step) % credentials.length
        if (credentials[index]!.name.toLowerCase().startsWith(search)) {
          next = index
          break
        }
      }
      if (next === null) return
    } else return
    event.preventDefault()
    event.stopPropagation()
    setActive(next)
    document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
  }

  const label = selected !== undefined ? `发言饼干：${selected.name}` : loading ? '发言饼干：读取中' : `发言饼干：${placeholder}`
  return (
    <span
      className="compose-cookie-field"
      onBlur={(event) => {
        // Tab out of the list (past 管理饼干) closes it where focus went.
        const next = event.relatedTarget as Node | null
        if (next !== null && !event.currentTarget.contains(next)) menu.close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`compose-cookie${warning ? ' is-warning' : ''}${disabled ? ' is-disabled' : ''}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={menu.open}
        aria-controls={menu.open ? `${ids}-list` : undefined}
        disabled={disabled}
        data-tip={warning ? placeholder : '发言饼干'}
        data-tip-place="below end"
        onClick={toggleList}
        onKeyDown={(event) => {
          // ↓ / ↑ open the list too, as a select does.
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !menu.open) {
            event.preventDefault()
            toggleList()
          }
        }}
      >
        <span className="compose-cookie-text" aria-hidden="true">
          {selected !== undefined ? (
            <>
              <span className="compose-cookie-label">饼干</span>
              <span className="compose-cookie-name">{selected.name}</span>
            </>
          ) : loading ? (
            '读取中…'
          ) : (
            <>
              <Icon name="alert" size={13} />
              选择饼干
            </>
          )}
        </span>
        {!disabled && <Icon name="chevron" size={12} className="compose-cookie-chevron" />}
      </button>
      {menu.open && (
        <div ref={panelRef} className="compose-cookie-pop">
          {selected === undefined && (
            <p className="compose-cookie-note" id={`${ids}-note`}>
              <Icon name="alert" size={13} />
              {placeholder}
            </p>
          )}
          <div
            id={`${ids}-list`}
            className="compose-cookie-list"
            role="listbox"
            aria-label="发言饼干"
            aria-describedby={selected === undefined ? `${ids}-note` : undefined}
            aria-activedescendant={optionId(current)}
            tabIndex={0}
            data-autofocus=""
            onKeyDown={onListKeyDown}
          >
            {credentials.map((credential, index) => {
              const isSelected = credential.id === value
              const tags = [credential.id === browsingId ? '浏览' : null, credential.id === defaultId ? ROLE_INFO['default-post'].label : null].filter(
                (tag) => tag !== null
              )
              return (
                <div
                  key={credential.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isSelected}
                  className={`compose-cookie-option${index === current ? ' is-active' : ''}`}
                  onPointerMove={() => setActive(index)}
                  // The list keeps focus: a press chooses without moving it first.
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span className="compose-cookie-check" aria-hidden="true">
                    {isSelected && <Icon name="check" size={14} />}
                  </span>
                  <span className="compose-cookie-option-name">{credential.name}</span>
                  {tags.length > 0 && (
                    <span className="compose-cookie-tags">
                      <span className="visually-hidden">用于：</span>
                      {tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          {openSettings !== null && (
            <>
              <div role="separator" className="compose-cookie-separator" />
              <button
                type="button"
                className="compose-cookie-manage"
                onClick={() => {
                  menu.close(false)
                  openSettings('cookies')
                }}
              >
                <Icon name="settings" size={14} />
                管理饼干
              </button>
            </>
          )}
        </div>
      )}
    </span>
  )
}

/** 更改目标: a thread to reply to, or a forum to post a new thread in. The 发言饼干 stays. */
function RetargetForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const { directory, forumName, retarget } = useEditorWorkspace()
  const ids = useId()
  const current = editor.target
  const [kind, setKind] = useState<PostTarget['kind']>(current.kind)
  const [threadInput, setThreadInput] = useState(current.kind === 'reply' ? current.threadId : '')
  const [forumId, setForumId] = useState(current.kind === 'thread' ? current.forumId : '')
  const [message, setMessage] = useState<string | null>(null)

  const threadId = threadInput.trim().replace(/^No\.?/i, '')
  const threadValid = /^[1-9]\d{0,19}$/.test(threadId)
  const groups = directory?.groups.filter((group) => group.forums.length > 0) ?? []
  const knownForum = groups.some((group) => group.forums.some((forum) => forum.id === forumId))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    let target: PostTarget
    if (kind === 'reply') {
      if (!threadValid) {
        setMessage('请输入串号（数字）')
        return
      }
      target = { kind: 'reply', threadId }
    } else {
      if (forumId === '') {
        setMessage('请选择版面')
        return
      }
      target = { kind: 'thread', forumId }
    }
    if (sameTarget(target, current)) {
      onDone()
      return
    }
    if (retarget(editor.id, target) === 'occupied') {
      setMessage(`已有「${targetText(target, forumName)}」的编辑，目标未更改`)
    }
  }

  return (
    <form className="editor-retarget" onSubmit={submit} aria-label="更改发言目标">
      <div className="segmented" role="group" aria-label="发言方式">
        {(['reply', 'thread'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className="segmented-item"
            aria-pressed={kind === item}
            onClick={() => {
              setKind(item)
              setMessage(null)
            }}
          >
            {item === 'reply' ? '回复串' : '发新串'}
          </button>
        ))}
      </div>
      {kind === 'reply' ? (
        <div className="editor-field">
          <label htmlFor={`${ids}-thread`}>串号</label>
          <input
            id={`${ids}-thread`}
            inputMode="numeric"
            autoComplete="off"
            value={threadInput}
            aria-invalid={threadInput.trim() !== '' && !threadValid ? true : undefined}
            onChange={(event) => {
              setThreadInput(event.target.value)
              setMessage(null)
            }}
          />
        </div>
      ) : (
        <div className="editor-field">
          <label htmlFor={`${ids}-forum`}>版面</label>
          <select
            id={`${ids}-forum`}
            value={forumId}
            disabled={groups.length === 0 && forumId === ''}
            onChange={(event) => {
              setForumId(event.target.value)
              setMessage(null)
            }}
          >
            <option value="" disabled>
              {groups.length === 0 ? '版面目录尚未读取' : '选择版面'}
            </option>
            {forumId !== '' && !knownForum && <option value={forumId}>{forumLabel(forumId, forumName)}</option>}
            {groups.map((group) => (
              <optgroup key={group.id} label={group.name}>
                {group.forums.map((forum) => (
                  <option key={forum.id} value={forum.id}>
                    {forum.displayName}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}
      <div className="editor-retarget-actions">
        <button type="submit" className="btn btn-small">
          确定
        </button>
        <button type="button" className="btn btn-small" onClick={onDone}>
          取消
        </button>
      </div>
      {message !== null && (
        <p className="notice-inline is-warning" role="alert">
          <Icon name="alert" size={14} />
          {message}
        </p>
      )}
    </form>
  )
}
