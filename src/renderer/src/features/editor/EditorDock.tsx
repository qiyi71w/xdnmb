import { REPORT_REASONS, reportReason } from '../../../../shared/report'
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { sameTarget, targetKey, type IdentityChoice, type PostFields, type PostTarget } from '../../../../shared/drafts'
import type { CredentialId } from '../../../../shared/identity'
import { isSendShortcut, saveAriaShortcut, sendAriaShortcut, sendShortcutLabel, shortcutLabel } from '../../app/shortcuts'
import { Icon, Spinner } from '../../components/Icon'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { formatLocalTime } from '../../lib/format'
import { formatBytes } from '../image/imageView'
import { ATTEMPT_PROBLEM_TEXT, ATTEMPT_STATE_DETAIL, ATTEMPT_STATE_LABEL, PROBLEM_TEXT } from '../publication/publicationText'
import type { IdentitiesState } from '../identity/useIdentities'
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
import {
  ATTACH_FAILURE_TEXT,
  choiceLine,
  editorStateText,
  forumLabel,
  identityLine,
  SAVE_FAILURE_TEXT,
  targetText,
  type IdentityLine
} from './editorText'
import { editorFor, identityStatus, isUnsaved, type Editor } from './editorsState'
import { focusKey } from './useEditorsStore'
import { useEditorWorkspace } from './workspace'
import './editor.css'

/** Identity of an existing editor; a reference waiting for the overview is “读取中”, not unknown. */
function editorIdentity(editor: Editor, identities: IdentitiesState): IdentityLine {
  if (editor.credentialId !== null && identities.overview === null && !identities.failed) return { text: '读取中…', warning: false }
  return identityLine(identityStatus(editor, identities.overview))
}

function IdentityValue({ line }: { line: IdentityLine }) {
  return (
    <span className={line.warning ? 'editor-identity is-warning' : 'editor-identity'}>
      {line.warning && <Icon name="alert" size={13} />}
      {line.text}
    </span>
  )
}

/**
 * Bottom editor of one target in one tab: a collapsed bar that always names the target
 * and the 发言饼干, expanding into this tab's editor for the target. Lives outside the content
 * scroller, so the reading viewport never counts posts under it as visible.
 */
export function EditorDock({ tabId, target, displayed }: { tabId: number; target: PostTarget; displayed: boolean }) {
  const workspace = useEditorWorkspace()
  const editor = editorFor(workspace.store.state, tabId, target)
  const label = targetText(target, workspace.forumName)
  /** Set when the panel goes away by the user's action: the bar takes focus when it appears. */
  const focusBar = useRef(false)
  const expanded = editor !== null && editor.expanded
  return (
    <section className={expanded ? 'editor-dock is-expanded' : 'editor-dock'} aria-label={`发言编辑：${label}`}>
      {expanded ? (
        <EditorPanel key={editor.id} editor={editor} label={label} displayed={displayed} focusBar={focusBar} />
      ) : (
        <CollapsedBar tabId={tabId} target={target} editor={editor} label={label} focusBar={focusBar} />
      )}
    </section>
  )
}

/**
 * Opening or continuing this tab's editor for a target, as its entry (the collapsed bar, or the
 * prototype's 回复 / 发新串 buttons) does it: an existing editor is expanded, otherwise a new one
 * starts with the identity the target would use. Either way its panel asks for focus.
 */
