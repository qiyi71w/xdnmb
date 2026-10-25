import { describe, expect, it } from 'vitest'
import type { RequestScheduler } from '../src/main/reading/scheduler'
import {
  ACCOUNT_ORIGIN,
  AccountError,
  isAllowedAccountRead,
  isAllowedLoginRequest,
  parseAccountExport,
  parseAccountList
} from '../src/main/account/protocol'
import { createAccountClient } from '../src/main/account/client'

// Synthetic fixtures only; no real forum credentials, tokens, or network requests.
const SYNTHETIC_SECRET = 'SyntheticMemberSecretValue123456789'
const PAGE_URL = new URL('/Member/User/Cookie/index.html', ACCOUNT_ORIGIN)

function makeListHtml(rowsHtml: string, paginationHtml = ''): string {
  return `<!DOCTYPE html>
<html>
<head><title>饼干列表 - X岛</title></head>
<body>
<table>
  <thead>
    <tr><th><input type="checkbox"></th><th>ID</th><th>饼干</th><th>有效时间</th><th>领取时间</th><th>操作</th></tr>
  </thead>
  <tbody>
    ${rowsHtml}
  </tbody>
</table>
<div class="pagination">${paginationHtml}</div>
</body>
</html>`
}

function makeRow(
  id: string,
  publicId = `SyntheticCookie_${id}`,
  validUntil = '2027-12-31 23:59:59',
  claimedAt = '2026-01-01 12:00:00',
  exportHref = `/Member/User/Cookie/export/id/${id}.html`,
  extraAction = ''
): string {
  // Observed 2026-10-25: a leading checkbox column, the public ID linked to "/", and 应用／二维码／删除.
  return `<tr>
  <td><input type="checkbox" value="${id}"></td>
  <td>${id}</td>
  <td><a href="/">${publicId}</a></td>
  <td>${validUntil}</td>
  <td>${claimedAt}</td>
  <td><a href="/Member/User/Cookie/switchTo/id/${id}.html">应用</a> <a href="${exportHref}">二维码</a>${extraAction} <a href="/Member/User/Cookie/delete/id/${id}.html">删除</a></td>
</tr>`
}

function makeExportPayload(userhash: string, name?: string): string {
  const data = name !== undefined ? { cookie: userhash, name } : { cookie: userhash }
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64')
}

function makeExportHtml(
  payload: string,
  host = 'publicapi.ovear.info',
  path = '/qrcode.php',
  scheme = 'https'
): string {
  return `<!DOCTYPE html>
<html>
<head><title>导出饼干 - X岛</title></head>
<body>
<div class="card">
  <img src="${scheme}://${host}${path}?text=${encodeURIComponent(payload)}" alt="qrcode" />
</div>
</body>
</html>`
}

function createDirectScheduler(): RequestScheduler {
  return {
    run: async (_lane, signal, work) => {
      if (signal.aborted) throw new AccountError('cancelled')
      return work(signal)
    }
  }
}

