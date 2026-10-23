import { describe, expect, it } from 'vitest'
import { parseContent } from '../src/main/forum/content'

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
    expect(parseContent('<unknown><div>a<span>b<p>c</p></span></div></unknown><b></b><font color="red">d</font>'))
      .toEqual({ nodes: [{ type: 'text', text: 'abcd' }], plainText: 'abcd' })
  })

  it('preserves semantic emphasis and derives plain text recursively', () => {
    expect(parseContent('<strong>A<em>B</em></strong><br><u>C</u><del>D</del>' +
      '<small>E</small><sup>F</sup><sub>G</sub><br>').plainText).toBe('AB\nCDEFG')
    expect(parseContent('<a href="https://example.com">outer<a href="http://example.org">inner</a></a>').plainText)
      .toBe('outerinner')
  })
})
