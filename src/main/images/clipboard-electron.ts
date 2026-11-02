import { BrowserWindow, clipboard, ClipboardItem } from 'electron'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ImageFormat } from '../../shared/images'
import { createOriginalClipboard, type DecodedOriginal, type OriginalClipboard } from './clipboard'
import type { ManagedImageFiles } from './files'
import decoderPage from './clipboard-decoder.html?asset'

const MEDIA_TYPE: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

/** Decode in Chromium's sandbox, not a native main-process image parser. No remote page or preload. */
export async function decodeClipboardOriginal(bytes: Buffer, format: ImageFormat): Promise<DecodedOriginal> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let timer: NodeJS.Timeout | undefined
  try {
    const decode = async () => {
      await window.loadFile(decoderPage)
      const result: { width: number; height: number; animated: boolean; png: string | null } = await window.webContents.executeJavaScript(`(async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0))
        const decoder = new ImageDecoder({ data: bytes, type: ${JSON.stringify(MEDIA_TYPE[format])}, preferAnimation: true })
        try {
          await decoder.tracks.ready
          const track = decoder.tracks.selectedTrack
          if (!track || track.frameCount < 1) throw new Error('No image frames')
          let width = 0, height = 0, png = null
          const animated = track.animated
          for (let index = 0; index < track.frameCount; index++) {
            const { image, complete } = await decoder.decode({ frameIndex: index, completeFramesOnly: true })
            try {
              if (!complete) throw new Error('Incomplete frame')
              if (index === 0) {
                width = image.displayWidth; height = image.displayHeight
                if (!animated) {
                  const canvas = new OffscreenCanvas(width, height)
                  canvas.getContext('2d').drawImage(image, 0, 0)
                  const blob = await canvas.convertToBlob({ type: 'image/png' })
                  const data = new Uint8Array(await blob.arrayBuffer())
                  let binary = ''
                  for (let offset = 0; offset < data.length; offset += 32768) binary += String.fromCharCode(...data.subarray(offset, offset + 32768))
                  png = btoa(binary)
                }
              }
            } finally { image.close() }
          }
          return { width, height, animated, png }
        } finally { decoder.close() }
      })()`)
      return { ...result, png: result.png === null ? null : Buffer.from(result.png, 'base64') }
    }
    const deadline = Promise.withResolvers<never>()
    timer = setTimeout(() => deadline.reject(new Error('Image decode timed out')), 30_000)
    return await Promise.race([decode(), deadline.promise])
  } finally {
    clearTimeout(timer)
    if (!window.isDestroyed()) window.destroy()
  }
}

export function createElectronOriginalClipboard(files: ManagedImageFiles): OriginalClipboard {
  return createOriginalClipboard({
    files,
    decode: decodeClipboardOriginal,
    writeImage: (png) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]),
    writeFiles: (uri) => clipboard.write([new ClipboardItem({ 'text/uri-list': `${uri}\r\n` })]),
    async referencedFiles() {
      const names = new Set<string>()
      if (!await clipboard.has('text/uri-list')) return names
      // Read only the native file-reference representation; never inspect text, HTML or chat data.
      for (const item of await clipboard.read()) {
        if (!item.types.includes('text/uri-list')) continue
        const uris = await (await item.getType('text/uri-list')).text()
        for (const uri of uris.split(/\r?\n/)) {
          if (!uri.startsWith('file:')) continue
          let path: string
          try { path = fileURLToPath(uri) } catch { continue }
          if (resolve(dirname(path)) !== resolve(files.directory)) continue
          const name = basename(path)
          if (files.pathOf(name) !== null) names.add(name)
        }
      }
      return names
    }
  })
}