describe('isAllowedAccountRead guard', () => {
  it('allows same-origin index and pagination URLs', () => {
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/index.html', ACCOUNT_ORIGIN))).toBe(true)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/index', ACCOUNT_ORIGIN))).toBe(true)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/index/page/2.html', ACCOUNT_ORIGIN))).toBe(true)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/index/p/3', ACCOUNT_ORIGIN))).toBe(true)
  })

  it('allows same-origin export URLs with valid positive numeric IDs and no query parameters', () => {
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/export/id/1.html', ACCOUNT_ORIGIN))).toBe(true)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/export/id/12345.html', ACCOUNT_ORIGIN))).toBe(true)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/export/id/9007199254740991.html', ACCOUNT_ORIGIN))).toBe(true)
  })

  it('denies export URLs with query parameters or malformed identifiers', () => {
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/export/id/123.html?debug=1', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/export/id/0.html', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/export/id/abc.html', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/export/id/-1.html', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/export/id/123456789012345678901.html', ACCOUNT_ORIGIN))).toBe(false)
  })

  it('denies action and mutation endpoints unconditionally', () => {
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/switchTo/id/101.html', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/delete/id/101.html', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('/Member/User/Cookie/apply.html', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('/Member/User/Index/logout.html', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('/qrcode.php', ACCOUNT_ORIGIN))).toBe(false)
    expect(isAllowedAccountRead(new URL('https://publicapi.ovear.info/qrcode.php'))).toBe(false)
  })

  it('denies cross-origin, insecure scheme, userinfo credentials, and pathname encoding tricks', () => {
    expect(isAllowedAccountRead(new URL('http://www.nmbxd1.com/Member/User/Cookie/index.html'))).toBe(false)
    expect(isAllowedAccountRead(new URL('https://evil.example.com/Member/User/Cookie/index.html'))).toBe(false)
    expect(isAllowedAccountRead(new URL('https://user:pass@www.nmbxd1.com/Member/User/Cookie/index.html'))).toBe(false)
    expect(isAllowedAccountRead(new URL('https://www.nmbxd1.com/Member/User/Cookie/index%2ehtml'))).toBe(false)
    expect(isAllowedAccountRead(new URL('https://www.nmbxd1.com/Member/User/Cookie/index%2f..'))).toBe(false)
  })
})

describe('isAllowedLoginRequest guard', () => {
  it('allows login page GET and POST requests', () => {
    const loginUrl = `${ACCOUNT_ORIGIN}/Member/User/Index/login.html`
    expect(isAllowedLoginRequest(loginUrl, 'GET', 'document')).toBe(true)
    expect(isAllowedLoginRequest(loginUrl, 'POST', 'document')).toBe(true)
    expect(isAllowedLoginRequest(loginUrl, 'PUT', 'document')).toBe(false)
    expect(isAllowedLoginRequest(loginUrl, 'DELETE', 'document')).toBe(false)
  })

  it('allows verify captcha for image resourceType only with GET', () => {
    const verifyUrl = `${ACCOUNT_ORIGIN}/Member/User/Index/verify.html`
    expect(isAllowedLoginRequest(verifyUrl, 'GET', 'image')).toBe(true)
    expect(isAllowedLoginRequest(verifyUrl, 'POST', 'image')).toBe(false)
    expect(isAllowedLoginRequest(verifyUrl, 'GET', 'script')).toBe(false)
    expect(isAllowedLoginRequest(verifyUrl, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(verifyUrl, 'GET', 'fetch')).toBe(false)
  })

  it('allows safe same-origin static assets for matching resource types', () => {
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/css/main.css`, 'GET', 'stylesheet')).toBe(true)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/public/js/login.js`, 'GET', 'script')).toBe(true)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/assets/img/logo.png`, 'GET', 'image')).toBe(true)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/static/fonts/font.woff2`, 'GET', 'font')).toBe(true)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/favicon.ico`, 'GET', 'image')).toBe(true)
  })

  it('denies dangerous actions including switchTo, delete, apply, logout, and qrcode', () => {
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Cookie/switchTo/id/101.html`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Cookie/switchTo/id/101.html`, 'POST', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Cookie/delete/id/101.html`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Cookie/delete/id/101.html`, 'POST', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Cookie/apply.html`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Cookie/apply.html`, 'POST', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Index/logout.html`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Index/logout.html`, 'POST', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Cookie/index.html`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Cookie/export/id/101.html`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest('https://publicapi.ovear.info/qrcode.php?text=payload', 'GET', 'image')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/qrcode.php`, 'GET', 'image')).toBe(false)
  })

  it('denies static assets requested with mismatched methods or unexpected resource types', () => {
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/css/main.css`, 'POST', 'stylesheet')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/css/main.css`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/js/login.js`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/css/main.css`, 'GET', 'fetch')).toBe(false)
  })

  it('denies encoded tricks, path traversal, userinfo, cross-origin, and unsafe file types', () => {
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/%2e%2e/Member/User/Index/logout.html`, 'GET', 'script')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Member/User/Index/login%2ehtml`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/evil.php`, 'GET', 'script')).toBe(false)
    expect(isAllowedLoginRequest(`${ACCOUNT_ORIGIN}/Public/exec.exe`, 'GET', 'script')).toBe(false)
    expect(isAllowedLoginRequest(`https://user:pass@www.nmbxd1.com/Member/User/Index/login.html`, 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest('https://attacker.example.com/Member/User/Index/login.html', 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest('http://www.nmbxd1.com/Member/User/Index/login.html', 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest('javascript:alert(1)', 'GET', 'document')).toBe(false)
    expect(isAllowedLoginRequest('not-a-valid-url', 'GET', 'document')).toBe(false)
  })
})

