import { createContext, useContext } from 'react'
import type { AppPlatform } from '../../../../shared/api'
import type { EditorId, PostTarget } from '../../../../shared/drafts'
import type { BoardDirectory } from '../../../../shared/forum'
import type { IdentitiesState } from '../identity/useIdentities'
import type { EditorsStore } from './useEditorsStore'

/** What editor panels need from the app shell. */
export interface EditorWorkspace {
  store: EditorsStore
  identities: IdentitiesState
  platform: AppPlatform | null
  directory: BoardDirectory | null
  forumName: (forumId: string | null) => string | null
  /**
   * Explicit 更改目标: moves the editor to `target` (identity unchanged) and shows that target in
   * the editor's tab. `occupied`: the tab already edits that target; nothing changed.
   */
  retarget: (editorId: EditorId, target: PostTarget) => 'done' | 'occupied'
}

export const EditorWorkspaceContext = createContext<EditorWorkspace | null>(null)

export function useEditorWorkspace(): EditorWorkspace {
  const workspace = useContext(EditorWorkspaceContext)
  if (workspace === null) throw new Error('EditorWorkspaceContext missing')
  return workspace
}
