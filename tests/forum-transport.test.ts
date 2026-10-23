import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createForumTransport } from '../src/main/forum/transport'
import { ReadCancelledError } from '../src/main/forum/contract'

const servers: Server[] = []
const signal = new AbortController().signal

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve())
  await promise
  server.removeListener('error', reject)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
    return promise
  }))
})

describe('credential-free bounded forum transport', () => {
  it.each([
    ['gzip', gzipSync], ['x-gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]
  ] as const)('decodes actual %s response encoding', async (encoding, compress) => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'Application/JSON; charset="utf-8"', 'Content-Encoding': encoding })
      response.end(compress(Buffer.from('{"text":"中文"}')))
    })
    const transport = createForumTransport({ allowedOrigins: [origin] })
    expect(await transport.get(new URL('/read', origin), signal)).toEqual({
      mediaType: 'application/json', text: '{"text":"中文"}'
    })
  })

  it('rejects a decompression expansion above the decoded byte cap', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Encoding': 'gzip' })
      response.end(gzipSync(Buffer.from('x'.repeat(4096))))
    })
    const transport = createForumTransport({ allowedOrigins: [origin], maxDecodedBytes: 100 })
    await expect(transport.get(new URL(origin), signal)).rejects.toMatchObject({
      error: { kind: 'unknown-structure', detail: 'too-large' }
    })
  })

  it('rejects a response above the compressed byte cap', async () => {
    const origin = await serve((_request, response) => response.end('x'.repeat(101)))
    const transport = createForumTransport({ allowedOrigins: [origin], maxCompressedBytes: 100 })
    await expect(transport.get(new URL(origin), signal)).rejects.toMatchObject({
      error: { kind: 'unknown-structure', detail: 'too-large' }
    })
  })

  it('does not follow a 302 redirect, even to an otherwise allowed origin', async () => {
    let followed = false
    const origin = await serve((request, response) => {
      if (request.url === '/target') { followed = true; response.end('{}'); return }
      response.writeHead(302, { Location: '/target' })
      response.end('<html>redirect</html>')
    })
    await expect(createForumTransport({ allowedOrigins: [origin] }).get(new URL(origin), signal))
      .rejects.toMatchObject({ error: { kind: 'unknown-structure', detail: 'redirect', httpStatus: 302 } })
    expect(followed).toBe(false)
  })

  it.each([
    [429, 'rate-limited'], [401, 'permission'], [403, 'permission'], [404, 'not-found'], [500, 'network']
  ] as const)('classifies HTTP %s before trying to decode a body', async (status, kind) => {
    const origin = await serve((_request, response) => {
      response.writeHead(status, { 'Content-Encoding': 'unknown' })
      response.end('not JSON')
    })
    await expect(createForumTransport({ allowedOrigins: [origin] }).get(new URL(origin), signal))
      .rejects.toMatchObject({ error: { kind, detail: 'http-status', httpStatus: status } })
  })

  it('enforces a total timeout while waiting for response headers', async () => {
    const origin = await serve(() => {})
    await expect(createForumTransport({ allowedOrigins: [origin], timeoutMs: 30 }).get(new URL(origin), signal))
      .rejects.toMatchObject({ error: { kind: 'network', detail: 'timeout' } })
  })

  it('enforces the same total timeout after response headers arrive', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.flushHeaders()
      response.write('{')
    })
    await expect(createForumTransport({ allowedOrigins: [origin], timeoutMs: 30 }).get(new URL(origin), signal))
      .rejects.toMatchObject({ error: { kind: 'network', detail: 'timeout' } })
  })

  it('destroys an in-flight read when the caller aborts', async () => {
    const accepted = Promise.withResolvers<void>()
    const origin = await serve(() => accepted.resolve())
    const controller = new AbortController()
    const pending = createForumTransport({ allowedOrigins: [origin] }).get(new URL(origin), controller.signal)
    const rejection = expect(pending).rejects.toBeInstanceOf(ReadCancelledError)
    await accepted.promise
    controller.abort()
    await rejection
  })

  it('does not issue requests to disallowed origins', async () => {
    let received = false
    const origin = await serve((_request, response) => { received = true; response.end('{}') })
    await expect(createForumTransport({ allowedOrigins: ['https://api.nmb.best'] }).get(new URL(origin), signal))
      .rejects.toBeInstanceOf(Error)
    expect(received).toBe(false)
  })

  it('refuses URL credentials instead of sending authorization', async () => {
    let received = false
    const origin = await serve((_request, response) => { received = true; response.end('{}') })
    const url = new URL(origin)
    url.username = 'secret'
    url.password = 'secret'
    await expect(createForumTransport({ allowedOrigins: [origin] }).get(url, signal)).rejects.toBeInstanceOf(Error)
    expect(received).toBe(false)
  })

  it('never sends cookies or authorization headers', async () => {
    let headers: IncomingMessage['headers'] = {}
    const origin = await serve((request, response) => {
      headers = request.headers
      response.setHeader('Content-Type', 'application/json')
      response.end('{}')
    })
    await createForumTransport({ allowedOrigins: [origin] }).get(new URL(origin), signal)
    expect(headers.cookie).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
    expect(headers['proxy-authorization']).toBeUndefined()
  })

  it.each([
    ['unknown content encoding', { 'Content-Encoding': 'compress' }, Buffer.from('{}')],
    ['corrupt gzip', { 'Content-Encoding': 'gzip' }, Buffer.from('invalid gzip')],
    ['unsupported charset', { 'Content-Type': 'application/json; charset=not-a-charset' }, Buffer.from('{}')],
    ['invalid UTF-8', { 'Content-Type': 'application/json; charset=utf-8' }, Buffer.from([0xc3, 0x28])]
  ] as const)('classifies %s as a decode failure', async (_name, headers, body) => {
    const origin = await serve((_request, response) => { response.writeHead(200, headers); response.end(body) })
    await expect(createForumTransport({ allowedOrigins: [origin] }).get(new URL(origin), signal))
      .rejects.toMatchObject({ error: { kind: 'unknown-structure', detail: 'decode' } })
  })

  it('honors the declared charset instead of assuming UTF-8', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/json; charset=windows-1252' })
      response.end(Buffer.from([0x22, 0xe9, 0x22]))
    })
    expect(await createForumTransport({ allowedOrigins: [origin] }).get(new URL(origin), signal))
      .toEqual({ mediaType: 'text/json', text: '"é"' })
  })

  it('classifies a connection terminated before a complete body as a network failure', async () => {
    const origin = await serve((_request, response) => { response.destroy() })
    await expect(createForumTransport({ allowedOrigins: [origin] }).get(new URL(origin), signal))
      .rejects.toMatchObject({ error: { kind: 'network', detail: 'connection' } })
  })
})
