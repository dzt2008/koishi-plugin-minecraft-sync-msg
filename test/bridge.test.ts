import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { Context } from 'koishi'
import { WebSocket, WebSocketServer } from 'ws'

// Test the published, bundled entry, not a separately imported copy of src/.
const require = createRequire(import.meta.url)
const MinecraftSyncMsg = require('../lib/index.js').default

type Mode = '客户端' | '服务端'
type Hook = (...args: any[]) => unknown
interface Packet {
  api: string
  data: { message: Array<{ text: string; color?: string }> }
}

const selfBot = { platform: 'onebot', selfId: '10001' }
const otherBot = { platform: 'onebot', selfId: '10002' }
const otherPlatformBot = { platform: 'discord', selfId: '10003' }
const receivePrefix = '[onebot](20001)Alice: '
const joinMessage = 'bridge test connection ready'
const imageOne = 'https://example.invalid/one.png'
const imageTwo = 'https://example.invalid/two.png'
const mixedImages = `before<img src="${imageOne}"/>between<img src="${imageTwo}"/>after`

/** Only lifecycle/message dispatch is faked; i18n and both ends of WS are real. */
class TestContextBridge {
  private realContext = new Context()
  readonly i18n = this.realContext.i18n
  readonly bots = [selfBot, otherBot, otherPlatformBot]
  readonly children: any[] = []
  readonly hooks = new Map<string, Hook[]>()
  readonly logger = { info() {}, success() {}, error() {} }

  on(event: string, hook: Hook) {
    const hooks = this.hooks.get(event) || []
    hooks.push(hook)
    this.hooks.set(event, hooks)
    return () => {
      const index = hooks.indexOf(hook)
      if (index >= 0) hooks.splice(index, 1)
    }
  }

  plugin(Plugin: new (ctx: any, config: any) => any, config: any) {
    // The main class delegates server mode to mcWss. Register its actual hooks.
    const instance = new Plugin(this, config)
    this.children.push(instance)
    return instance
  }

  async emit(event: string, ...args: any[]) {
    for (const hook of this.hooks.get(event) || []) await hook(...args)
  }

  async dispose() {
    await this.emit('dispose')
    await this.realContext.stop()
  }
}

function event(emitter: any, name: string): Promise<any[]> {
  return once(emitter, name, { signal: AbortSignal.timeout(5000) })
}

