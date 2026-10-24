import { constants } from 'node:fs'
import { copyFile, lstat, open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { StorageStatus } from '../../shared/api'
import type {
  AttachmentId,
  AttachResult,
  DraftAttachment,
  DraftDeleteResult,
  DraftListResult,
  DraftSaveInput,
  DraftSaveResult,
  EditorId,
  IdentityChoice,
  PostTarget,
  SavedDraft
} from '../../shared/drafts'
import type { CredentialId, IdentityMutationResult } from '../../shared/identity'
import { IMAGE_SCHEME } from '../../shared/images'
import type { ThreadId } from '../../shared/forum'
import type { ManagedImageFiles } from '../images/files'
import { inspectImage } from '../images/format'
import type { DraftAttachmentRecord, DraftRecord, DraftStore, IdentityStore } from '../storage/contract'

export interface DraftService {
  list(): Promise<DraftListResult>
  save(input: DraftSaveInput): Promise<DraftSaveResult>
  delete(id: string): Promise<DraftDeleteResult>
  /**
   * Copies the chosen file (`null`: chooser dismissed) into the managed draft image directory and
   * holds the copy for `editorId`. The chosen file is only read.
   */
  attachImage(owner: string, editorId: EditorId, sourcePath: string | null): Promise<AttachResult>
  /** The attachment `editorId` currently shows (`null`: none); the previous one is no longer held by it. */
  holdAttachment(owner: string, editorId: EditorId, attachmentId: AttachmentId | null): Promise<void>
  releaseEditor(owner: string, editorId: EditorId): Promise<void>
  /** The renderer went away: none of its editors hold anything any more. */
  releaseOwner(owner: string): Promise<void>
  identityFor(target: PostTarget): Promise<IdentityChoice>
  /** Explicit 串内 selection; changes neither the global default nor any other thread. */
  selectThreadIdentity(threadId: ThreadId, credentialId: CredentialId): Promise<IdentityMutationResult>
  /** Startup: no editor exists yet, so copies no draft references are removed with leftover files. */
  recover(): Promise<void>
}

type SourceProblem = 'source-unreadable' | 'no-space' | 'storage'

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function isNoSpace(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOSPC' || code === 'EDQUOT'
}

export function createDraftService(deps: {
  store: DraftStore & IdentityStore & { readonly status: StorageStatus }
  files: ManagedImageFiles
  /** Copies `source` to the new temporary path `destination`. */
  copy?: (source: string, destination: string) => Promise<void>
  now?: () => Date
}): DraftService {
  const { store, files } = deps
  const copy = deps.copy ?? ((source, destination) => copyFile(source, destination, constants.COPYFILE_EXCL))
  const now = deps.now ?? (() => new Date())
  const writable = () => store.status.state === 'ready'
  /** owner → editor → attachment it shows. Held copies are never reclaimed. */
  const holds = new Map<string, Map<EditorId, AttachmentId>>()
  /** Attach, save, delete and reclaim run one at a time, so a new copy is held before any reclaim. */
  let queue: Promise<unknown> = Promise.resolve()

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work)
    queue = result.catch(() => undefined)
    return result
  }

  function attachment(record: DraftAttachmentRecord): DraftAttachment {
    return {
      id: record.id,
      format: record.format,
      bytes: record.bytes,
      width: record.width,
      height: record.height,
      originalName: record.originalName,
      url: `${IMAGE_SCHEME}://draft/${record.fileName}`
    }
  }

  function savedDraft(record: DraftRecord): SavedDraft {
    return {
      id: record.id,
      target: record.target,
      credentialId: record.credentialId,
      fields: record.fields,
      attachment: record.attachment === null ? null : attachment(record.attachment),
      version: record.version,
      createdAt: record.createdAt,
      savedAt: record.savedAt
    }
  }

  async function fileExists(fileName: string): Promise<boolean> {
    const path = files.pathOf(fileName)
    if (path === null) return false
    try {
      return (await lstat(path)).isFile()
    } catch {
      return false
    }
  }

  /** Removes attachment copies that no draft references and no editor holds. Failures wait for the next run. */
  async function reclaim(): Promise<void> {
    if (!writable()) return
    const keep = [...holds.values()].flatMap((editors) => [...editors.values()])
    try {
      for (const name of await store.deleteUnreferencedAttachments(keep)) await files.remove(name).catch(() => undefined)
    } catch {
      // Left for the next reclaim or startup recovery.
    }
  }

  function setHold(owner: string, editorId: EditorId, attachmentId: AttachmentId | null): boolean {
    const editors = holds.get(owner) ?? new Map<EditorId, AttachmentId>()
    const previous = editors.get(editorId) ?? null
    if (attachmentId === null) editors.delete(editorId)
    else editors.set(editorId, attachmentId)
    if (editors.size === 0) holds.delete(owner)
    else holds.set(owner, editors)
    return previous !== null && previous !== attachmentId
  }

  /** Copies the chosen file to a temporary path; the source is opened read-only first. */
  async function copySource(sourcePath: string, partial: string): Promise<SourceProblem | null> {
    try {
      const handle = await open(sourcePath, 'r')
      try {
        if (!(await handle.stat()).isFile()) return 'source-unreadable'
      } finally {
        await handle.close()
      }
    } catch {
      return 'source-unreadable'
    }
    try {
      await copy(sourcePath, partial)
      return null
    } catch (error) {
      await files.remove(partial).catch(() => undefined)
      if (isNoSpace(error)) return 'no-space'
      const code = errorCode(error)
      return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' ? 'source-unreadable' : 'storage'
    }
  }

  return {
    async list() {
      if (store.status.state === 'unavailable') return { ok: false, reason: 'storage' }
      try {
        return { ok: true, drafts: (await store.listDrafts()).map(savedDraft) }
      } catch {
        return { ok: false, reason: 'storage' }
      }
    },

    save(input) {
      return serialized(async (): Promise<DraftSaveResult> => {
        if (!writable()) return { ok: false, reason: 'storage' }
        try {
          if (input.attachmentId !== null) {
            const record = await store.getDraftAttachment(input.attachmentId)
            if (record === null || !(await fileExists(record.fileName))) return { ok: false, reason: 'attachment-missing' }
          }
          const outcome = await store.saveDraft(input, now().toISOString())
          if (!outcome.ok) return outcome
          await reclaim()
          return { ok: true, draft: savedDraft(outcome.draft) }
        } catch {
          return { ok: false, reason: 'storage' }
        }
      })
    },

    delete(id) {
      return serialized(async (): Promise<DraftDeleteResult> => {
        if (!writable()) return { ok: false, reason: 'storage' }
        try {
          if (await store.deleteDraft(id) === 'locked') return { ok: false, reason: 'locked' }
        } catch {
          return { ok: false, reason: 'storage' }
        }
        await reclaim()
        return { ok: true }
      })
    },

    attachImage(owner, editorId, sourcePath) {
      return serialized(async (): Promise<AttachResult> => {
        if (sourcePath === null) return { ok: false, reason: 'cancelled' }
        if (!writable()) return { ok: false, reason: 'storage' }
        const partial = files.partialPath()
        const problem = await copySource(sourcePath, partial)
        if (problem !== null) return { ok: false, reason: problem }
        let committed: string | null = null
        try {
          const handle = await open(partial, 'r')
          let inspection
          let bytes
          try {
            bytes = (await handle.stat()).size
            inspection = bytes > 0 ? await inspectImage(handle, bytes) : ({ ok: false, reason: 'not-image' } as const)
          } finally {
            await handle.close()
          }
          if (!inspection.ok) {
            await files.remove(partial)
            return { ok: false, reason: inspection.reason === 'too-large' ? 'too-large' : 'not-image' }
          }
          committed = await files.commit(partial, inspection.format)
          const record = await store.insertDraftAttachment({
            fileName: committed,
            format: inspection.format,
            bytes,
            width: inspection.width,
            height: inspection.height,
            originalName: basename(sourcePath).slice(0, 255),
            createdAt: now().toISOString()
          })
          if (setHold(owner, editorId, record.id)) await reclaim()
          return { ok: true, attachment: attachment(record) }
        } catch (error) {
          await files.remove(committed ?? partial).catch(() => undefined)
          return { ok: false, reason: isNoSpace(error) ? 'no-space' : 'storage' }
        }
      })
    },

    holdAttachment(owner, editorId, attachmentId) {
      return serialized(async () => {
        if (setHold(owner, editorId, attachmentId)) await reclaim()
      })
    },

    releaseEditor(owner, editorId) {
      return serialized(async () => {
        if (setHold(owner, editorId, null)) await reclaim()
      })
    },

    releaseOwner(owner) {
      return serialized(async () => {
        if (!holds.delete(owner)) return
        await reclaim()
      })
    },

    async identityFor(target) {
      if (store.status.state === 'unavailable') return { source: 'unknown' }
      try {
        if (target.kind === 'reply') {
          const own = await store.getThreadPostIdentity(target.threadId)
          if (own.state !== 'none') return { source: 'thread', selection: own }
        }
        return { source: 'default', selection: (await store.loadRoleSelections())['default-post'] }
      } catch {
        return { source: 'unknown' }
      }
    },

    async selectThreadIdentity(threadId, credentialId) {
      if (!writable()) return { ok: false, reason: 'storage' }
      try {
        return (await store.setThreadPostIdentity(threadId, credentialId, now().toISOString()))
          ? { ok: true }
          : { ok: false, reason: 'not-found' }
      } catch {
        return { ok: false, reason: 'storage' }
      }
    },

    recover() {
      return serialized(async () => {
        if (!writable()) return
        await reclaim()
        await files.sweep(new Set(await store.listDraftAttachmentFileNames()))
      })
    }
  }
}
