import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMinecraftMessage as format, isBotMessage } from '../src/message'

const labels = { image: '[图片]', emoji: '[表情]', video: '[视频]', audio: '[音频]', json: '[JSON]' }
const t = (key: string) => labels[key.split('.').pop()!.replace('Placeholder', '')]

test('self and same-platform bot IDs are ignored, human and cross-platform IDs are not', () => {
  const bots = [{ platform: 'qq', selfId: '200' }, { platform: 'discord', selfId: '300' }]
  const session = { platform: 'qq', selfId: '100' }
  assert.equal(isBotMessage({ ...session, userId: '100' }, bots), true)
  assert.equal(isBotMessage({ ...session, userId: 100 }, bots), true)
  assert.equal(isBotMessage({ ...session, event: { user: { id: '100' } } }, bots), true)
  assert.equal(isBotMessage({ platform: 'qq', userId: '100', bot: { selfId: '100' } }, bots), true)
  assert.equal(isBotMessage({ ...session, userId: '200' }, bots), true)
  assert.equal(isBotMessage({ ...session, userId: '300' }, bots), false)
  assert.equal(isBotMessage({ ...session, userId: '400', author: { isBot: true } }, bots), false)
  assert.equal(isBotMessage(session, bots), false)
  assert.equal(isBotMessage({}, [{}]), false)
})

test('default placeholders never expose image URLs', () => {
  assert.equal(format('前<img src="https://example.com/a.png"/>中<img src="https://example.com/b.gif"/>后', undefined, t), '前[图片]中[图片]后')
})

test('ChatImage preserves each image, intervening text, and decoded URL queries', () => {
  assert.equal(format('<img src="https://example.com/a.png?a=1&amp;b=2"/>中<img src="https://example.com/b.gif"/>', 'chatimage', t), '[[CICode,url=https://example.com/a.png?a=1&b=2]]中[[CICode,url=https://example.com/b.gif]]')
})

test('multiple mentions, nested text, quotes and entities render in order', () => {
  assert.equal(format('<template>A&amp;B<b>粗体</b><at id="1" name="甲"/><at id="2"/><quote id="q"><img src="https://example.com/quoted.png"/>引用</quote>正文</template>', undefined, t), 'A&B粗体@[甲]@[2]正文')
  assert.equal(format('literal &lt;img src=&quot;x&quot;/&gt;', undefined, t), 'literal <img src="x"/>')
})

test('face, sticker, image alias and unicode emoji', () => {
  assert.equal(format('😀<face id="14" name="微笑"/><emoji id="1"/><mface/><sticker src="https://example.com/s.gif"/><image url="https://example.com/a.png"/>', 'placeholder', t), '😀[表情](微笑)[表情](1)[表情][表情][图片]')
  assert.equal(format('<sticker src="https://example.com/s.gif"/>', 'chatimage', t), '[[CICode,url=https://example.com/s.gif]]')
})

test('link is opt-in; unsupported and missing URLs fall back without stale image state', () => {
  assert.equal(format('<img src="https://example.com/a.png"/>', 'link', t), '[图片] https://example.com/a.png')
  for (const src of ['', 'file:///C:/private.png', 'data:image/png;base64,secret', 'javascript:alert(1)', 'https://', 'https://user:password@example.com/a']) {
    assert.equal(format(`<img src="${src}"/>`, 'chatimage', t), '[图片]')
  }
  assert.equal(format('<img/>', 'chatimage', t), '[图片]')
})

test('CICode delimiters and whitespace in media URLs are encoded', () => {
  assert.equal(format('<img src="https://example.com/a,b[x].png"/>', 'chatimage', t), '[[CICode,url=https://example.com/a%2Cb%5Bx%5D.png]]')
})

test('other media placeholders do not swallow surrounding text or expose attributes', () => {
  assert.equal(format('A<video src="secret"/>B<audio src="secret"/>C<json data="secret"/>D<unknown src="secret">text</unknown>', undefined, t), 'A[视频]B[音频]C[JSON]Dtext')
  assert.equal(format('', undefined, t), '')
})
