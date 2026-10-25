import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestAccountPage } from '../src/main/account/client'
import { ACCOUNT_ORIGIN } from '../src/main/account/protocol'
const network = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: network.request }))
beforeEach(() => network.request.mockReset())
const signal = () => new AbortController().signal

describe('account HTTPS request gate', () => {
  it.each([
    '/Member/User/Cookie/switchTo/id/101.html', '/Member/User/Cookie/delete/id/101.html',
    '/Member/User/Cookie/apply.html', '/Member/User/Index/logout.html', '/logout.html',
    '/Member/User/Cookie/index.html?s=%2FMember%2FUser%2FCookie%2Fapply',
    '/Member/User/Cookie/index.html?a=delete',
    '/Member/User/Cookie/index/apply.html',
    '/Member/User/Cookie/%61pply.html', '/Member/User/Cookie/export/id/101.html?next=apply',
    'http://publicapi.ovear.info/qrcode.php?text=synthetic',
    'https://other.invalid/Member/User/Cookie/index.html'
  ])('refuses forbidden target before calling HTTPS: %s', async (path) => {
    await expect(requestAccountPage(new URL(path, ACCOUNT_ORIGIN), 'synthetic-session', signal())).rejects.toMatchObject({ reason: 'blocked' })
    expect(network.request).not.toHaveBeenCalled()
  })
  it('sends only the account cookie and never follows an account-write redirect', async () => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() })
    const response = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: `${ACCOUNT_ORIGIN}/Member/User/Cookie/apply.html` }, destroy: vi.fn() })
    network.request.mockImplementation((_url, _options, receive) => {
      request.end.mockImplementation(() => queueMicrotask(() => receive(response)))
      return request
    })
    await expect(requestAccountPage(new URL('/Member/User/Cookie/index.html', ACCOUNT_ORIGIN), 'synthetic-session', signal())).rejects.toMatchObject({ reason: 'unknown-structure' })
    expect(network.request).toHaveBeenCalledTimes(1)
    expect(network.request.mock.calls[0]![1].headers).toMatchObject({ Cookie: 'memberUserspapapa=synthetic-session' })
    expect(JSON.stringify(network.request.mock.calls[0]![1].headers)).not.toMatch(/userhash|PHPSESSID/)
  })
  it('rejects a header-injecting secret without opening a request', async () => {
    await expect(requestAccountPage(new URL('/Member/User/Cookie/index.html', ACCOUNT_ORIGIN), 'bad\r\nCookie: userhash=synthetic', signal())).rejects.toMatchObject({ reason: 'blocked' })
    expect(network.request).not.toHaveBeenCalled()
  })
  it('decodes a gzipped member page sent regardless of Accept-Encoding', async () => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() })
    const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-encoding': 'gzip' } })
    network.request.mockImplementation((_url, _options, receive) => {
      request.end.mockImplementation(() => queueMicrotask(() => { receive(response); response.end(gzipSync('<title>饼干列表</title>')) }))
      return request
    })
    await expect(requestAccountPage(new URL('/Member/User/Cookie/index.html', ACCOUNT_ORIGIN), 'synthetic-session', signal())).resolves.toBe('<title>饼干列表</title>')
  })
})
