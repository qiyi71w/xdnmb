import type { IdentityStatus } from '../../src/renderer/src/features/editor/editorsState'
import { editorForDraft, editorsReducer, identityStatus, INITIAL_EDITORS } from '../../src/renderer/src/features/editor/editorsState'
import { createDraftService } from '../../src/main/drafts/service'
import type { SecretProtector } from '../../src/main/identity/protection'
import { createIdentityService } from '../../src/main/identity/service'
import { openManagedImageFiles } from '../../src/main/images/files'
import type { ReadingDatabase } from '../../src/main/storage/database'
import { asStore } from './store'

/**
 * The 发言饼干 of the editor continuing each saved draft (a removed 饼干 is `missing`, shown as
 * “已移除，需要重新选择”), read the way the running app reads it: the drafts and the 饼干 list
 * through their main-process services, then the renderer's editor model opened on each draft.
 * Pairs of draft text and status, sorted by text.
 */
export async function draftIdentities(db: ReadingDatabase, draftImagesDirectory: string, protector: SecretProtector): Promise<Array<[string, IdentityStatus]>> {
  const store = asStore(db)
  const overview = await createIdentityService({ store, protector, storageState: () => db.status.state }).getOverview()
  const listed = await createDraftService({ store, files: await openManagedImageFiles(draftImagesDirectory) }).list()
  if (!listed.ok) throw new Error(`drafts ${listed.reason}`)
  return listed.drafts.map((draft): [string, IdentityStatus] => {
    const editor = editorForDraft(editorsReducer(INITIAL_EDITORS, { type: 'open-draft', tabId: 1, draft }), draft.id)
    if (editor === null) throw new Error('no editor for the draft')
    return [draft.fields.content, identityStatus(editor, overview)]
  }).sort(([a], [b]) => a.localeCompare(b))
}
