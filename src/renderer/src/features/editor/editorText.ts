import type { AttachFailure, DraftAttachment, PostFields } from '../../../../shared/drafts'
import type { CredentialId, IdentityOverview } from '../../../../shared/identity'
import { formatRecordTime } from '../../lib/time'
import { ATTEMPT_STATE_LABEL } from '../publication/publicationText'
import { isBlank, type Editor } from './editorsState'
import type { SaveFailure } from './useEditorsStore'

/** One-line summary of what an editor or draft holds. */
export function excerpt(fields: PostFields, attachment: DraftAttachment | null, max = 60): string {
  const text = (fields.content.trim() === '' ? fields.title : fields.content).replace(/\s+/g, ' ').trim()
  if (text === '') return attachment === null ? '（无正文）' : '（只有图片）'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export const MISSING_IDENTITY_TEXT = '已移除，需要重新选择'

export interface IdentityLine {
  text: string
  warning: boolean
}

/** Name of a referenced credential; a reference without its credential is missing. */
export function credentialLine(credentialId: CredentialId | null, overview: IdentityOverview | null): IdentityLine {
  if (credentialId === null) return { text: '未选择饼干', warning: false }
  if (overview === null) return { text: '读取中…', warning: false }
  const credential = overview.credentials.find((item) => item.id === credentialId)
  return credential === undefined ? { text: MISSING_IDENTITY_TEXT, warning: true } : { text: credential.name, warning: false }
}

/**
 * The editor's toolbar status: a locked editor shows its send; otherwise “已存草稿 时间” once it
 * continues a draft, and nothing while it is blank, not saved yet, or saving (`saving`).
 */
export function editorStateText(editor: Editor, saving: boolean): string {
  const publication = editor.publication
  if (publication !== null) {
    switch (publication.phase) {
      case 'submitting':
        return '正在提交发送…'
      case 'prompt':
        return '等待确认发言饼干'
      case 'uncertain':
        return '提交情况待核对'
      case 'attempt':
        return ATTEMPT_STATE_LABEL[publication.attempt.state]
    }
  }
  if (saving || editor.draft === null || isBlank(editor)) return ''
  return `已存草稿 ${formatRecordTime(editor.draft.savedAt)}`
}

/** Why the draft is not up to date, after “草稿没能保存”. */
export const SAVE_FAILURE_TEXT: Record<SaveFailure, string> = {
  storage: '本地存储不可用',
  'not-found': '原草稿已不存在',
  'attachment-missing': '附图副本已丢失，请重新添加图片',
  locked: '发送还没结束，内容已锁定',
  internal: '应用内部请求失败'
}

/** Why another draft could not be continued in the editor already on its target. */
export function loadFailureText(reason: SaveFailure): string {
  return reason === 'locked'
    ? '没能载入：这个目标的编辑正在发送，发送结束后再试'
    : `没能载入：当前编辑没能先存为草稿（${SAVE_FAILURE_TEXT[reason]}）`
}

export const ATTACH_FAILURE_TEXT: Record<Exclude<AttachFailure, 'cancelled'> | 'internal', string> = {
  'source-unreadable': '无法读取所选文件',
  'not-image': '所选文件不是 JPEG、PNG、GIF 或 WebP 图片',
  'too-large': '图片尺寸过大，无法使用',
  'no-space': '磁盘空间不足，无法复制图片',
  storage: '本地存储不可用，无法保存图片副本',
  internal: '应用内部请求失败'
}
