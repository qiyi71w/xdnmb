import type { AttachFailure, DraftAttachment, PostFields, PostTarget } from '../../../../shared/drafts'
import type { CredentialId, IdentityOverview } from '../../../../shared/identity'
import { formatRecordTime } from '../../lib/time'
import { ATTEMPT_STATE_LABEL } from '../publication/publicationText'
import { isUnsaved, type Editor } from './editorsState'
import type { SaveFailure } from './useEditorsStore'

export function forumLabel(forumId: string, forumName: (forumId: string | null) => string | null): string {
  return forumName(forumId) ?? `版面 ${forumId}`
}

/** “回复 No.X” / “在「X」发新串”. */
export function targetText(target: PostTarget, forumName: (forumId: string | null) => string | null): string {
  return target.kind === 'reply' ? `回复 No.${target.threadId}` : `在「${forumLabel(target.forumId, forumName)}」发新串`
}

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

/** 未保存 / 草稿·已保存 时间 / 草稿·有未保存修改; a locked editor shows its send instead. */
export function editorStateText(editor: Editor): string {
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
  if (editor.draft === null) return '未保存'
  return isUnsaved(editor) ? '草稿·有未保存修改' : `草稿·已保存 ${formatRecordTime(editor.draft.savedAt)}`
}

export const SAVE_FAILURE_TEXT: Record<SaveFailure, string> = {
  storage: '未能保存：本地存储不可用',
  'not-found': '未能保存：原草稿已不存在',
  'attachment-missing': '未能保存：附图副本已丢失，请重新添加图片',
  locked: '未能保存：发送结果未定，内容已锁定',
  internal: '未能保存：应用内部请求失败'
}

export const ATTACH_FAILURE_TEXT: Record<Exclude<AttachFailure, 'cancelled'> | 'internal', string> = {
  'source-unreadable': '无法读取所选文件',
  'not-image': '所选文件不是 JPEG、PNG、GIF 或 WebP 图片',
  'too-large': '图片尺寸过大，无法使用',
  'no-space': '磁盘空间不足，无法复制图片',
  storage: '本地存储不可用，无法保存图片副本',
  internal: '应用内部请求失败'
}
