/**
 * dsh-pet-bridge —— DSH ↔「本鱼陪伴」（桌宠）的桥。
 *
 * 三条链路：
 *  1. 桌宠 → DSH：桌宠的语音转写/文字 POST 本插件 /api/pet-bridge/say，
 *     插件用 agent.followup() 投进**选定的会话**（不选则用最近活跃的那个）。
 *  2. DSH → 桌宠：会话回合结束时，取最终回复的纯文本，POST 桌宠 /broadcast
 *     写进气泡；0.3.9 起还会 POST /say-loud 让它读出来。
 *  3. 图片 → 桌宠识图：会话收到带 attachmentId 的图片消息时，把附件文件
 *     POST 给桌宠 /look，桌宠识图后把描述文本 followup 回同一会话。
 *
 * 会话可选（哥哥 11-01 定）：配置里的 sessionId 为空 = 自动挑最近活跃会话；
 * 设置页 /api/pet-bridge/page 里能挑。
 */
import fs from 'node:fs'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const name = 'pet-bridge'
export const inject = ['agents', 'sessions', 'webServer']

const API_PREFIX = '/api/pet-bridge'
const SOURCE_KIND = 'plugin:dsh-pet-bridge'
const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'pet-bridge.json')

/**
 * 【本鱼 · 11-03】「刷新插件」会把模块重新求值一遍，但**旧实例注册的 bus 钩子还挂在总线上**，
 * 结果同一轮回复被投递两次（哥哥看到气泡一下快一下慢、语音互相打断）。
 * 用 globalThis 上的单例标记：最后一次求值的实例才算数，旧实例的钩子一进来就自己退场。
 */
const INSTANCE = Symbol('body-of-fish-bridge.instance')
const ACTIVE_INSTANCE = Symbol.for('body-of-fish-bridge.active-instance')
globalThis[ACTIVE_INSTANCE] = INSTANCE
const isActiveInstance = () => globalThis[ACTIVE_INSTANCE] === INSTANCE

/** 桌宠运行时文件：优先新数据目录，其次 0.3.x 的老目录（升级用户还没迁移时也能连上） */
function resolvePetRuntime() {
  const home = os.homedir()
  const next = path.join(home, '.dsh', 'body-of-fish', 'standalone-runtime.json')
  const legacy = path.join(home, '.dsh', 'dsh-pet', 'standalone-runtime.json')
  try { if (fs.existsSync(next)) return next } catch { /* 读不到就落到老路径 */ }
  try { if (fs.existsSync(legacy)) return legacy } catch { /* 两边都没有：给新路径，等桌宠起来写 */ }
  return next
}
const DEFAULT_PET_RUNTIME = resolvePetRuntime()
const ATTACHMENTS_ROOT = path.join(os.homedir(), '.dsh', 'attachments', 'v1', 'objects')

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function defaults() {
  return {
    enabled: true,
    /** 空串 = 自动（最近活跃会话） */
    sessionId: '',
    petRuntimeFile: DEFAULT_PET_RUNTIME,
    /** 回合结束把回复写进桌宠气泡 */
    bubbleReply: true,
    /** 回合结束让桌宠读出来（要 0.3.9 的 /say-loud） */
    speakReply: false,
    /** 会话收到图片 → 桌宠识图（要 0.3.9 的 /look） */
    lookImages: true,
    /** 送进气泡/朗读的文本上限 */
    maxText: 60,
  }
}

function loadConfig() {
  const raw = readJson(CONFIG_PATH, {})
  return { ...defaults(), ...(raw && typeof raw === 'object' ? raw : {}) }
}

function normalizeConfig(patch) {
  const cfg = loadConfig()
  if (!patch || typeof patch !== 'object') return cfg
  const bools = ['enabled', 'bubbleReply', 'speakReply', 'lookImages']
  for (const key of bools) {
    if (typeof patch[key] === 'boolean') cfg[key] = patch[key]
  }
  if (typeof patch.sessionId === 'string') cfg.sessionId = patch.sessionId.trim().slice(0, 200)
  if (typeof patch.petRuntimeFile === 'string' && patch.petRuntimeFile.trim() !== '') {
    cfg.petRuntimeFile = patch.petRuntimeFile.trim().slice(0, 500)
  }
  const maxText = Number(patch.maxText)
  if (Number.isFinite(maxText)) cfg.maxText = Math.min(2000, Math.max(20, Math.trunc(maxText)))
  return cfg
}

