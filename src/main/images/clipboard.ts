import { constants } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { ImageCopyOutcome, ImageFormat } from '../../shared/images'
import type { ManagedImageFiles } from './files'
import { inspectImage } from './format'
import { MAX_IMAGE_BYTES } from './service'

export interface DecodedOriginal {
  width: number
  height: number
  animated: boolean
  /** Complete, unscaled decoded image, only for a static original. */
  png: Uint8Array | null
}

export interface OriginalClipboard {
  copy(path: string): Promise<ImageCopyOutcome>
  /** Keeps only files still referenced by the native clipboard; never follows symlinks. */
  recover(): Promise<void>
}

/** The spool is separate from the cache: viewer release, quota and refresh cannot remove it. */
export function createOriginalClipboard(options: {
  files: ManagedImageFiles
  decode(bytes: Buffer, format: ImageFormat): Promise<DecodedOriginal>
  writeImage(png: Uint8Array): Promise<void>
  writeFiles(uri: string): Promise<void>
  /** Main-only, file references only. No clipboard text/history is exposed to the renderer. */
  referencedFiles(): Promise<ReadonlySet<string>>
}): OriginalClipboard {
  let busy = false
  const recover = async () => {
    // An unavailable clipboard is not evidence that its file references have disappeared.
    const referenced = await options.referencedFiles()
    await options.files.sweep(new Set([...referenced].filter((name) => options.files.pathOf(name) !== null)))
  }
  return {
    async recover() {
      if (busy) return
      busy = true
      try {
        await recover()
      } finally {
        busy = false
      }
    },
    async copy(path) {
      if (busy) return { status: 'busy' }
      busy = true
      let staged: string | null = null
      let committed = false
      try {
        // One no-follow handle supplies both inspection and decoding: metadata and payload cannot
        // come from different files. Windows ignores O_NOFOLLOW; lstat in the caller rejects links.
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let bytes: Buffer
        let format: ImageFormat
        let width: number
        let height: number
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES.original) return { status: 'invalid-image' }
          const inspection = await inspectImage(handle, stat.size)
          if (!inspection.ok) return { status: 'invalid-image' }
          ;({ format, width, height } = inspection)
          bytes = await handle.readFile()
          if (bytes.length !== stat.size) return { status: 'invalid-image' }
        } finally {
          await handle.close()
        }
        let decoded: DecodedOriginal
        try {
          decoded = await options.decode(bytes, format)
        } catch {
          return { status: 'invalid-image' }
        }
        if (decoded.width !== width || decoded.height !== height) return { status: 'invalid-image' }
        if (decoded.animated) {
          const partial = options.files.partialPath()
          staged = partial
          await writeFile(partial, bytes, { flag: 'wx', mode: 0o600 })
          staged = await options.files.commit(partial, format)
          const file = options.files.pathOf(staged)
          if (file === null) throw new Error('invalid managed clipboard file')
          await options.writeFiles(pathToFileURL(file).href)
        } else {
          if (decoded.png === null || decoded.png.length === 0) return { status: 'invalid-image' }
          await options.writeImage(decoded.png)
        }
        committed = true
        // A cleanup error does not undo an already committed native clipboard operation.
        await recover().catch(() => undefined)
        return { status: 'copied', representation: decoded.animated ? 'file' : 'image' }
      } catch {
        return { status: 'failed' }
      } finally {
        if (!committed && staged !== null) await options.files.remove(staged).catch(() => undefined)
        busy = false
      }
    }
  }
}