export function useComposeOpen(tabId: number, target: PostTarget, editor: Editor | null) {
  const { store } = useEditorWorkspace()
  const [opening, setOpening] = useState(false)
  const barKey = focusKey(tabId, target)
  const expand = async () => {
    store.clearPublished(barKey)
    if (editor !== null) {
      store.dispatch({ type: 'set-expanded', editorId: editor.id, expanded: true })
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

function CollapsedBar({
  tabId,
  target,
  editor,
  label,
  focusBar
}: {
  tabId: number
  target: PostTarget
  editor: Editor | null
  label: string
  focusBar: RefObject<boolean>
}) {
  const { store, identities } = useEditorWorkspace()
  const { overview } = identities
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [choice, setChoice] = useState<IdentityChoice | null>(null)
  const { opening, expand } = useComposeOpen(tabId, target, editor)
  const targetRef = useRef(target)
  useLayoutEffect(() => {
    targetRef.current = target
  })
  const key = targetKey(target)
  const hasEditor = editor !== null
  const barKey = focusKey(tabId, target)
  /** The last send from this tab to this target was confirmed: say so until a new editor opens. */
  const sent = editor === null ? store.published.get(barKey) : undefined

  useLayoutEffect(() => {
    if (!focusBar.current) return
    focusBar.current = false
    buttonRef.current?.focus()
  }, [focusBar])

  // Without an editor, show the identity a new one would start with. Re-read whenever the
  // identities change (e.g. the global default was switched in settings); existing editors keep theirs.
  useEffect(() => {
    if (hasEditor) return
    let alive = true
    window.xidao.posting
      .identityFor({ target: targetRef.current })
      .catch((): IdentityChoice => ({ source: 'unknown' }))
      .then((next) => {
        if (alive) setChoice(next)
      })
    return () => {
      alive = false
    }
  }, [hasEditor, key, overview])

  const identity = editor === null ? choiceLine(choice, overview) : editorIdentity(editor, identities)
  const action = editor !== null ? '继续编辑' : target.kind === 'reply' ? '回复' : '发新串'

  return (
    <div className="editor-bar">
      <Icon name={target.kind === 'reply' ? 'reply' : 'draft'} className="editor-bar-icon" />
      <div className="editor-bar-text">
        <span className="editor-bar-target">{label}</span>
        <span className="editor-bar-meta">
          {editor === null ? '将使用饼干：' : '饼干：'}
          <IdentityValue line={identity} />
          {editor !== null && <span className="editor-bar-state">{editorStateText(editor)}</span>}
        </span>
        <span className="editor-bar-sent" role="status">
          {sent !== undefined && (
            <>
              <Icon name="check" size={13} />
              {sent.isThread ? `新串已发出：No.${sent.postId}` : `已发送 No.${sent.postId}`}，已记为自己的发言
            </>
          )}
        </span>
      </div>
      <button
        ref={buttonRef}
        type="button"
        className="btn editor-bar-action"
        aria-expanded={false}
        aria-busy={opening || undefined}
        onClick={() => void expand()}
      >
        <Icon name={editor !== null ? 'draft' : target.kind === 'reply' ? 'reply' : 'plus'} />
        {action}
      </button>
    </div>
  )
}

/**
 * The editor of one target. `dock`: the bottom panel. `float` (PROTOTYPE): the floating panel's
 * layout — header with target, 发言饼干 and close, the text filling the body, 标题／名称／E-mail
 * behind 更多字段, and a fixed action footer. Same state, handlers and child controls in both.
 */
export function EditorPanel({
  editor,
  label,
  displayed,
  focusBar,
  layout = 'dock'
}: {
  editor: Editor
  label: string
  displayed: boolean
  focusBar: RefObject<boolean>
  layout?: 'dock' | 'float'
}) {
  const { store, identities, platform, openAttempts } = useEditorWorkspace()
  const { focusRequest, requestFocus } = store
  const ids = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const discardRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const retargetRef = useRef<HTMLButtonElement>(null)
  const editorId = editor.id
  const unsaved = isUnsaved(editor)
  const saving = store.saving.has(editorId)
  const saveError = store.saveErrors.get(editorId) ?? null
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [retargeting, setRetargeting] = useState(false)
  const [identityNotice, setIdentityNotice] = useState<string | null>(null)
  const [reportError, setReportError] = useState(false)
  const hasExtraFields = editor.fields.title !== '' || editor.fields.name !== '' || editor.fields.email !== ''
  /** Float layout: 更多字段 is open whenever one of its fields holds something. */
  const [moreOpen, setMoreOpen] = useState(hasExtraFields)
  useEffect(() => {
    if (hasExtraFields) setMoreOpen(true)
  }, [hasExtraFields])
  const publication = editor.publication
  /** A send holds this editor: its content, target and identity are fixed. */
  const locked = publication !== null
  const attemptState = publication?.phase === 'attempt' ? publication.attempt.state : null
  const ended = attemptState === 'unknown' || attemptState === 'unconfirmed'

  // Focus the text once a requested panel is on screen (opened, continued, retargeted).
  const key = focusKey(editor.tabId, editor.target)
  useEffect(() => {
    if (!displayed || focusRequest !== key) return
    requestFocus(null)
    textareaRef.current?.focus()
  }, [displayed, focusRequest, key, requestFocus])

  useLayoutEffect(() => {
    if (confirmDiscard) confirmRef.current?.focus()
  }, [confirmDiscard])

  // The panel going away with focus inside (sent and confirmed, ended) hands focus to the bar.
  useLayoutEffect(() => {
    const panel = panelRef.current
    return () => {
      if (panel?.contains(document.activeElement)) focusBar.current = true
    }
  }, [focusBar])

  const edit = (patch: Partial<PostFields>) => store.dispatch({ type: 'edit', editorId, patch })

  const collapse = () => {
    focusBar.current = true
    store.dispatch({ type: 'set-expanded', editorId, expanded: false })
  }

  const save = () => {
    if (!unsaved || saving || locked) return
    void store.save(editorId)
  }

  const report = PROTOTYPE_ENABLED ? editor.report : undefined
  const send = () => {
    if (report !== undefined && reportReason(report) === null) { setReportError(true); return }
    if (!locked) void store.send(editorId)
  }

  // 编辑器内发送: the same handler as the button, from any of the editor's own controls. Plain
  // Enter keeps inserting a newline; the retarget form and confirmations keep their own keys.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (platform === null || !isSendShortcut(event.nativeEvent, platform)) return
    if (event.target instanceof Element && event.target.closest('.editor-retarget, .editor-confirm') !== null) return
    event.preventDefault()
    send()
  }

  const discard = () => {
    setConfirmDiscard(false)
    if (editor.draft === null) focusBar.current = true
    else textareaRef.current?.focus()
    store.dispatch({ type: 'discard', editorId })
  }

  const chooseIdentity = async (credentialId: CredentialId) => {
    if (locked) return
    store.dispatch({ type: 'set-identity', editorId, credentialId })
    setIdentityNotice(null)
    if (editor.target.kind !== 'reply') return
    const failed = '未能记住该串的选择，本次编辑仍使用新选择'
    try {
      const result = await window.xidao.posting.selectThreadIdentity({ threadId: editor.target.threadId, credentialId })
      if (!result.ok) setIdentityNotice(failed)
    } catch {
      setIdentityNotice(failed)
    }
  }

  const identity = editorIdentity(editor, identities)
  const canDiscard = !saving && !locked && (unsaved || editor.draft === null)
  const saveShortcut = shortcutLabel('save', platform)
  const sendShortcut = sendShortcutLabel(platform)
  const statusText = saving ? '正在保存…' : editorStateText(editor)
  const sendLabel = report !== undefined ? '发送' : editor.target.kind === 'reply' ? '发送回复' : '发布新串'

  const retargetButton = (
    <button
      ref={retargetRef}
      type="button"
      className="btn btn-small"
      aria-expanded={retargeting && !locked}
      disabled={locked}
      title={locked ? '发送进行中或结果待确认，目标已固定' : undefined}
      onClick={() => setRetargeting((open) => !open)}
    >
      更改目标
    </button>
  )

  const retargetForm = retargeting && !locked && (
    <RetargetForm
      editor={editor}
      compact={layout === 'float'}
      onDone={() => {
        setRetargeting(false)
        retargetRef.current?.focus()
      }}
    />
  )

  const content = (
    <>
      {report !== undefined && <fieldset className="report-reasons" disabled={locked}>
        <legend>举报 &gt;&gt;No.{report.postId}</legend>
        <div className="report-reason-options">{REPORT_REASONS.map((reason) => <label key={reason}>
          <input type="radio" name={`${ids}-reason`} checked={report.reason === reason} onChange={() => {
            setReportError(false)
            store.dispatch({ type: 'edit-report', editorId, patch: { reason } })
          }} />{reason}
        </label>)}</div>
        {report.reason === '其他' && <label>理由<input type="text" required maxLength={80} aria-invalid={reportError || undefined} value={report.customReason} onChange={(event) => {
          setReportError(false)
          store.dispatch({ type: 'edit-report', editorId, patch: { customReason: event.target.value } })
        }} /></label>}
        {reportError && <p role="alert">请选择举报理由{report.reason === '其他' ? '并填写理由' : ''}</p>}
      </fieldset>}
      <label className="visually-hidden" htmlFor={`${ids}-content`}>
        {report !== undefined ? '举报内容' : '正文'}
      </label>
      <textarea
        ref={textareaRef}
        id={`${ids}-content`}
        className="editor-content"
        rows={layout === 'float' ? 10 : 5}
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
    <div className="editor-fields">
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

  const identityRow = (
    <IdentityRow editor={editor} notice={identityNotice} compact={layout === 'float'} onChoose={(id) => void chooseIdentity(id)} />
  )

  const confirm = confirmDiscard && !locked && (
    <div className="editor-confirm" role="group" aria-labelledby={`${ids}-confirm`}>
      <p id={`${ids}-confirm`}>
        {editor.draft === null
          ? '放弃这份编辑的全部内容？'
          : `放弃未保存的修改，回到 ${formatLocalTime(editor.draft.savedAt)} 保存的版本？`}
      </p>
      <div className="editor-confirm-actions">
        <button ref={confirmRef} type="button" className="btn btn-danger" onClick={discard}>
          放弃
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setConfirmDiscard(false)
            discardRef.current?.focus()
          }}
        >
          取消
        </button>
      </div>
    </div>
  )

  const status = (
    <div className="editor-status" role="status">
      <span className="editor-state">{statusText}</span>
      <SendStatus editor={editor} />
    </div>
  )

  const saveFailure = saveError !== null && !saving && !locked && (
    <p className="notice-inline is-warning editor-error" role="alert">
      <Icon name="alert" size={14} />
      {SAVE_FAILURE_TEXT[saveError]}
    </p>
  )

  const actions = (
    <div className="editor-actions">
      {ended ? (
        <>
          <button type="button" className="btn" aria-haspopup={PROTOTYPE_ENABLED ? undefined : 'dialog'} onClick={openAttempts}>
            <Icon name="history" />
            查看发送记录
          </button>
          <button
            type="button"
            className="btn"
            title="内容与这次发送一起保留在发送记录中"
            onClick={() => store.endPublication(editorId)}
          >
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
            ref={discardRef}
            type="button"
            className="btn"
            disabled={!canDiscard}
            onClick={() => (unsaved ? setConfirmDiscard(true) : discard())}
          >
            放弃修改
          </button>
          <button
            type="button"
            className="btn"
            aria-label="保存草稿"
            aria-keyshortcuts={saveAriaShortcut(platform)}
            aria-disabled={!unsaved || saving || locked}
            aria-busy={saving || undefined}
            title={locked ? '发送进行中，不能另存' : unsaved ? undefined : '没有需要保存的内容'}
            onClick={save}
          >
            <Icon name="download" />
            保存草稿
            {saveShortcut !== '' && <kbd className="editor-kbd">{saveShortcut}</kbd>}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            aria-keyshortcuts={sendAriaShortcut(platform)}
            aria-disabled={locked || undefined}
            aria-busy={locked || undefined}
            onClick={send}
          >
            {locked ? <Spinner /> : <Icon name="send" />}
            {publication === null
              ? sendLabel
              : publication.phase === 'prompt'
                ? '等待选择饼干…'
                : publication.phase === 'submitting'
                  ? '正在提交…'
                  : '正在发送…'}
            {sendShortcut !== '' && !locked && <kbd className="editor-kbd">{sendShortcut}</kbd>}
          </button>
        </>
      )}
    </div>
  )

  if (layout === 'float') {
    return (
      <div className="editor-panel is-float" data-editor-id={editorId} ref={panelRef} onKeyDown={onKeyDown}>
        <header className="editor-float-head">
          <h2 className="editor-float-title">
            <Icon name={editor.target.kind === 'reply' ? 'reply' : 'draft'} />
            <span>{label}</span>
            {locked && <span className="editor-fixed">已固定</span>}
          </h2>
          {identityRow}
          <div className="editor-head-actions">
            {report === undefined && retargetButton}
            <button type="button" className="icon-btn" aria-label="收起（内容保留）" title="收起（Esc）" onClick={collapse}>
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div className="editor-float-body">
          {retargetForm}
          {content}
          <details className="editor-more" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
            <summary>
              <Icon name="chevron" size={14} className="disclosure-icon" />
              更多字段
              <span className="editor-hint">标题、名称、E-mail</span>
            </summary>
            {fields}
          </details>
          <AttachmentRow editor={editor} compact />
        </div>

        <footer className="editor-float-foot">
          {confirm}
          {saveFailure}
          <div className="editor-float-foot-row">
            {status}
            {actions}
          </div>
        </footer>
      </div>
    )
  }

  return (
    <div className="editor-panel" data-editor-id={editorId} ref={panelRef} onKeyDown={onKeyDown}>
      <header className="editor-head">
        <div className="editor-head-text">
          <p className="editor-target">
            <Icon name={editor.target.kind === 'reply' ? 'reply' : 'draft'} />
            <span>{label}</span>
          </p>
          <p className="editor-meta">
            饼干：
            <IdentityValue line={identity} />
            {locked && <span className="editor-fixed">· 已固定</span>}
          </p>
        </div>
        <div className="editor-head-actions">
          {retargetButton}
          <button type="button" className="btn btn-small" aria-expanded={true} onClick={collapse} title="收起，内容保留">
            <Icon name="arrowUp" size={14} className="editor-collapse-icon" />
            收起
          </button>
        </div>
      </header>

      <div className="editor-body">
        {retargetForm}

        {content}

        {fields}

        <AttachmentRow editor={editor} />

        {identityRow}
      </div>

      <footer className="editor-foot">
        {confirm}
        {status}
        {saveFailure}
        {actions}
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
        ? `没有发送：${PROBLEM_TEXT[notice.reason]}。`
        : notice.kind === 'failed'
          ? `发送失败${notice.problem === null ? '' : `：${ATTEMPT_PROBLEM_TEXT[notice.problem]}`}。${
              notice.saved ? '内容已自动保存为草稿，确认后可再次发送。' : '自动保存草稿没有成功，内容仍在编辑中，请先保存。'
            }`
          : '核对结果：这次发送没有留下记录，没有发出。内容已解锁，可以再次发送。'
    return (
      <p className="notice-inline is-warning editor-send-notice">
        <Icon name="alert" size={14} />
        {text}
      </p>
    )
  }
  switch (publication.phase) {
    case 'submitting':
      return <span className="editor-note">内容已锁定，正在提交…</span>
    case 'prompt':
      return <span className="editor-note">请在对话框中选择发言饼干；内容保持不变。</span>
    case 'uncertain':
      return (
        <p className="notice-inline is-warning editor-send-notice">
          <Icon name="alert" size={14} />
          {publication.checking
            ? '正在按这次发送的编号核对本地记录…'
            : '应用内部请求出错，暂时无法确认这次发送是否已经记录。内容已锁定，避免重复投递；请重新核对。'}
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
                暂时读不到本地发送状态，正在继续读取；不会重新发送。
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
          <p className="editor-note">开始于 {formatLocalTime(publication.attempt.createdAt)}；可以结束编辑，内容会留在发送记录中。</p>
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

/** `compact` (float layout): no 未附图 / 有图时可用 explanations. */
function AttachmentRow({ editor, compact = false }: { editor: Editor; compact?: boolean }) {
  const { store } = useEditorWorkspace()
  const ids = useId()
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
    if (reason !== null) setError(`未能${replacing ? '更换' : '添加'}图片：${reason}${replacing ? '，原来的图片仍保留' : ''}`)
  }

  return (
    <div className="editor-attachment">
      {attachment !== null && (
        <div className="editor-thumb">
          {previewFailed === attachment.id ? (
            <span className="editor-thumb-failed">无法显示预览</span>
          ) : (
            <img src={attachment.url} alt={`附图预览：${attachment.originalName}`} onError={() => setPreviewFailed(attachment.id)} />
          )}
        </div>
      )}
      <div className="editor-attachment-text">
        {attachment === null ? (
          !compact && <span className="editor-hint">未附图（单张）</span>
        ) : (
          <>
            <span className="editor-attachment-name">{attachment.originalName}</span>
            <span className="editor-hint">
              {attachment.width}×{attachment.height} · {attachment.format.toUpperCase()} · {formatBytes(attachment.bytes)}
            </span>
          </>
        )}
        <div className="editor-attachment-actions">
          <button
            type="button"
            className="btn btn-small"
            aria-busy={busy || undefined}
            disabled={busy || locked}
            onClick={() => void choose()}
          >
            <Icon name="image" size={14} />
            {busy ? '正在选择图片…' : attachment === null ? '添加图片' : '更换图片'}
          </button>
          {attachment !== null && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy || locked}
              onClick={() => {
                setError(null)
                store.dispatch({ type: 'set-attachment', editorId, attachment: null })
              }}
            >
              <Icon name="close" size={14} />
              移除图片
            </button>
          )}
          <WatermarkSwitch editor={editor} helpId={`${ids}-wm`} hint={!compact} />
        </div>
        {error !== null && (
          <p className="notice-inline is-warning" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

function WatermarkSwitch({ editor, helpId, hint }: { editor: Editor; helpId: string; hint: boolean }) {
  const { store } = useEditorWorkspace()
  const hasImage = editor.attachment !== null
  const on = editor.fields.watermark
  return (
    <span className="editor-watermark">
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-describedby={hasImage || !hint ? undefined : helpId}
        disabled={!hasImage || editor.publication !== null}
        onClick={() => store.dispatch({ type: 'edit', editorId: editor.id, patch: { watermark: !on } })}
      >
        <span className="switch-thumb" aria-hidden="true" />
        <span>水印</span>
        <span className="switch-state" aria-hidden="true">
          {on ? '开' : '关'}
        </span>
      </button>
      {!hasImage && hint && (
        <span className="editor-hint" id={helpId}>
          有图时可用
        </span>
      )}
    </span>
  )
}

/** `compact` (float layout header): no 会记住为该串的选择 explanation. */
function IdentityRow({
  editor,
  notice,
  compact = false,
  onChoose
}: {
  editor: Editor
  notice: string | null
  compact?: boolean
  onChoose: (credentialId: CredentialId) => void
}) {
  const { identities } = useEditorWorkspace()
  const openSettings = useSettingsOpener()
  const id = useId()
  const { overview, failed } = identities
  const status = identityStatus(editor, overview)
  const credentials = overview?.credentials ?? []
  const value = status.state === 'selected' ? status.credentialId : ''
  const placeholder =
    overview === null
      ? failed
        ? '饼干列表读取失败'
        : '读取中…'
      : status.state === 'missing'
        ? '已移除，需要重新选择'
        : status.state === 'unknown'
          ? '无法读取原选择，请选择'
          : credentials.length === 0
            ? '尚未导入饼干'
            : '请选择饼干'
  return (
    <div className="editor-identity-row">
      <label htmlFor={id}>发言饼干</label>
      <select
        id={id}
        value={value}
        disabled={overview === null || credentials.length === 0 || editor.publication !== null}
        aria-invalid={status.state === 'missing' || status.state === 'unknown' ? true : undefined}
        onChange={(event) => {
          if (event.target.value !== '') onChoose(event.target.value)
        }}
      >
        {value === '' && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {credentials.map((credential) => (
          <option key={credential.id} value={credential.id}>
            {credential.name}
          </option>
        ))}
      </select>
      {overview !== null && credentials.length === 0 && openSettings !== null && (
        <button type="button" className="btn btn-small" onClick={() => openSettings('cookies')}>
          导入饼干
        </button>
      )}
      {!compact && editor.target.kind === 'reply' && editor.publication === null && <span className="editor-hint">会记住为该串的选择</span>}
      {notice !== null && (
        <p className="notice-inline is-warning" role="alert">
          <Icon name="alert" size={14} />
          {notice}
        </p>
      )}
    </div>
  )
}

function RetargetForm({ editor, compact, onDone }: { editor: Editor; compact: boolean; onDone: () => void }) {
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
      setMessage(`本标签已有「${targetText(target, forumName)}」的编辑，目标未更改`)
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
      {!compact && <p className="editor-hint editor-retarget-note">饼干不变；确定后本标签会打开新目标。</p>}
      {message !== null && (
        <p className="notice-inline is-warning" role="alert">
          <Icon name="alert" size={14} />
          {message}
        </p>
      )}
    </form>
  )
}