/** 文本块 → 纯文本。 */
function messageText(message) {
  const content = message !== null && typeof message === 'object' ? message.content : message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 消息里的图片附件。 */
function imageAttachments(message) {
  const content = message !== null && typeof message === 'object' ? message.content : null
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object' || block.type !== 'image') continue
    const attachment = block.attachment
    if (attachment !== null && typeof attachment === 'object' && typeof attachment.attachmentId === 'string') {
      out.push({ attachmentId: attachment.attachmentId, name: String(attachment.name ?? '') })
    }
  }
  return out
}

/** sha256:<hex> → 附件仓库里的真实文件路径。 */
function attachmentPath(attachmentId) {
  const hex = attachmentId.startsWith('sha256:') ? attachmentId.slice(7) : attachmentId
  if (!/^[0-9a-f]{64}$/i.test(hex)) return ''
  return path.join(ATTACHMENTS_ROOT, hex.slice(0, 2), hex)
}

function postJson(port, route, payload, token, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
          ...(token ? { 'x-dsh-pet-token': token } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: res.statusCode ?? 0, json, text })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('桌宠没响应（超时）')))
    req.on('error', reject)
    req.end(body)
  })
}

/** 把回复文本收拾成适合朗读/气泡的样子。 */
function plainText(text, maxText) {
  let out = String(text ?? '')
  out = out.replace(/```[\s\S]*?```/g, ' ')
  out = out.replace(/`([^`]+)`/g, '$1')
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/^\s*[-*+]\s+/gm, '')
  out = out.replace(/^\s*#{1,6}\s*/gm, '')
  out = out.replace(/[*_>{}=~|]+/g, ' ')
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/\n{2,}/g, '\n')
  out = out.trim()
  if (maxText > 0 && out.length > maxText) {
    let cut = out.slice(0, maxText)
    // 尽量断在整句上，别把一句话劈成两半
    const stop = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('！'),
      cut.lastIndexOf('？'),
      cut.lastIndexOf('；'),
      cut.lastIndexOf('\n'),
    )
    if (stop >= Math.floor(maxText * 0.5)) cut = cut.slice(0, stop + 1)
    out = `${cut.replace(/[，、,；;：:\s]+$/u, '')}…`
  }
  return out
}

/** 给会话起个能认出来的短名字：标题 > 工作目录名 > id，尾号防撞。 */
function sessionLabel(s) {
  const base = String(s?.title || (s?.cwd ? path.basename(s.cwd) : '') || s?.id || '')
  const tail = String(s?.id ?? '').replace(/^session-/, '').slice(0, 6)
  return `${base.slice(0, 10)}·${tail}`
}

export function apply(ctx) {
  let config = loadConfig()
  const mounted = new Set()
  const looked = new Set()
  /** 最近一次注入/识图的结果，给 /state 和设置页看 */
  const last = { inject: null, bubble: null, look: null, error: null }

  const agentsService = () => (typeof ctx.get === 'function' ? (ctx.get('agents') ?? ctx.agents) : ctx.agents)

  const agentOf = (handle) => (handle && handle.agent ? handle.agent : handle)
  const sessionOf = (handle) => {
    const agent = agentOf(handle)
    return (agent && agent.session) || (handle && handle.session) || null
  }

  /** 所有活着的会话（给设置页挑、给自动模式挑）。 */
  function listSessions() {
    const agents = agentsService()
    const list = typeof agents?.list === 'function' ? agents.list() : []
    const out = []
    for (const handle of Array.isArray(list) ? list : []) {
      const agent = agentOf(handle)
      const session = sessionOf(handle)
      if (!session) continue
      const header = session.header ?? {}
      const id = String(session.id ?? header.id ?? '')
      if (id === '') continue
      out.push({
        id,
        cwd: String(header.cwd ?? ''),
        title: String(header.title ?? ''),
        status: String(agent?.status ?? ''),
        createdAt: String(header.createdAt ?? ''),
        updatedAt: String(header.updatedAt ?? ''),
      })
    }
    return out
  }

  /** 选会话：配置里写死的优先，否则挑最近活跃的。 */
  function pickAgent() {
    const agents = agentsService()
    const list = typeof agents?.list === 'function' ? agents.list() : []
    const handles = (Array.isArray(list) ? list : []).filter((h) => sessionOf(h))
    if (handles.length === 0) return null
    if (config.sessionId !== '') {
      const hit = handles.find((h) => String(sessionOf(h)?.id ?? '') === config.sessionId)
      if (hit) return hit
    }
    // 优先挑正在跑的那个会话（用户此刻正在对话的），其次按时间最晚。
    const stamp = (h) => {
      const header = sessionOf(h)?.header ?? {}
      const n = Number(header.updatedAt || header.createdAt || 0)
      return Number.isFinite(n) ? n : 0
    }
    const running = handles.filter((h) => String(agentOf(h)?.status ?? '') === 'running')
    const pool = running.length > 0 ? running : handles
    let best = pool[0]
    for (const handle of pool) if (stamp(handle) > stamp(best)) best = handle
    return best
  }

  /**
   * 把「桥在哪、接的是哪个会话」写到桌宠数据目录（和 standalone-runtime.json 同目录），
   * 桌宠那边读 body-of-fish-bridge.json 反过来连我们。没有浏览器请求时用兜底端口。
   */
  let baseUrlCache = ''
  function publishDiscovery(baseUrl) {
    if (baseUrl !== '') baseUrlCache = baseUrl
    if (baseUrlCache === '') return
    try {
      const file = path.join(path.dirname(config.petRuntimeFile), 'body-of-fish-bridge.json')
      const sessions = listSessions().map((s) => ({ id: s.id, title: s.title, cwd: s.cwd, status: s.status }))
      const hit = pickAgent()
      const selected = hit ? String(sessionOf(hit)?.id ?? '') : ''
      const selectedTitle = sessionLabel(sessions.find((s) => s.id === selected))
      writeJsonAtomic(file, {
        url: baseUrlCache,
        enabled: config.enabled,
        sessionId: config.sessionId,
        selected,
        selectedTitle,
        sessions,
        updatedAt: new Date().toISOString(),
      })
    } catch {
      // 写不进去不影响主链
    }
  }

  /** 兜底：从 ctx.webServer 摸端口（摸不到就等 requests 的 Host 头）。 */
  function guessBaseUrl() {
    const port = ctx.webServer?.port ?? ctx.webServer?.server?.address?.()?.port
    if (Number.isFinite(port) && port > 0) return `http://127.0.0.1:${port}${API_PREFIX}`
    const envPort = Number(process.env.DSH_PORT ?? process.env.DSH_WEB_PORT ?? process.env.PORT ?? 0)
    if (Number.isFinite(envPort) && envPort > 0) return `http://127.0.0.1:${envPort}${API_PREFIX}`
    return ''
  }

  /**
   * 补齐 DSH 会话日志要求的 `role` / `id`。
   *
   * 日志里的 `user/message` 少了这两个字段，DSH 打开会话时会整份拒开，
   * 报 `session event at seq N lacks an identified message` —— 一条坏记录
   * 就能让整段会话打不开，所以手写形状时必须补齐。
   */
  function withIdentity(message) {
    const out = { ...message }
    if (typeof out.role !== 'string' || out.role === '') out.role = 'user'
    if (typeof out.id !== 'string' || out.id === '') out.id = randomUUID()
    if (out.type === 'user') delete out.type
    return out
  }

  /** 造一条用户消息：优先用 DSH 自己的工厂，拿不到就按形状手写。 */
  let createUserMessage = null
  async function makeUserMessage(text) {
    if (createUserMessage === null) {
      try {
        const mod = await import('@deepseek-ai/dsh-llm')
        createUserMessage = typeof mod.createUserMessage === 'function' ? mod.createUserMessage : false
      } catch {
        createUserMessage = false
      }
    }
    const payload = { content: [{ type: 'text', text }], source: { kind: SOURCE_KIND } }
    if (createUserMessage) {
      try {
        const made = createUserMessage(payload)
        if (made !== null && typeof made === 'object') return withIdentity(made)
      } catch {
        // 工厂签名不同就退回手写
      }
    }
    return withIdentity(payload)
  }

  /** 把一段文本投进会话。 */
  async function injectText(text, sessionId) {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('文本是空的')
    let handle = null
    if (sessionId !== undefined && sessionId !== '') {
      const agents = agentsService()
      const list = typeof agents?.list === 'function' ? agents.list() : []
      handle = (Array.isArray(list) ? list : []).find((h) => String(sessionOf(h)?.id ?? '') === sessionId) ?? null
    }
    if (handle === null) handle = pickAgent()
    if (handle === null) throw new Error('没有可注入的会话')
    const agent = agentOf(handle)
    if (!agent || typeof agent.followup !== 'function') throw new Error('这个会话不能注入（没有 followup）')
    const message = await makeUserMessage(body)
    agent.followup(message)
    const sessionId2 = String(sessionOf(handle)?.id ?? '')
    last.inject = { at: new Date().toISOString(), sessionId: sessionId2, chars: body.length }
    return { sessionId: sessionId2, chars: body.length }
  }

  /** 读桌宠运行态：端口会漂（3080 起最多扫 25 个），每次现读。 */
  function petRuntime() {
    const raw = readJson(config.petRuntimeFile, null)
    const port = Number(raw?.port)
    if (!Number.isFinite(port) || port <= 0) return null
    return { port: Math.trunc(port), token: String(raw?.token ?? ''), pid: raw?.pid ?? null }
  }

  async function petPost(route, payload, timeoutMs) {
    const runtime = petRuntime()
    if (runtime === null) throw new Error(`读不到桌宠运行态：${config.petRuntimeFile}`)
    const res = await postJson(runtime.port, route, payload, runtime.token, timeoutMs)
    if (res.status === 404) throw new Error('桌宠这个版本还没有这个端点（要 0.3.9）')
    if (res.status >= 400) throw new Error(`桌宠返回 ${res.status}`)
    if (res.json && res.json.ok === false) throw new Error(`桌宠拒绝：${res.json.error ?? res.json.reason ?? '未知'}`)
    return res.json
  }

  /** 【本鱼 · 11-01】摘要调试：把送进 /summarize 的原文长度和首尾写进日志，定位「只总结前半段」。 */
  function bridgeLogDir() {
    try {
      const runtime = String(config.petRuntimeFile ?? DEFAULT_PET_RUNTIME)
      return path.join(path.dirname(runtime), 'logs')
    } catch {
      return path.join(os.homedir(), '.dsh', 'body-of-fish', 'logs')
    }
  }

  /** 【本鱼 · 11-03】时序流水：turn-stopping → 取正文 → 摘要 → 交给桌宠，各段多少毫秒。 */
  function debugTiming(line) {
    try {
      const dir = bridgeLogDir()
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, 'bridge-timing.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      // 同上：日志写不进去不影响主流程
    }
  }

  function debugSummary(text) {
    try {
      // 【11-03 哥哥发现】老路径 D:\AI\桌宠 已被搬家，这里再硬写会把空目录又建出来；跟着运行时文件走。
      const dir = bridgeLogDir()
      fs.mkdirSync(dir, { recursive: true })
      const line = `${new Date().toISOString()} chars=${text.length} head=${text.slice(0, 120).replace(/\s+/g, ' ')} | tail=${text.slice(-120).replace(/\s+/g, ' ')}\n`
      fs.appendFileSync(path.join(dir, 'bridge-summary.log'), line, 'utf8')
    } catch {
      // 日志写不进去不影响主流程
    }
  }

  /** 按句末标点切句（保留标点，去掉空白）。 */
  function splitSentences(text) {
    return String(text ?? '')
      .split(/(?<=[。！？!?…；;\n])/)
      .map((part) => part.trim())
      .filter((part) => part !== '')
  }

  /**
   * 【本鱼 · 11-03】哥哥的要求：**单句不超过 60 字就不做二次摘要**。
   * 每句都在 maxText 以内 = 本来就能直接口播，本地取前两句，省掉一次模型往返。
   */
  function sentencesWithin(text, maxChars) {
    const parts = splitSentences(text)
    if (parts.length === 0) return false
    return parts.every((part) => part.length <= maxChars)
  }

  /** 本地取前两句（每句兜底截到 maxChars）——「不送模型」那条路用。 */
  function firstSentences(text, maxChars, count = 2) {
    return splitSentences(text)
      .slice(0, count)
      .map((part) => (part.length > maxChars ? part.slice(0, maxChars) : part))
      .join('')
  }

  /** 把一段话交给桌宠压成「最多两句、每句 ≤ maxText 字」；压不出来返回 ''（调用方回落截断）。 */
  async function summarizeText(text) {
    const body = String(text ?? '').trim()
    if (body === '' || body.length <= config.maxText) return ''
    try {
      const json = await petPost('/dsh-pet-7340/summarize?pet=main', { text: body, maxChars: config.maxText }, 60000)
      const sentences = Array.isArray(json?.sentences)
        ? json.sentences.map((s) => String(s ?? '').trim()).filter((s) => s !== '')
        : []
      if (sentences.length > 0) {
        last.summarize = { at: new Date().toISOString(), chars: body.length, out: sentences.length }
        return sentences.join('')
      }
      const joined = String(json?.text ?? '').trim()
      if (joined !== '') {
        last.summarize = { at: new Date().toISOString(), chars: body.length, out: 1 }
        return joined
      }
      return ''
    } catch {
      return ''
    }
  }

  /** 回复交回桌宠：气泡 +（可选）朗读。speak:false = 只冒泡不出声（压不出摘要时用）。 */
  let lastSent = { key: '', at: 0 }
  async function toPet(text, sessionId, opts) {
    // 摘要已经是「两句、每句 ≤ maxText」了，别再按单句长截一次——那会把第二句砍掉（哥哥 11-01 报「只有一条」）。
    const limit = opts && opts.summary === true ? 0 : config.maxText
    const body = plainText(text, limit)
    if (body === '') return
    const key = String(sessionId ?? '') + '|' + body
    const now = Date.now()
    if (lastSent.key === key && now - lastSent.at < 30000) {
      last.dedupe = { at: new Date().toISOString(), key: body.slice(0, 40) }
      return
    }
    lastSent = { key, at: now }
    const surface = 'surface=desktop'
    const spoken = config.speakReply && !(opts && opts.speak === false)
    // 念的时候气泡由桌宠自己写：时长跟音频走、说完还配一张表情包（哥哥 11-01）。
    // 桥只在「只冒泡不出声」时自己写气泡，否则同一句会冒两遍。
    if (config.bubbleReply && !spoken) {
      // 90 秒：桌宠可能正忙着识图（视觉模型冷启动 50-90 秒），20 秒的默认值会把气泡丢掉。
      await petPost(`/dsh-pet-7340/broadcast?pet=main&${surface}`, { text: body, duration: 12000 }, 90000)
      last.bubble = { at: new Date().toISOString(), sessionId, chars: body.length }
    }
    if (spoken) {
      try {
        await petPost('/dsh-pet-7340/say-loud', { text: body, surface: 'desktop' }, 120000)
        last.bubble = { at: new Date().toISOString(), sessionId, chars: body.length }
      } catch (error) {
        // 念不出来也别把话吞掉：退回气泡，至少让哥哥看见。
        last.error = { at: new Date().toISOString(), where: 'say-loud', message: String(error?.message ?? error) }
        if (config.bubbleReply) {
          await petPost(`/dsh-pet-7340/broadcast?pet=main&${surface}`, { text: body, duration: 12000 }, 90000)
          last.bubble = { at: new Date().toISOString(), sessionId, chars: body.length }
        }
      }
    }
  }

  /** 图片交给桌宠识图，描述回投同一会话。 */
  async function lookImage(sessionId, attachment) {
    const file = attachmentPath(attachment.attachmentId)
    if (file === '' || !fs.existsSync(file)) return null
    if (looked.has(attachment.attachmentId)) return null
    looked.add(attachment.attachmentId)
    const json = await petPost('/dsh-pet-7340/look', { file, name: attachment.name }, 150000)
    const text = String(json?.text ?? json?.description ?? '').trim()
    last.look = { at: new Date().toISOString(), sessionId, chars: text.length }
    if (text !== '') {
      const message = await makeUserMessage(`（桌宠看过了这张图：${text}）`)
      await injectText(message.content[0].text, sessionId)
    }
    return text
  }

  /** 挂到某个会话上：听完记文本、回合结束时把回复交回桌宠。 */
  function mount(handle) {
    const session = sessionOf(handle)
    if (!session) return
    const sid = String(session.id ?? '')
    if (sid === '' || mounted.has(sid)) return
    const agent = agentOf(handle)
    const bus = (agent && agent.ctx) || (handle && handle.ctx) || null
    if (!bus || typeof bus.on !== 'function') return
    mounted.add(sid)
    try {
      bus.on('agent/inbox/inserted', (payload) => {
        if (!isActiveInstance()) return // 旧实例退场（同 turn-stopping）
        const message = (payload && payload.message) || payload
        if (!config.enabled) return
        // 只认「接入的那个会话」：别的会话贴图不交给桌宠（哥哥 11-02）
        if (config.sessionId === '' || config.sessionId !== sid) return
        const source = message !== null && typeof message === 'object' ? message.source : null
        if (source && String(source.kind ?? '') === SOURCE_KIND) return
        if (!config.lookImages) return
        const images = imageAttachments(message)
        if (images.length === 0) return
        for (const image of images) {
          void lookImage(sid, image).catch((error) => {
            last.error = { at: new Date().toISOString(), where: 'look', message: String(error?.message ?? error) }
          })
        }
      })
    } catch {
      // 事件名随版本变，挂不上不影响注入那条链
    }
    // 【本鱼 · 11-01】GUI 里直接贴图不走 `agent/inbox/inserted`（那条是「排进待处理队列」的路径），
    // 所以再挂一道 `session/event`：会话里出现带图片的 user/message 就交给桌宠看。
    // 两条路都可能命中，靠 `looked` 按 attachmentId 去重，不会看两遍。
    try {
      bus.on('session/event', (subject, event) => {
        if (!isActiveInstance()) return // 旧实例（刷新前）自己退场，别再重复投递
        if (!config.enabled || !config.lookImages) return
        if (!event || event.type !== 'user/message') return
        // 同上：只盯选中的会话（哥哥 11-02）
        if (config.sessionId === '' || config.sessionId !== sid) return
        if (!subject || subject !== session) return
        const message = event.data
        if (message === null || typeof message !== 'object') return
        const source = message.source
        if (source && String(source.kind ?? '') === SOURCE_KIND) return
        const images = imageAttachments(message)
        if (images.length === 0) return
        for (const image of images) {
          void lookImage(sid, image).catch((error) => {
            last.error = { at: new Date().toISOString(), where: 'look', message: String(error?.message ?? error) }
          })
        }
      })
    } catch {
      // 同上
    }
    try {
      bus.on('agent/turn-stopping', () => {
        if (!isActiveInstance()) return // 同上：刷新后旧实例的钩子不许再送一遍
        if (!config.enabled || (!config.bubbleReply && !config.speakReply)) return
        // 【本鱼 · 11-02】只跟「接入的那个会话」，别的会话（QQ 群、隔壁仓）一律不碰。
        // 哥哥用隔壁 QQ 接口的会话测过：以前每个挂上的会话都会冒泡，还只冒不念。
        if (config.sessionId === '' || config.sessionId !== sid) return
        let text = ''
        try {
          const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i]
            if (event && event.type === 'assistant/message') {
              // 【本鱼 · 11-01】对话中途的工具步也可能落一条 assistant/message（只有 reasoning + tool-call，没有正文）。
              // 以前取到它就 break，正文是空的，整轮直接不出气泡；改成往前找第一条有正文的。
              const piece = messageText(event.data?.message)
              if (piece !== '') {
                text = piece
                debugSummary(text)
                break
              }
            }
          }
        } catch {
          text = ''
        }
        if (text === '') return
        void (async () => {
          const startedAt = Date.now()
          // 【本鱼 · 11-03 哥哥定】单句都 ≤ maxText（60 字）就**不送模型**，本地取前两句（合计 ≤120 字）直接念。
          // 只有「有一句超过 60 字」才值得让桌宠模型压一遍。
          const plain = plainText(text, 0)
          const fastPath = plain !== '' && sentencesWithin(plain, config.maxText)
          const summarized = fastPath ? '' : await summarizeText(text)
          const body = fastPath ? firstSentences(plain, config.maxText) : summarized !== '' ? summarized : text
          debugTiming(
            `fast=${fastPath ? 1 : 0} prepare=${Date.now() - startedAt}ms chars=${body.length} src=${text.length}`,
          )
          // 【本鱼 · 11-02】短的（≤ maxText）不压摘要，但**照样念**——哥哥报「有气泡没声音」就是这儿：
          // 以前 summarized === '' 时把 speak 置 false，只冒泡不出声。长的才用摘要，免得念全文。
          await toPet(body, sid, {
            summary: fastPath || summarized !== '',
          })
        })().catch((error) => {
          last.error = { at: new Date().toISOString(), where: 'toPet', message: String(error?.message ?? error) }
        })
      })
    } catch {
      // 同上
    }
  }

  function mountAll() {
    const agents = agentsService()
    const list = typeof agents?.list === 'function' ? agents.list() : []
    for (const handle of Array.isArray(list) ? list : []) mount(handle)
    for (const eventName of ['agent/created', 'agent/added', 'session/added']) {
      try {
        ctx.on(eventName, (payload) => {
          const handle = (payload && payload.agent) || payload
          mount(handle)
        })
      } catch {
        // 容错：没有这些事件就算了，list() 已经覆盖启动时活着的会话
      }
    }
  }
  mountAll()

  // 桌宠每 20 秒读一次发现文件；DSH 重启后端口会变，插件这边也定时重写，
  // 免得「桌宠先开、DSH 后开」时桌宠一直拿着旧端口、要等浏览器碰巧请求一次才更新。
  const publishTimer = setInterval(() => {
    try {
      publishDiscovery(guessBaseUrl())
    } catch {
      // 写不进去不影响主链
    }
  }, 20_000)
  try {
    publishTimer.unref?.()
  } catch {
    // 忽略
  }
  setTimeout(() => {
    try {
      publishDiscovery(guessBaseUrl())
    } catch {
      // 忽略
    }
  }, 1500)

  // ---- HTTP：/api/pet-bridge -------------------------------------------
  const json = (res, status, value) => {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
    res.end(body)
  }
  const html = (res, status, value) => {
    const body = Buffer.from(value, 'utf8')
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
    res.end(body)
  }
  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).length > 200_000) req.destroy()
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })

  ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const host = String(req.headers.host ?? '')
      if (host !== '') publishDiscovery(`http://${host}${API_PREFIX}`)
      else publishDiscovery(guessBaseUrl())
      try {
        if (route === '/state' && req.method === 'GET') {
          const runtime = petRuntime()
          return json(res, 200, {
            enabled: config.enabled,
            config,
            sessions: listSessions(),
            selected: pickAgent() ? String(sessionOf(pickAgent()).id ?? '') : '',
            pet: runtime === null ? { ok: false } : { ok: true, port: runtime.port, pid: runtime.pid },
            mounted: [...mounted],
            last,
            debug: {
              env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /port|dsh|web/i.test(k))),
              webServerKeys: Object.keys(ctx.webServer ?? {}),
              webServerPort: ctx.webServer?.port ?? null,
            },
            configPath: CONFIG_PATH,
          })
        }
        if (route === '/config' && (req.method === 'POST' || req.method === 'PUT')) {
          const patch = await readBody(req)
          config = normalizeConfig(patch)
          writeJsonAtomic(CONFIG_PATH, config)
          publishDiscovery(guessBaseUrl())
          return json(res, 200, { ok: true, config })
        }
        if (route === '/say' && req.method === 'POST') {
          const body = await readBody(req)
          const result = await injectText(body.text, body.sessionId)
          return json(res, 200, { ok: true, ...result })
        }
        if (route === '/look' && req.method === 'POST') {
          const body = await readBody(req)
          const file = String(body.file ?? '')
          if (file === '') return json(res, 400, { ok: false, error: 'file 必填' })
          const result = await petPost('/dsh-pet-7340/look', { file, name: String(body.name ?? '') })
          return json(res, 200, { ok: true, result })
        }
        if (route === '/page' && req.method === 'GET') {
          return html(res, 200, PAGES)
        }
        if (route === '/picker' && req.method === 'GET') {
          return html(res, 200, PICKER_PAGE)
        }
        return json(res, 404, { ok: false, error: `未知端点 ${route}` })
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
}