async function listening(server: WebSocketServer) {
  if (!server.address()) await event(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

function session(content: string, overrides: Record<string, unknown> = {}) {
  return {
    platform: 'onebot',
    selfId: selfBot.selfId,
    bot: selfBot,
    userId: '20001',
    username: 'Alice',
    channelId: 'target',
    guildId: 'target',
    content,
    author: { id: '20001', name: 'Alice' },
    event: { user: { id: '20001', name: 'Alice' } },
    async send(_message: string) {},
    ...overrides,
  }
}

async function bridge(t: TestContext, mode: Mode, overrides: Record<string, unknown> = {}) {
  const ctx = new TestContextBridge()
  const packets: Packet[] = []
  const sockets = new Set<WebSocket>()
  let server: WebSocketServer | undefined
  let transport: WebSocket | undefined

  // Registered before initialization so failed assertions/handshakes also clean up.
  t.after(async () => {
    const closed = server ? event(server, 'close') : undefined
    try {
      await ctx.dispose()
    } finally {
      for (const socket of sockets) socket.terminate()
      if (mode === '客户端') server?.close()
      await closed
    }
  })

  const config = {
    wsServer: mode,
    wsHost: '127.0.0.1',
    wsPort: 0,
    // Fixture credentials apply only to this ephemeral loopback server.
    Token: 'loopback-test-only',
    serverName: 'bridge-test',
    joinMsg: joinMessage,
    event: 1,
    maxReconnectCount: 0,
    maxReconnectInterval: 60_000,
    sendToChannel: ['onebot:target'],
    sendprefix: '.#',
    cmdprefix: './',
    hideConnect: true,
    locale: 'zh-CN',
    rconEnable: false,
    rconServerHost: '127.0.0.1',
    rconServerPort: 0,
    rconPassword: '',
    alluser: true,
    superuser: [],
    commonCmd: [],
    cannotCmd: [],
    ...overrides,
  }

  function collect(socket: WebSocket) {
    sockets.add(socket)
    socket.on('message', raw => packets.push(JSON.parse(raw.toString())))
  }

  let instance: any
  if (mode === '客户端') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    config.wsPort = await listening(server)
    server.on('connection', collect)
    const connected = event(server, 'connection')
    instance = new MinecraftSyncMsg(ctx, config)
    transport = instance.ws
    assert.ok(transport)
    sockets.add(transport)
    await connected
    if (transport.readyState !== WebSocket.OPEN) await event(transport, 'open')
    assert.equal(ctx.children.length, 0)
    assert.equal(ctx.hooks.get('message')?.length, 1)
  } else {
    instance = new MinecraftSyncMsg(ctx, config)
    assert.equal(ctx.children.length, 1, 'server child plugin must actually be registered')
    assert.equal(ctx.hooks.get('message')?.length, 2, 'dispatch parent and child message hooks')
    await ctx.emit('ready')
    server = ctx.children[0].wss
    const port = await listening(server!)
    const connected = event(server, 'connection')
    const peer = new WebSocket(`ws://127.0.0.1:${port}/minecraft/ws`, {
      headers: {
        Authorization: `Bearer ${config.Token}`,
        'x-self-name': config.serverName,
        'x-client-origin': 'bridge-test',
      },
    })
    collect(peer)
    const opened = event(peer, 'open')
    ;[transport] = await connected
    sockets.add(transport!)
    await opened
  }

  /**
   * Ping travels on the same ordered stream as broadcasts. Its pong proves the
   * remote peer has processed every earlier message, including duplicate sends.
   * This also makes zero-message assertions deterministic without a sleep.
   */
  async function flush() {
    assert.equal(transport?.readyState, WebSocket.OPEN)
    const pong = event(transport, 'pong')
    transport!.ping()
    await pong
  }

  await flush()
  assert.deepEqual(packets, [{ api: 'broadcast', data: { message: [{ text: joinMessage, color: 'gold' }] } }])
  packets.length = 0

  return {
    ctx,
    instance,
    async dispatch(message: ReturnType<typeof session>) {
      packets.length = 0
      await ctx.emit('message', message)
      await flush()
      return [...packets]
    },
  }
}

function assertBroadcast(packets: Packet[], text: string) {
  assert.deepEqual(packets, [{
    api: 'broadcast',
    data: { message: [{ text: receivePrefix + text, color: 'white' }] },
  }], 'one user message must produce exactly one correctly formatted broadcast')
}

for (const mode of ['客户端', '服务端'] as const) {
  test(`${mode}: suppress self and other same-platform bots, but forward a normal group user once`, async t => {
    const fixture = await bridge(t, mode)
    for (const userId of [selfBot.selfId, otherBot.selfId]) {
      assert.deepEqual(await fixture.dispatch(session('.#bot echo', { userId })), [], `must suppress bot ${userId}`)
    }
    assertBroadcast(await fixture.dispatch(session('.#hello')), 'hello')
    assert.deepEqual(await fixture.dispatch(session('.#wrong channel', { channelId: 'unrelated' })), [])
    assert.deepEqual(await fixture.dispatch(session('missing prefix')), [])
    assert.deepEqual(await fixture.dispatch(session('.#')), [])
  })

  test(`${mode}: repeated identical user messages are each forwarded exactly once`, async t => {
    const fixture = await bridge(t, mode)
    assertBroadcast(await fixture.dispatch(session('.#same message')), 'same message')
    assertBroadcast(await fixture.dispatch(session('.#same message')), 'same message')
  })

  test(`${mode}: missing userId falls back to event.user.id for self-message filtering`, async t => {
    const fixture = await bridge(t, mode)
    assert.deepEqual(await fixture.dispatch(session('.#self echo', {
      userId: undefined,
      event: { user: { id: selfBot.selfId } },
    })), [])
    assertBroadcast(await fixture.dispatch(session('.#human positive control')), 'human positive control')
  })

  test(`${mode}: missing content and quote-only messages produce no broadcast`, async t => {
    const fixture = await bridge(t, mode, { sendprefix: '' })
    const withoutContent = session('discarded')
    Reflect.deleteProperty(withoutContent, 'content')
    assert.deepEqual(await fixture.dispatch(withoutContent), [])
    assert.deepEqual(await fixture.dispatch(session('', { content: undefined })), [])
    assert.deepEqual(await fixture.dispatch(session('<quote id="quoted-message"/>')), [])
    assertBroadcast(await fixture.dispatch(session('human positive control')), 'human positive control')
  })

  test(`${mode}: bot ID comparisons are scoped to the message platform`, async t => {
    const fixture = await bridge(t, mode)
    const packets = await fixture.dispatch(session('.#human on onebot', { userId: otherPlatformBot.selfId }))
    assert.deepEqual(packets, [{
      api: 'broadcast',
      data: { message: [{ text: `[onebot](${otherPlatformBot.selfId})Alice: human on onebot`, color: 'white' }] },
    }])
  })

  test(`${mode}: empty prefix forwards users once but never bot echoes or empty content`, async t => {
    const fixture = await bridge(t, mode, { sendprefix: '' })
    assertBroadcast(await fixture.dispatch(session('no prefix required')), 'no prefix required')
    for (const userId of [selfBot.selfId, otherBot.selfId]) {
      assert.deepEqual(await fixture.dispatch(session('bot echo without prefix', { userId })), [])
    }
    assert.deepEqual(await fixture.dispatch(session('')), [])
    assert.deepEqual(await fixture.dispatch(session('   ')), [])
    assert.deepEqual(await fixture.dispatch(session('wrong channel', { channelId: 'unrelated' })), [])
  })

  for (const imageMode of [undefined, 'placeholder', 'chatimage', 'link'] as const) {
    test(`${mode}: ${imageMode ?? 'default'} preserves both images and surrounding text order`, async t => {
      // Omit the option entirely for the default case: no schema normalization in this fixture.
      const fixture = await bridge(t, mode, imageMode ? { imageMode } : {})
      const packets = await fixture.dispatch(session(`.#${mixedImages}`))
      if (!imageMode || imageMode === 'placeholder') {
        assertBroadcast(packets, 'before[图片]between[图片]after')
        assert.ok(!JSON.stringify(packets).includes('example.invalid'), 'default must not leak image URLs')
      } else if (imageMode === 'link') {
        assertBroadcast(packets, `before[图片] ${imageOne}between[图片] ${imageTwo}after`)
      } else {
        assertBroadcast(packets, `before[[CICode,url=${imageOne}]]between[[CICode,url=${imageTwo}]]after`)
      }
    })
  }

  test(`${mode}: RCON rejects bot commands before execution and accepts an ordinary user's command`, async t => {
    const commands: string[] = []
    // Stub before construction: no RCON TCP connection or credentials are used.
    t.mock.method(MinecraftSyncMsg.prototype, 'connectToRcon', async () => {})
    t.mock.method(MinecraftSyncMsg.prototype, 'sendRconCommand', async (command: string) => {
      commands.push(command)
      return 'test command response'
    })
    const fixture = await bridge(t, mode, { rconEnable: true })
    const replies: string[] = []
    const send = async (message: string) => { replies.push(message) }
    for (const userId of [selfBot.selfId, otherBot.selfId]) {
      assert.deepEqual(await fixture.dispatch(session('./list', { userId, send })), [])
    }
    assert.deepEqual(commands, [], 'bot commands must never reach RCON')
    assert.deepEqual(replies, [], 'bot commands must not generate reply loops')
    assert.deepEqual(await fixture.dispatch(session('./list', { channelId: 'unrelated', send })), [])
    assert.deepEqual(commands, [], 'non-target channel commands must never reach RCON')
    assert.deepEqual(await fixture.dispatch(session('./list', { send })), [])
    assert.deepEqual(commands, ['list'], 'positive control: the RCON mock must be reachable for human commands')
    assert.deepEqual(replies, ['test command response'])
  })
}