describe('parseAccountList HTML adapter', () => {
  it('parses valid table rows and returns matching AccountCookie objects', () => {
    const html = makeListHtml(`
      ${makeRow('101', 'Cookie_A', '2027-01-01', '2026-01-01')}
      ${makeRow('102', 'Cookie_B', '2027-06-30', '2026-02-15')}
    `)

    const result = parseAccountList(html, PAGE_URL)
    expect(result.cookies).toEqual([
      { id: '101', publicId: 'Cookie_A', validUntil: '2027-01-01', claimedAt: '2026-01-01' },
      { id: '102', publicId: 'Cookie_B', validUntil: '2027-06-30', claimedAt: '2026-02-15' }
    ])
    expect(result.pages).toEqual([])
  })

  it('preserves large numeric IDs and trims inner cell whitespace', () => {
    const html = makeListHtml(
      makeRow('9007199254740991', '  Cookie_Spaced  ', '  2028-01-01  ', '  2026-01-01  ')
    )
    const result = parseAccountList(html, PAGE_URL)
    expect(result.cookies[0]).toEqual({
      id: '9007199254740991',
      publicId: 'Cookie_Spaced',
      validUntil: '2028-01-01',
      claimedAt: '2026-01-01'
    })
  })

  it('reads the site empty date as unknown, not as a time', () => {
    const result = parseAccountList(makeListHtml(makeRow('101', 'Cookie_A', '0000-00-00 00:00:00', '2022-06-20 16:42:06')), PAGE_URL)
    expect(result.cookies[0]).toMatchObject({ validUntil: null, claimedAt: '2022-06-20 16:42:06' })
  })

  it('extracts and dedupes same-origin index pagination links while ignoring non-index links', () => {
    const html = makeListHtml(
      makeRow('101'),
      `
      <a href="/Member/User/Cookie/index/p/2.html">2</a>
      <a href="/Member/User/Cookie/index/p/2.html">2重复</a>
      <a href="/Member/User/Cookie/index/p/3.html">3</a>
      <a href="/Member/User/Cookie/export/id/101.html">导出</a>
      <a href="https://external.example.com/Member/User/Cookie/index/p/4.html">外链</a>
      <a href="/Member/User/Cookie/apply.html">申请</a>
      `
    )

    const result = parseAccountList(html, PAGE_URL)
    expect(result.pages.map((u) => u.href)).toEqual([
      `${ACCOUNT_ORIGIN}/Member/User/Cookie/index/p/2.html`,
      `${ACCOUNT_ORIGIN}/Member/User/Cookie/index/p/3.html`
    ])
  })

  it('throws AccountError expired on 跳转提示, password inputs, or login form actions', () => {
    const redirectHtml = '<html><head><title>系统跳转提示 - X岛</title></head><body>请登录后再操作</body></html>'
    expect(() => parseAccountList(redirectHtml, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(redirectHtml, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('expired')
    }

    const passwordHtml = '<html><body><form><input type="password" name="pwd" /></form></body></html>'
    expect(() => parseAccountList(passwordHtml, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(passwordHtml, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('expired')
    }

    const loginFormHtml = '<html><body><form action="/Member/User/Index/login.html"><button>登录</button></form></body></html>'
    expect(() => parseAccountList(loginFormHtml, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(loginFormHtml, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('expired')
    }
  })

  it('throws AccountError unknown-structure on missing or altered table headers', () => {
    expect(() => parseAccountList('<html><body><div>没有表格</div></body></html>', PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList('<html><body><div>没有表格</div></body></html>', PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }

    const wrongHeadersHtml = `<table><tr><th>ID</th><th>饼干</th><th>状态</th><th>时间</th><th>操作</th></tr></table>`
    expect(() => parseAccountList(wrongHeadersHtml, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(wrongHeadersHtml, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })

  it('throws AccountError unknown-structure when row cell count is not exactly 5', () => {
    const fourCells = `<table><tr><th>ID</th><th>饼干</th><th>有效时间</th><th>领取时间</th><th>操作</th></tr><tr><td>1</td><td>A</td><td>B</td><td>C</td></tr></table>`
    expect(() => parseAccountList(fourCells, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(fourCells, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })

  it('throws AccountError unknown-structure when export link ID mismatches row ID', () => {
    const mismatch = makeListHtml(makeRow('101', 'Cookie_A', '2027', '2026', '/Member/User/Cookie/export/id/102.html'))
    expect(() => parseAccountList(mismatch, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(mismatch, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })

  it('throws AccountError unknown-structure on missing or multiple export links in the action cell', () => {
    const noExportLink = makeListHtml('<tr><td>101</td><td>Cookie</td><td>2027</td><td>2026</td><td>无链接</td></tr>')
    expect(() => parseAccountList(noExportLink, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(noExportLink, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }

    const multipleLinks = makeListHtml(makeRow('101', 'Cookie', '2027', '2026', '/Member/User/Cookie/export/id/101.html', '<a href="/Member/User/Cookie/export/id/101.html">再次导出</a>'))
    expect(() => parseAccountList(multipleLinks, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(multipleLinks, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })

  it('throws AccountError unknown-structure when export link contains query parameters', () => {
    const queryLink = makeListHtml(makeRow('101', 'Cookie', '2027', '2026', '/Member/User/Cookie/export/id/101.html?token=123'))
    expect(() => parseAccountList(queryLink, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(queryLink, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })

  it('throws AccountError unknown-structure on non-numeric row ID or empty mandatory cells', () => {
    const nonNumericId = makeListHtml(makeRow('abc', 'Cookie', '2027', '2026', '/Member/User/Cookie/export/id/abc.html'))
    expect(() => parseAccountList(nonNumericId, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(nonNumericId, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }

    const emptyPublicId = makeListHtml(makeRow('101', '', '2027', '2026'))
    expect(() => parseAccountList(emptyPublicId, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(emptyPublicId, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })

  it('throws AccountError unknown-structure on duplicate cookie IDs within the same page', () => {
    const duplicateRows = makeListHtml(`
      ${makeRow('101', 'Cookie_One')}
      ${makeRow('101', 'Cookie_Two')}
    `)
    expect(() => parseAccountList(duplicateRows, PAGE_URL)).toThrowError(AccountError)
    try {
      parseAccountList(duplicateRows, PAGE_URL)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })
})

describe('parseAccountExport HTML adapter', () => {
  it('extracts and validates export payload from publicapi.ovear.info qrcode image text param', () => {
    const expectedPayload = makeExportPayload('SyntheticUserhashAlpha123', 'MyCookie')
    const html = makeExportHtml(expectedPayload)
    const result = parseAccountExport(html)
    expect(result).toBe(expectedPayload)
  })

  it('throws AccountError expired when export page shows login redirect or password form', () => {
    const expiredHtml = '<title>跳转提示</title><p>请先登录</p>'
    expect(() => parseAccountExport(expiredHtml)).toThrowError(AccountError)
    try {
      parseAccountExport(expiredHtml)
    } catch (error) {
      expect((error as AccountError).reason).toBe('expired')
    }
  })

  it('throws AccountError unknown-structure when no qrcode image or multiple qrcode images exist', () => {
    const noImg = '<html><body><div>导出成功但没有图片</div></body></html>'
    expect(() => parseAccountExport(noImg)).toThrowError(AccountError)
    try {
      parseAccountExport(noImg)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }

    const payload = makeExportPayload('SyntheticUserhashAlpha123')
    const doubleImg = `<html><body>
      <img src="https://publicapi.ovear.info/qrcode.php?text=${encodeURIComponent(payload)}" />
      <img src="https://publicapi.ovear.info/qrcode.php?text=${encodeURIComponent(payload)}" />
    </body></html>`
    expect(() => parseAccountExport(doubleImg)).toThrowError(AccountError)
    try {
      parseAccountExport(doubleImg)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })

  it('throws AccountError unknown-structure for untrusted image domain, wrong path, or invalid protocol', () => {
    const payload = makeExportPayload('SyntheticUserhashAlpha123')
    const evilHost = makeExportHtml(payload, 'evil.example.com')
    expect(() => parseAccountExport(evilHost)).toThrowError(AccountError)
    try {
      parseAccountExport(evilHost)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }

    const wrongPath = makeExportHtml(payload, 'publicapi.ovear.info', '/other.php')
    expect(() => parseAccountExport(wrongPath)).toThrowError(AccountError)
    try {
      parseAccountExport(wrongPath)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }

    const ftpScheme = makeExportHtml(payload, 'publicapi.ovear.info', '/qrcode.php', 'ftp')
    expect(() => parseAccountExport(ftpScheme)).toThrowError(AccountError)
    try {
      parseAccountExport(ftpScheme)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })

  it('throws AccountError unknown-structure when text parameter fails credential parse', () => {
    const invalidTextHtml = makeExportHtml('not-a-valid-base64-or-json-payload')
    expect(() => parseAccountExport(invalidTextHtml)).toThrowError(AccountError)
    try {
      parseAccountExport(invalidTextHtml)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }

    const noTextParamHtml = `<html><body><img src="https://publicapi.ovear.info/qrcode.php" /></body></html>`
    expect(() => parseAccountExport(noTextParamHtml)).toThrowError(AccountError)
    try {
      parseAccountExport(noTextParamHtml)
    } catch (error) {
      expect((error as AccountError).reason).toBe('unknown-structure')
    }
  })
})

describe('createAccountClient', () => {
  it('crawls pagination, dedupes URLs and cookies across pages, and returns aggregated rows', async () => {
    const requestedUrls: string[] = []
    const requestedSecrets: string[] = []
    const recordedLanes: string[] = []

    const page1Html = makeListHtml(
      `${makeRow('101', 'Cookie_A')}\n${makeRow('102', 'Cookie_B')}`,
      '<a href="/Member/User/Cookie/index/p/2.html">2</a>'
    )
    const page2Html = makeListHtml(
      `${makeRow('102', 'Cookie_B_Duplicated')}\n${makeRow('103', 'Cookie_C')}`,
      '<a href="/Member/User/Cookie/index.html">1</a>\n<a href="/Member/User/Cookie/index/p/2.html">2</a>'
    )

    const scheduler: RequestScheduler = {
      run: async (lane, signal, work) => {
        recordedLanes.push(lane)
        return work(signal)
      }
    }

    const client = createAccountClient({
      request: async (url, secret) => {
        requestedUrls.push(url.href)
        requestedSecrets.push(secret)
        if (url.pathname === '/Member/User/Cookie/index.html') return page1Html
        if (url.pathname === '/Member/User/Cookie/index/p/2.html') return page2Html
        throw new Error(`Unexpected URL ${url.href}`)
      },
      scheduler
    })

    const signal = new AbortController().signal
    const cookies = await client.list(SYNTHETIC_SECRET, signal)

    expect(requestedUrls).toEqual([
      `${ACCOUNT_ORIGIN}/Member/User/Cookie/index.html`,
      `${ACCOUNT_ORIGIN}/Member/User/Cookie/index/p/2.html`
    ])
    expect(requestedSecrets).toEqual([SYNTHETIC_SECRET, SYNTHETIC_SECRET])
    expect(recordedLanes).toEqual(['foreground', 'foreground'])
    expect(cookies).toEqual([
      { id: '101', publicId: 'Cookie_A', validUntil: '2027-12-31 23:59:59', claimedAt: '2026-01-01 12:00:00' },
      { id: '102', publicId: 'Cookie_B_Duplicated', validUntil: '2027-12-31 23:59:59', claimedAt: '2026-01-01 12:00:00' },
      { id: '103', publicId: 'Cookie_C', validUntil: '2027-12-31 23:59:59', claimedAt: '2026-01-01 12:00:00' }
    ])
  })

  it('throws AccountError unknown-structure when pagination exceeds 20 pages with unseen pages remaining', async () => {
    let visitedCount = 0
    const client = createAccountClient({
      request: async (url) => {
        visitedCount++
        const match = /\/p\/(\d+)\.html$/.exec(url.pathname)
        const current = match ? parseInt(match[1]!, 10) : 1
        const next = current + 1
        return makeListHtml(
          makeRow(String(100 + current)),
          `<a href="/Member/User/Cookie/index/p/${next}.html">${next}</a>`
        )
      },
      scheduler: createDirectScheduler()
    })

    const signal = new AbortController().signal
    await expect(client.list(SYNTHETIC_SECRET, signal)).rejects.toMatchObject({
      name: 'AccountError',
      reason: 'unknown-structure'
    })
    expect(visitedCount).toBe(20)
  })

  it('exportCookie rejects non-numeric IDs with AccountError blocked without issuing network request', async () => {
    let requested = false
    const client = createAccountClient({
      request: async () => {
        requested = true
        return ''
      },
      scheduler: createDirectScheduler()
    })

    const signal = new AbortController().signal
    const invalidIds = ['abc', '0', '-1', '101/foo', '', '012', '12a3']

    for (const invalidId of invalidIds) {
      await expect(client.exportCookie(invalidId, SYNTHETIC_SECRET, signal)).rejects.toMatchObject({
        name: 'AccountError',
        reason: 'blocked'
      })
    }
    expect(requested).toBe(false)
  })

  it('exportCookie requests official export URL and returns parsed export payload', async () => {
    const expectedPayload = makeExportPayload('SyntheticExportUserhash999', 'TargetCookie')
    const requestedUrls: string[] = []
    const requestedSecrets: string[] = []

    const client = createAccountClient({
      request: async (url, secret) => {
        requestedUrls.push(url.href)
        requestedSecrets.push(secret)
        return makeExportHtml(expectedPayload)
      },
      scheduler: createDirectScheduler()
    })

    const signal = new AbortController().signal
    const payload = await client.exportCookie('101', SYNTHETIC_SECRET, signal)

    expect(payload).toBe(expectedPayload)
    expect(requestedUrls).toEqual([`${ACCOUNT_ORIGIN}/Member/User/Cookie/export/id/101.html`])
    expect(requestedSecrets).toEqual([SYNTHETIC_SECRET])
  })

  it('propagates upstream request rejections such as expired or cancelled', async () => {
    const expiredClient = createAccountClient({
      request: async () => {
        throw new AccountError('expired')
      },
      scheduler: createDirectScheduler()
    })

    const signal = new AbortController().signal
    await expect(expiredClient.list(SYNTHETIC_SECRET, signal)).rejects.toMatchObject({
      name: 'AccountError',
      reason: 'expired'
    })
    await expect(expiredClient.exportCookie('101', SYNTHETIC_SECRET, signal)).rejects.toMatchObject({
      name: 'AccountError',
      reason: 'expired'
    })
  })
})
