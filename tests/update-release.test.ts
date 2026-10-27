import { describe, expect, it } from 'vitest'
import { releaseNotesFromHtml } from '../src/main/updates/notes'
import { classifyUpdateError, isAllowedUpdateRequest, ReleaseSourceError, selectPackage } from '../src/main/updates/release'

const PAGE = 'https://github.com/qiyi71w/xdnmb/releases/tag/v0.2.0'
const SHA = `${'A'.repeat(86)}==`

describe('release notes', () => {
  it('keeps headings, lists, code and https links as data and drops scripts, handlers, images and unsafe links', () => {
    const html = `
      <h2>新功能 <script>alert(1)</script></h2>
      <p onclick="steal()">支持<strong>关于</strong>页，<a href="javascript:alert(1)">危险</a> 与 <a href="/qiyi71w/xdnmb/pull/3">#3</a><img src=x onerror=alert(1)></p>
      <ul><li>一<ul><li>一点一</li></ul></li><li><p>二</p></li></ul>
      <pre><code>npm run dist:win</code></pre>
      <iframe src="https://evil.example"></iframe><style>body{display:none}</style>`
    expect(releaseNotesFromHtml(html, PAGE)).toEqual([
      { kind: 'heading', level: 2, content: [{ kind: 'text', text: '新功能' }] },
      {
        kind: 'paragraph',
        content: [
          { kind: 'text', text: '支持' },
          { kind: 'text', text: '关于', strong: true },
          { kind: 'text', text: '页，危险 与 ' },
          { kind: 'link', text: '#3', url: 'https://github.com/qiyi71w/xdnmb/pull/3' }
        ]
      },
      { kind: 'list', ordered: false, items: [
        { depth: 0, content: [{ kind: 'text', text: '一' }] },
        { depth: 1, content: [{ kind: 'text', text: '一点一' }] },
        { depth: 0, content: [{ kind: 'text', text: '二' }] }
      ] },
      { kind: 'code', text: 'npm run dist:win' }
    ])
  })

  it('reports a release without notes as having none', () => {
    expect(releaseNotesFromHtml('No content.', PAGE)).toEqual([])
    expect(releaseNotesFromHtml(null, PAGE)).toEqual([])
    expect(releaseNotesFromHtml('<p> </p><script>x()</script>', PAGE)).toEqual([])
  })
})

describe('update source', () => {
  it('allows only https requests to this repository on github.com and the release asset hosts', () => {
    expect(isAllowedUpdateRequest('https://github.com/qiyi71w/xdnmb/releases.atom')).toBe(true)
    expect(isAllowedUpdateRequest('https://github.com/qiyi71w/xdnmb/releases/latest')).toBe(true)
    expect(isAllowedUpdateRequest('https://github.com/qiyi71w/xdnmb/releases/download/v0.2.0/latest.yml?noCache=1')).toBe(true)
    expect(isAllowedUpdateRequest('https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r')).toBe(true)
    expect(isAllowedUpdateRequest('http://github.com/qiyi71w/xdnmb/releases/latest')).toBe(false)
    expect(isAllowedUpdateRequest('https://github.com/someone/xdnmb/releases/latest')).toBe(false)
    expect(isAllowedUpdateRequest('https://github.com/qiyi71w/xdnmb-releases/latest')).toBe(false)
    expect(isAllowedUpdateRequest('https://github.com:8443/qiyi71w/xdnmb/releases/latest')).toBe(false)
    expect(isAllowedUpdateRequest('https://user:pass@github.com/qiyi71w/xdnmb/releases/latest')).toBe(false)
    expect(isAllowedUpdateRequest('https://api.nmb.best/api/getForumList')).toBe(false)
  })

  it('takes only the exact package for this system and architecture, with a well-formed checksum', () => {
    const files = [
      { url: 'xidao-0.2.0-mac-x64.dmg', sha512: SHA, size: 10 },
      { url: 'xidao-0.2.0-mac-arm64.dmg', sha512: SHA, size: 10 },
      { url: 'xidao-0.2.0-win-x64.exe', sha512: SHA, size: 10 }
    ]
    expect(selectPackage('0.2.0', files, { platform: 'mac', arch: 'arm64' })?.url).toBe('xidao-0.2.0-mac-arm64.dmg')
    expect(selectPackage('0.2.0', files, { platform: 'windows' })?.url).toBe('xidao-0.2.0-win-x64.exe')
    expect(selectPackage('0.3.0', files, { platform: 'windows' })).toBeNull()
    expect(selectPackage('0.2.0', [{ url: '../xidao-0.2.0-win-x64.exe', sha512: SHA }], { platform: 'windows' })).toBeNull()
    expect(selectPackage('0.2.0', [{ url: 'xidao-0.2.0-win-x64.exe', sha512: 'abc' }], { platform: 'windows' })).toBeNull()
    expect(selectPackage('0.2.0', [files[2]!, files[2]!], { platform: 'windows' })).toBeNull()
  })

  it('classifies failures without trusting their text', () => {
    expect(classifyUpdateError(Object.assign(new Error('sha512 checksum mismatch, expected x, got y'), { code: 'ERR_CHECKSUM_MISMATCH' }))).toBe('integrity')
    expect(classifyUpdateError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toBe('network')
    expect(classifyUpdateError(new Error('net::ERR_BLOCKED_BY_CLIENT'))).toBe('source')
    expect(classifyUpdateError(Object.assign(new Error('no space'), { code: 'ENOSPC' }))).toBe('storage')
    expect(classifyUpdateError(Object.assign(new Error('404'), { statusCode: 404 }))).toBe('source')
    expect(classifyUpdateError(Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }))).toBe('source')
    // GitHub answers with a valid feed that has no release yet.
    expect(classifyUpdateError(Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_XML_MISSED_ELEMENT' }))).toBe('source')
    expect(classifyUpdateError(new ReleaseSourceError('wrong file'))).toBe('source')
  })
})
