import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { IMAGE_FORMAT_EXTENSION, type ImageFormat } from '../../shared/images'

/** Committed managed file: 32 hex characters and the detected format's extension. */
const MANAGED_NAME = /^[0-9a-f]{32}\.(jpg|png|gif|webp)$/
/** File still being written (or left behind by an interrupted write). */
const PARTIAL_NAME = /^[0-9a-f]{32}\.part$/

export const IMAGE_MEDIA_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp'
}

export function isManagedName(name: string): boolean {
  return MANAGED_NAME.test(name)
}

/**
 * The app's image directory. Only names it generated are ever written, served or deleted here;
 * user-chosen files elsewhere are never touched, and symbolic links are never followed or removed.
 */
export interface ManagedImageFiles {
  readonly directory: string
  /** A new exclusive temporary path for one download. */
  partialPath(): string
  /** Renames a finished temporary file to a new managed name for `format`; returns that name. */
  commit(partialPath: string, format: ImageFormat): Promise<string>
  /** Absolute path of a managed name, or null for anything that is not one. */
  pathOf(name: string): string | null
  /** Removes a managed or temporary file; a missing file is not an error. */
  remove(nameOrPartialPath: string): Promise<void>
  /**
   * Removes temporary files and managed files no record points at (a write interrupted before or
   * after its rename, or a record deleted before its file). Returns the removed names.
   */
  sweep(recorded: ReadonlySet<string>): Promise<string[]>
}

export async function openManagedImageFiles(directory: string): Promise<ManagedImageFiles> {
  await mkdir(directory, { recursive: true })
  const token = () => randomBytes(16).toString('hex')

  async function removeRegular(path: string): Promise<boolean> {
    try {
      if (!(await lstat(path)).isFile()) return false
      await unlink(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  return {
    directory,
    partialPath: () => join(directory, `${token()}.part`),
    async commit(partialPath, format) {
      const name = `${token()}.${IMAGE_FORMAT_EXTENSION[format]}`
      await rename(partialPath, join(directory, name))
      return name
    },
    pathOf: (name) => (isManagedName(name) ? join(directory, name) : null),
    async remove(nameOrPartialPath) {
      const name = nameOrPartialPath.startsWith(directory) ? nameOrPartialPath.slice(directory.length + 1) : nameOrPartialPath
      if (!isManagedName(name) && !PARTIAL_NAME.test(name)) return
      await removeRegular(join(directory, name))
    },
    async sweep(recorded) {
      const removed: string[] = []
      for (const name of await readdir(directory)) {
        const orphan = PARTIAL_NAME.test(name) || (isManagedName(name) && !recorded.has(name))
        if (!orphan) continue
        try {
          if (await removeRegular(join(directory, name))) removed.push(name)
        } catch {
          // Still locked or not removable now: left for the next sweep.
        }
      }
      return removed
    }
  }
}