const PAGES = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠桥设置</title>
<style>body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 18px;color:#22313b;background:#f6fafc}
h1{font-size:22px;color:#1b5f8a}fieldset{border:1px solid #d8e3ea;border-radius:10px;background:#fff;margin:14px 0;padding:12px 16px}
legend{font-weight:700;color:#1b5f8a}label{display:block;margin:10px 0 4px;color:#6d7f8b;font-size:13px}
select,input{width:100%;min-height:34px;padding:5px 9px;border:1px solid #d8e3ea;border-radius:6px;font-size:14px}
button{background:#1b5f8a;color:#fff;border:0;min-height:38px;padding:7px 22px;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer}
#status{margin-left:12px;font-size:13px;color:#6d7f8b}code{background:#edf5fa;padding:1px 5px;border-radius:4px;font-size:12.5px}
</style></head><body>
<h1>桌宠桥</h1>
<p style="color:#6d7f8b;font-size:13.5px">DSH ↔ 本鱼陪伴（<code>127.0.0.1</code> 上的独立桌宠）之间的桥。</p>
<form id="f">
<fieldset><legend>开关</legend>
<label><input type="checkbox" id="enabled" style="width:16px;height:16px"> 启用桥</label>
<label><input type="checkbox" id="bubbleReply" style="width:16px;height:16px"> 回复写进桌宠气泡</label>
<label><input type="checkbox" id="speakReply" style="width:16px;height:16px"> 回复让桌宠读出来（0.3.9）</label>
<label><input type="checkbox" id="lookImages" style="width:16px;height:16px"> 收到图片交给桌宠识图（0.3.9）</label>
</fieldset>
<fieldset><legend>注入到哪个会话</legend>
<label for="sessionId">会话（留空 = 自动挑最近活跃的）</label>
<select id="sessionId"><option value="">自动</option></select>
<label for="maxText">气泡/朗读的文本上限（字）</label>
<input id="maxText" type="number" min="20" max="2000" step="10">
</fieldset>
<button type="submit">保存</button><span id="status">正在读取…</span>
</form>
<script>
const P='/api/pet-bridge';
const f=document.getElementById('f'),st=document.getElementById('status');
async function get(p){const r=await fetch(P+p,{cache:'no-store'});if(!r.ok)throw new Error(await r.text());return r.json()}
async function refresh(){try{
  const d=await get('/state');
  for(const k of ['enabled','bubbleReply','speakReply','lookImages'])document.getElementById(k).checked=!!d.config[k];
  document.getElementById('maxText').value=d.config.maxText;
  const sel=document.getElementById('sessionId');sel.length=1;
  for(const s of d.sessions){const o=document.createElement('option');o.value=s.id;
    o.textContent=(s.title||'')+' '+(s.cwd||'')+' · '+(s.status||'')+' · '+s.id.slice(-6);if(s.id===d.selected)o.selected=true;sel.appendChild(o)}
  if(d.config.sessionId)sel.value=d.config.sessionId;
  st.textContent=d.pet.ok?'桌宠在线（端口 '+d.pet.port+'）':'桌宠不在线';
}catch(e){st.textContent='读取失败：'+e.message}}
f.addEventListener('submit',async(ev)=>{ev.preventDefault();
  const body={enabled:document.getElementById('enabled').checked,bubbleReply:document.getElementById('bubbleReply').checked,
    speakReply:document.getElementById('speakReply').checked,lookImages:document.getElementById('lookImages').checked,
    maxText:Number(document.getElementById('maxText').value),sessionId:document.getElementById('sessionId').value};
  try{const r=await fetch(P+'/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok)throw new Error(await r.text());st.textContent='已保存';refresh()}catch(e){st.textContent='保存失败：'+e.message}});
refresh();
</script></body></html>`

/**
 * 选会话的小页面（右键菜单「状态 ▸ 接入 ▸ 选会话…」打开这一个）。
 *
 * 为什么单独做一页：右键菜单里一条一个会话，会话一多就翻不动；这里一屏列全，
 * 点一下就把 `sessionId` 写进桥配置，页面自己打勾、不用回菜单确认。
 */
const PICKER_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>选一个会话接入</title>
<style>body{font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;max-width:760px;margin:28px auto;padding:0 18px;color:#22313b;background:#f6fafc}
h1{font-size:21px;color:#1b5f8a;margin:0 0 4px}p.hint{color:#6d7f8b;font-size:13.5px;margin:0 0 16px}
ul{list-style:none;padding:0;margin:0}li{background:#fff;border:1px solid #d8e3ea;border-radius:10px;margin:8px 0;padding:10px 14px;cursor:pointer;display:flex;gap:10px;align-items:center}
li:hover{border-color:#7db3d6}li.on{border-color:#1b8f6a;background:#f2fbf7}
.mark{width:22px;text-align:center;color:#1b8f6a;font-weight:700}
.t{font-weight:600}.m{color:#6d7f8b;font-size:13px;margin-left:auto;white-space:nowrap}
#state{color:#6d7f8b;font-size:13.5px;min-height:20px;margin-top:12px}</style></head><body>
<h1>把桌宠接到哪个会话</h1>
<p class="hint">点一行就接上，绿色的就是当前接的那个。桌宠那边的「状态 ▸ 接入」会跟着变。</p>
<ul id="list"></ul>
<div id="state">正在读…</div>
<script>
const P='/api/pet-bridge';
const list=document.getElementById('list'),state=document.getElementById('state');
async function get(p){const r=await fetch(P+p,{cache:'no-store'});if(!r.ok)throw new Error(await r.text());return r.json()}
function label(s){const base=((s.title||'').trim()||(s.cwd||'').split(/[\\\\/]/).filter(Boolean).pop()||'会话');return base.length>18?base.slice(0,18)+'…':base}
async function refresh(){
  try{
    const d=await get('/state');
    list.innerHTML='';
    if(!d.sessions.length){list.innerHTML='<li>没有会话</li>'}
    for(const s of d.sessions){
      const li=document.createElement('li');
      const on=(s.id===d.config.sessionId)||(!d.config.sessionId&&s.id===d.selected);
      if(on)li.className='on';
      li.innerHTML='<span class="mark">'+(on?'✓':'')+'</span><span class="t"></span><span class="m">'+(s.status||'')+' · '+s.id.slice(-6)+'</span>';
      li.querySelector('.t').textContent=label(s);
      li.title=(s.cwd||'')+'\\n'+s.id;
      li.addEventListener('click',()=>pick(s.id,label(s)));
      list.appendChild(li);
    }
    state.textContent=d.pet.ok?'桌宠在线（端口 '+d.pet.port+'）':'桌宠不在线';
  }catch(e){state.textContent='读取失败：'+e.message}
}
async function pick(id,name){
  try{
    const r=await fetch(P+'/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:id,enabled:true})});
    if(!r.ok)throw new Error(await r.text());
    state.textContent='接上了：'+name;
    refresh();
  }catch(e){state.textContent='没接上：'+e.message}
}
refresh();
</script></body></html>`
