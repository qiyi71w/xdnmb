import { describe, expect, it } from 'vitest'
import { createAppDocumentMatcher } from '../src/main/app-document'

// Frame URLs below are spelled as Chromium reports them after `loadFile` (observed with Electron
// 45): `~`, `[`, `]` stay unescaped, spaces and non-ASCII are percent-encoded, and a Windows drive
// letter is uppercased. The renderer path keeps the spelling the app was started with.
const NAME = '%E6%B1%90%E5%B2%9B' // 汐岛

describe('app document on Windows', () => {
  // Started from a lowercase drive, from an 8.3 short folder, under a folder named with brackets.
  const isAppDocument = createAppDocumentMatcher({
    rendererFile: 'c:\\Users\\RUNNER~1\\Apps\\汐岛 [x64]\\resources\\app.asar\\out\\renderer\\index.html',
    windows: true
  })
  const page = `file:///C:/Users/RUNNER~1/Apps/${NAME}%20[x64]/resources/app.asar/out/renderer/index.html`

  it('recognizes the loaded page whatever the spelling of the drive letter and special characters', () => {
    expect(isAppDocument(page)).toBe(true)
    expect(isAppDocument(`${page}?view=1#post-3`)).toBe(true)
    expect(isAppDocument(`file:///c:/Users/RUNNER%7E1/Apps/${NAME}%20%5Bx64%5D/resources/app.asar/out/renderer/index.html`)).toBe(true)
  })

  it('refuses every other document', () => {
    for (const url of [
      `file:///C:/Users/RUNNER~1/Apps/${NAME}%20[x64]/resources/app.asar/out/renderer/other.html`,
      `file:///C:/Users/RUNNER~1/Apps/${NAME}%20[x64]/resources/app.asar/out/renderer/index.html/x`,
      `file:///D:/Users/RUNNER~1/Apps/${NAME}%20[x64]/resources/app.asar/out/renderer/index.html`,
      // Only the drive letter is case-insensitive: Chromium keeps the rest as the app spelled it.
      `file:///C:/users/RUNNER~1/Apps/${NAME}%20[x64]/resources/app.asar/out/renderer/index.html`,
      `file://server/C:/Users/RUNNER~1/Apps/${NAME}%20[x64]/resources/app.asar/out/renderer/index.html`,
      // An encoded separator must not let another path spell the same string.
      `file:///C:/Users/RUNNER~1/Apps/${NAME}%20[x64]/resources/app.asar/out/renderer%5Cindex.html`,
      `file:///C:/Users/RUNNER~1/Apps/${NAME}%20[x64]/resources/app.asar/out/renderer/index%zz.html`,
      'https://example.com/out/renderer/index.html',
      'xidao-image://file/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      'about:blank',
      'not a url'
    ]) expect(isAppDocument(url), url).toBe(false)
  })
})

describe('app document on macOS and Linux', () => {
  const isAppDocument = createAppDocumentMatcher({
    rendererFile: '/Applications/Old [2] ~/汐岛.app/Contents/Resources/app.asar/out/renderer/index.html',
    windows: false
  })
  const folder = `/Applications/Old%20[2]%20~/${NAME}.app/Contents/Resources/app.asar/out/renderer`

  it('recognizes the loaded page under a folder named with brackets and a tilde', () => {
    expect(isAppDocument(`file://${folder}/index.html`)).toBe(true)
  })

  it('refuses another file, another case, an encoded separator or a remote host', () => {
    for (const url of [
      `file://${folder}/other.html`,
      `file://${folder.replace('Applications', 'applications')}/index.html`,
      `file://${folder}%2Findex.html`,
      `file://server${folder}/index.html`
    ]) expect(isAppDocument(url), url).toBe(false)
  })
})

describe('app document in development', () => {
  const isAppDocument = createAppDocumentMatcher({ rendererFile: '/repo/out/renderer/index.html', devUrl: 'http://localhost:5173', windows: false })

  it('recognizes any page of the development server and nothing else', () => {
    expect(isAppDocument('http://localhost:5173/src/index.html?x=1')).toBe(true)
    expect(isAppDocument('http://localhost:5174/')).toBe(false)
    expect(isAppDocument('file:///repo/out/renderer/index.html')).toBe(false)
  })
})
