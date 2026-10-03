import { h } from 'koishi'

export type ImageMode = 'placeholder' | 'chatimage' | 'link'

function id(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return
  return String(value)
}

/** Filter only our own logged-in accounts, not every external bot. */
export function isBotMessage(session: any, bots: readonly any[] = []): boolean {
  const sender = id(session.userId) ?? id(session.event?.user?.id)
  if (!sender) return false
  if (sender === id(session.selfId) || sender === id(session.bot?.selfId)) return true
  const platform = session.platform ?? session.bot?.platform
  return !!platform && bots.some(bot => bot.platform === platform && id(bot.selfId) === sender)
}

function mediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return
  try {
    const url = new URL(value)
    if (!url.hostname || url.username || url.password) return
    // CICode uses commas and closing brackets as delimiters. Never allow an
    // image URL to inject another attribute/code, including literal newlines.
    return value.replace(/[\[\],\s]/g, char => encodeURIComponent(char))
  } catch {
    return
  }
}

/** Serialize elements independently; never reuse the first image/mention. */
export function formatMinecraftMessage(
  content: string,
  imageMode: ImageMode | undefined,
  translate: (key: string) => string,
): string {
  const placeholder = (kind: string) => translate(`minecraft-sync-msg.message.${kind}Placeholder`)
  const media = (attrs: Record<string, any>, kind: 'image' | 'emoji') => {
    const label = placeholder(kind)
    const url = mediaUrl(attrs.src ?? attrs.url)
    if (imageMode === 'chatimage' && url) return `[[CICode,url=${url}]]`
    if (imageMode === 'link' && url) return `${label} ${url}`
    if (kind === 'emoji') {
      // Platform names/IDs are labels, not downloadable image addresses.
      const name = String(attrs.name ?? attrs.id ?? '').replace(/[\r\n]/g, ' ').slice(0, 80)
      if (name && !/https?:\/\//i.test(name)) return `${label}(${name})`
    }
    return label
  }
  const render = (elements: h[]): string => elements.map(element => {
    const { type, attrs, children } = element
    switch (type) {
      case 'text': return attrs.content ?? ''
      case 'img':
      case 'image': return media(attrs, 'image')
      case 'face':
      case 'mface':
      case 'emoji':
      case 'sticker': return media(attrs, 'emoji')
      case 'quote': return ''
      case 'at': return `@[${attrs.name ?? attrs.id ?? attrs.type ?? ''}]`
      case 'video': return placeholder('video')
      case 'audio': return placeholder('audio')
      case 'json': return placeholder('json')
      case 'br': return '\n'
      default: return render(children)
    }
  }).join('')
  return render(h.parse(content))
}
