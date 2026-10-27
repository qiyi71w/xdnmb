import { describe, expect, it } from 'vitest'
import { parseContent, submittedText } from '../src/main/forum/content'

describe('safe forum content', () => {
  it('uses br elements, not source line terminators, for visible breaks', () => {
    expect(parseContent('a<br />\r\nb')).toEqual({
      nodes: [{ type: 'text', text: 'a' }, { type: 'lineBreak' }, { type: 'text', text: 'b' }],
      plainText: 'a\nb'
    })
    expect(parseContent('<br><br><br>\r\n\r\n')).toEqual({
      nodes: [{ type: 'lineBreak' }, { type: 'lineBreak' }, { type: 'lineBreak' }],
      plainText: ''
    })
    expect(parseContent('a\r\nb\nc\rd　 e').plainText).toBe('abcd　 e')
  })

  it('recognizes decoded references within greentext and preserves their original spelling', () => {
    expect(parseContent('<font color="#789922">&gt;&gt;No.50000001</font>')).toEqual({
      nodes: [{ type: 'greentext', children: [
        { type: 'quoteRef', postId: '50000001', raw: '>>No.50000001' }
      ] }],
      plainText: '>>No.50000001'
    })
    expect(parseContent('x >>123 >No.45 ＞＞No.67 ＞No.89 >123').nodes).toEqual([
      { type: 'text', text: 'x ' },
      { type: 'quoteRef', postId: '123', raw: '>>123' },
      { type: 'text', text: ' ' },
      { type: 'quoteRef', postId: '45', raw: '>No.45' },
      { type: 'text', text: ' ' },
      { type: 'quoteRef', postId: '67', raw: '＞＞No.67' },
      { type: 'text', text: ' ' },
      { type: 'quoteRef', postId: '89', raw: '＞No.89' },
      { type: 'text', text: ' >123' }
    ])
    expect(parseContent('>>123456789012345678901').nodes).toEqual([
      { type: 'text', text: '>>123456789012345678901' }
    ])
  })

  it.each(['www.nmbxd.com', 'www.nmbxd1.com', 'nmbxd.com', 'nmbxd1.com'])(
    'recognizes thread links on %s in bare text and anchors without rewriting their visible text',
    (host) => {
      for (const protocol of ['http', 'https']) {
        for (const suffix of ['', '?page=2', '?r=68810622', '?r=0.584561', '?page=2&r=68810622', '?r=68810622&page=2']) {
          const url = `${protocol}://${host}/t/68810621${suffix}`
          const expected = { type: 'quoteRef', postId: '68810621', raw: url }
          expect(parseContent(url)).toEqual({ nodes: [expected], plainText: url })
          expect(parseContent(`<a href="${url.replaceAll('&', '&amp;')}">${url.replaceAll('&', '&amp;')}</a>`))
            .toEqual({ nodes: [expected], plainText: url })
        }
      }
    }
  )

  it('keeps anchor labels and counts each thread link as one reference even with styled quote text', () => {
    expect(parseContent('>>No.1 <a href="https://www.nmbxd.com/t/68810621"><b>&gt;&gt;No.68810621</b></a> >>No.2').nodes)
      .toEqual([
        { type: 'quoteRef', postId: '1', raw: '>>No.1' },
        { type: 'text', text: ' ' },
        { type: 'quoteRef', postId: '68810621', raw: '>>No.68810621' },
        { type: 'text', text: ' ' },
        { type: 'quoteRef', postId: '2', raw: '>>No.2' }
      ])
    expect(parseContent('<a href="https://nmbxd.com/t/68810621">点这里</a>').nodes)
      .toEqual([{ type: 'quoteRef', postId: '68810621', raw: '点这里' }])
  })

  it('preserves prose punctuation around bare thread URLs', () => {
    const url = 'https://www.nmbxd.com/t/68810621?page=2'
    expect(parseContent(`串号（${url}），和 (${url}).`).nodes).toEqual([
      { type: 'text', text: '串号（' },
      { type: 'quoteRef', postId: '68810621', raw: url },
      { type: 'text', text: '），和 (' },
      { type: 'quoteRef', postId: '68810621', raw: url },
      { type: 'text', text: ').' }
    ])
  })

  it.each([
    'https://www.nmbxd.com/f/4', 'https://www.nmbxd.com/t/68810621/extra',
    'https://www.nmbxd.com/t/68810621/', 'https://www.nmbxd.com/t/not-a-number',
    'https://www.nmbxd.com/t/123456789012345678901',
    'https://www.nmbxd.com/t/68810621?foo=2', 'https://www.nmbxd.com/t/68810621#other',
    'https://www.nmbxd.com.evil.example/t/68810621', 'https://example.com/t/68810621',
    'https://user@www.nmbxd.com/t/68810621', 'https://www.nmbxd.com:8080/t/68810621'
  ])('leaves non-thread URL %s as an external link', (url) => {
    expect(parseContent(`<a href="${url}">链接</a>`).nodes).toEqual([
      { type: 'link', href: url, children: [{ type: 'text', text: '链接' }] }
    ])
    expect(parseContent(url).nodes).toEqual([{ type: 'text', text: url }])
  })

  it('drops executable and embedded content, including its text', () => {
    const html = 'before<script>alert(1)</script><style>secret</style>' +
      '<iframe>hidden</iframe><svg><text>hidden</text></svg><template>hidden</template>' +
      '<textarea>hidden</textarea><select><option>hidden</option></select>' +
      '<button>hidden</button><img src="https://example.com/pixel" onerror="bad()">after'
    expect(parseContent(html)).toEqual({
      nodes: [{ type: 'text', text: 'beforeafter' }], plainText: 'beforeafter'
    })
  })

  it('keeps only safe structure, never event handlers, styles or arbitrary attributes', () => {
    expect(parseContent('<b onclick="bad()" style="color:red" class="x">bold</b>' +
      '<font color="#789922" onmouseover="bad()">green</font>')).toEqual({
      nodes: [
        { type: 'emphasis', style: 'bold', children: [{ type: 'text', text: 'bold' }] },
        { type: 'greentext', children: [{ type: 'text', text: 'green' }] }
      ],
      plainText: 'boldgreen'
    })
  })

  it('reduces dangerous and relative links to text, preserving absolute HTTP links', () => {
    expect(parseContent('<a href="javascript:bad()">one</a><a href="/t/123">two</a>' +
      '<a href="data:text/html,evil">three</a><a href=" https://example.com/x " style="x">four</a>')).toEqual({
      nodes: [
        { type: 'text', text: 'onetwothree' },
        { type: 'link', href: 'https://example.com/x', children: [{ type: 'text', text: 'four' }] }
      ],
      plainText: 'onetwothreefour'
    })
  })

  it('makes unknown elements transparent, merges adjacent text and drops empty containers', () => {
    expect(parseContent('<unknown><div>a<span>b<p>c</p></span></div></unknown><b></b><font color="blue">d</font>' +
      '<span style="color:red"></span><span style="font-weight:bold"><span style="color:red"></span></span>'))
      .toEqual({ nodes: [{ type: 'text', text: 'abcd' }], plainText: 'abcd' })
  })

  it('shows official red, green and bold inline styles as closed nodes (No.52752005 head)', () => {
    const html = '<span style=" color: red "><span style=" font-weight: bold ">新</span></span>官方<br />' +
      '<span style=" color: green ">=== 注册已开启 ===</span>'
    expect(parseContent(html)).toEqual({
      nodes: [
        { type: 'redtext', children: [{ type: 'emphasis', style: 'bold', children: [{ type: 'text', text: '新' }] }] },
        { type: 'text', text: '官方' },
        { type: 'lineBreak' },
        { type: 'greentext', children: [{ type: 'text', text: '=== 注册已开启 ===' }] }
      ],
      plainText: '新官方\n=== 注册已开启 ==='
    })
  })

  it('recognizes the red spellings on span and font, case- and whitespace-insensitively', () => {
    const red = (text: string) => ({ type: 'redtext', children: [{ type: 'text', text }] })
    expect(parseContent('<font color=red>a</font><font COLOR=" #FF0000 ">b</font>' +
      '<span style="color:#f00;">c</span><font style="COLOR : Red">d</font>').nodes)
      .toEqual([red('a'), red('b'), red('c'), red('d')])
    expect(parseContent('<span style="font-weight: 700; color: RED">e</span>').nodes).toEqual([
      { type: 'redtext', children: [{ type: 'emphasis', style: 'bold', children: [{ type: 'text', text: 'e' }] }] }
    ])
  })

  it('drops every other declaration and attribute, keeping the text', () => {
    expect(parseContent('<span style="color: blue">a</span><span style="font-size: 30px; background: red">b</span>' +
      '<span style="font-weight: 500">c</span><span style="font-weight: normal">d</span>' +
      '<span color="red">e</span><b style="color:red">f</b><span style="background-color: red">g</span>' +
      '<span style="color: rgb(255, 0, 0)">h</span>')).toEqual({
      nodes: [{ type: 'text', text: 'abcde' }, { type: 'emphasis', style: 'bold', children: [{ type: 'text', text: 'f' }] }, { type: 'text', text: 'gh' }],
      plainText: 'abcdefgh'
    })
  })

  it('preserves semantic emphasis and derives plain text recursively', () => {
    expect(parseContent('<strong>A<em>B</em></strong><br><u>C</u><del>D</del>' +
      '<small>E</small><sup>F</sup><sub>G</sub><br>').plainText).toBe('AB\nCDEFG')
    expect(parseContent('<a href="https://example.com">outer<a href="http://example.org">inner</a></a>').plainText)
      .toBe('outerinner')
  })

  it('reads a dice result back as its expression even inside official colour formatting', () => {
    const plain = parseContent('<b>2</b><small>[1,5]</small>后').nodes
    for (const html of ['<span style="color:red"><b>2</b></span><small>[1,5]</small>后', '<font color="#789922"><b>2</b><small>[1,5]</small></font>后',
      '<span style="color:red"><b>2</b><small>[1,5]</small></span>后', '<span style="font-weight:bold"><b>2</b></span><small>[1,5]</small>后']) {
      expect(submittedText(parseContent(html).nodes)).toBe(submittedText(plain))
    }
    expect(submittedText(plain)).toBe('[1,5]后')
    expect(submittedText(parseContent('<span style="color:red"><b>2</b></span>后').nodes)).toBe('2后')
  })
})
