import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { sameTarget, targetKey, type IdentityChoice, type PostFields, type PostTarget } from '../../../../shared/drafts'
import type { CredentialId } from '../../../../shared/identity'
import { saveAriaShortcut, shortcutLabel } from '../../app/shortcuts'
import { Icon } from '../../components/Icon'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { formatLocalTime } from '../../lib/format'
import { formatBytes } from '../image/imageView'
import type { IdentitiesState } from '../identity/useIdentities'
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
  const [opening, setOpening] = useState(false)
  const targetRef = useRef(target)
  useLayoutEffect(() => {
    targetRef.current = target
  })
  const key = targetKey(target)
  const hasEditor = editor !== null

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

  const expand = async () => {
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

function EditorPanel({
  editor,
  label,
  displayed,
  focusBar
}: {
  editor: Editor
  label: string
  displayed: boolean
  focusBar: RefObject<boolean>
}) {
  const { store, identities, platform } = useEditorWorkspace()
  const { focusRequest, requestFocus } = store
  const ids = useId()
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

  const edit = (patch: Partial<PostFields>) => store.dispatch({ type: 'edit', editorId, patch })

  const collapse = () => {
    focusBar.current = true
    store.dispatch({ type: 'set-expanded', editorId, expanded: false })
  }

  const save = () => {
    if (!unsaved || saving) return
    void store.save(editorId)
  }

  const discard = () => {
    setConfirmDiscard(false)
    if (editor.draft === null) focusBar.current = true
    else textareaRef.current?.focus()
    store.dispatch({ type: 'discard', editorId })
  }

  const chooseIdentity = async (credentialId: CredentialId) => {
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
  const canDiscard = !saving && (unsaved || editor.draft === null)
  const saveShortcut = shortcutLabel('save', platform)
  const statusText = saving ? '正在保存…' : editorStateText(editor)

  return (
    <div className="editor-panel" data-editor-id={editorId}>
      <header className="editor-head">
        <div className="editor-head-text">
          <p className="editor-target">
            <Icon name={editor.target.kind === 'reply' ? 'reply' : 'draft'} />
            <span>{label}</span>
          </p>
          <p className="editor-meta">
            饼干：
            <IdentityValue line={identity} />
          </p>
        </div>
        <div className="editor-head-actions">
          <button
            ref={retargetRef}
            type="button"
            className="btn btn-small"
            aria-expanded={retargeting}
            onClick={() => setRetargeting((open) => !open)}
          >
            更改目标
          </button>
          <button type="button" className="btn btn-small" aria-expanded={true} onClick={collapse} title="收起，内容保留">
            <Icon name="arrowUp" size={14} className="editor-collapse-icon" />
            收起
          </button>
        </div>
      </header>

      <div className="editor-body">
        {retargeting && (
          <RetargetForm
            editor={editor}
            onDone={() => {
              setRetargeting(false)
              retargetRef.current?.focus()
            }}
          />
        )}

        <label className="visually-hidden" htmlFor={`${ids}-content`}>
          正文
        </label>
        <textarea
          ref={textareaRef}
          id={`${ids}-content`}
          className="editor-content"
          rows={5}
          placeholder="正文"
          value={editor.fields.content}
          onChange={(event) => edit({ content: event.target.value })}
        />

        <div className="editor-fields">
          <FieldInput id={`${ids}-title`} label="标题" value={editor.fields.title} onChange={(title) => edit({ title })} />
          <FieldInput id={`${ids}-name`} label="名称" value={editor.fields.name} onChange={(name) => edit({ name })} />
          <FieldInput
            id={`${ids}-email`}
            label="E-mail"
            value={editor.fields.email}
            onChange={(email) => edit({ email })}
            type="email"
          />
        </div>

        <AttachmentRow editor={editor} />

        <IdentityRow editor={editor} notice={identityNotice} onChoose={(id) => void chooseIdentity(id)} />
      </div>

      <footer className="editor-foot">
        {confirmDiscard && (
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
        )}
        <div className="editor-status" role="status">
          <span className="editor-state">{statusText}</span>
          <span className="editor-note">发送尚未接入，可先保存为草稿</span>
        </div>
        {saveError !== null && !saving && (
          <p className="notice-inline is-warning editor-error" role="alert">
            <Icon name="alert" size={14} />
            {SAVE_FAILURE_TEXT[saveError]}
          </p>
        )}
        <div className="editor-actions">
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
            className="btn btn-primary"
            aria-label="保存草稿"
            aria-keyshortcuts={saveAriaShortcut(platform)}
            aria-disabled={!unsaved || saving}
            aria-busy={saving || undefined}
            title={unsaved ? undefined : '没有需要保存的内容'}
            onClick={save}
          >
            <Icon name="download" />
            保存草稿
            {saveShortcut !== '' && <kbd className="editor-kbd">{saveShortcut}</kbd>}
          </button>
        </div>
      </footer>
    </div>
  )
}

function FieldInput({
  id,
  label,
  value,
  onChange,
  type = 'text'
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email'
}) {
  return (
    <div className="editor-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

function AttachmentRow({ editor }: { editor: Editor }) {
  const { store } = useEditorWorkspace()
  const ids = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const attachment = editor.attachment
  const editorId = editor.id

  const choose = async () => {
    if (busy) return
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
          <span className="editor-hint">未附图（单张）</span>
        ) : (
          <>
            <span className="editor-attachment-name">{attachment.originalName}</span>
            <span className="editor-hint">
              {attachment.width}×{attachment.height} · {attachment.format.toUpperCase()} · {formatBytes(attachment.bytes)}
            </span>
          </>
        )}
        <div className="editor-attachment-actions">
          <button type="button" className="btn btn-small" aria-busy={busy || undefined} disabled={busy} onClick={() => void choose()}>
            <Icon name="image" size={14} />
            {busy ? '正在选择图片…' : attachment === null ? '添加图片' : '更换图片'}
          </button>
          {attachment !== null && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => {
                setError(null)
                store.dispatch({ type: 'set-attachment', editorId, attachment: null })
              }}
            >
              <Icon name="close" size={14} />
              移除图片
            </button>
          )}
          <WatermarkSwitch editor={editor} helpId={`${ids}-wm`} />
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

function WatermarkSwitch({ editor, helpId }: { editor: Editor; helpId: string }) {
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
        aria-describedby={hasImage ? undefined : helpId}
        disabled={!hasImage}
        onClick={() => store.dispatch({ type: 'edit', editorId: editor.id, patch: { watermark: !on } })}
      >
        <span className="switch-thumb" aria-hidden="true" />
        <span>水印</span>
        <span className="switch-state" aria-hidden="true">
          {on ? '开' : '关'}
        </span>
      </button>
      {!hasImage && (
        <span className="editor-hint" id={helpId}>
          有图时可用
        </span>
      )}
    </span>
  )
}

function IdentityRow({
  editor,
  notice,
  onChoose
}: {
  editor: Editor
  notice: string | null
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
        disabled={overview === null || credentials.length === 0}
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
        <button type="button" className="btn btn-small" onClick={openSettings}>
          导入饼干
        </button>
      )}
      {editor.target.kind === 'reply' && <span className="editor-hint">会记住为该串的选择</span>}
      {notice !== null && (
        <p className="notice-inline is-warning" role="alert">
          <Icon name="alert" size={14} />
          {notice}
        </p>
      )}
    </div>
  )
}

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
      <p className="editor-hint editor-retarget-note">饼干不变；确定后本标签会打开新目标。</p>
      {message !== null && (
        <p className="notice-inline is-warning" role="alert">
          <Icon name="alert" size={14} />
          {message}
        </p>
      )}
    </form>
  )
}
