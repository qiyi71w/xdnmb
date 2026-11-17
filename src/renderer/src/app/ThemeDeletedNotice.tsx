import { MAX_CUSTOM_THEMES } from '../../../shared/themeList'
import { BottomNotice, UNDO_WINDOW } from '../components/BottomNotice'
import type { ThemeListOperations, ThemeRestoreFailure } from './useThemeListOperations'

const FAILURE_TEXT: Record<ThemeRestoreFailure, string> = {
  full: `没能撤销：已有 ${MAX_CUSTOM_THEMES} 个自定义主题`,
  'not-saved': '没能撤销：设置未保存'
}

/**
 * 主题已删除 for the latest deleted theme, timed and closed like 草稿已删除: 撤销 puts the theme back
 * at its place (in use again if it was). A failed 撤销 keeps the notice, saying why, until closed.
 * Another deletion replaces it, ending this 撤销.
 */
export function ThemeDeletedNotice({ operations, fallbackFocus }: { operations: ThemeListOperations; fallbackFocus: () => HTMLElement | null }) {
  const { deletion, undo, forget } = operations
  if (deletion === null) return null
  return (
    <BottomNotice
      key={deletion.key}
      open
      icon="trash"
      tone="neutral"
      context={deletion.deleted.theme.name}
      detail={deletion.failure === null ? null : FAILURE_TEXT[deletion.failure]}
      expiresAfter={deletion.failure === null ? UNDO_WINDOW : null}
      onExpire={() => forget(deletion.key)}
      actions={[
        { label: '撤销', busy: deletion.restoring, onAction: undo },
        { label: '关闭', icon: 'close', busy: deletion.restoring, onAction: () => forget(deletion.key) }
      ]}
      fallbackFocus={fallbackFocus}
    >
      主题已删除
    </BottomNotice>
  )
}
