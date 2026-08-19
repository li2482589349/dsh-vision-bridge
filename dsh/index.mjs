// vision-bridge v8 —— 为纯文本模型补上视觉能力（借鉴 modlens 的"包装适配器"架构）。
//
// v8 相对 v7 的优化：自动识别图片类型切换识别模式（config.mode 默认 auto）：
//   - 先做一次轻量分类（document/chart/illustration/photo）
//   - document/chart → ocr 纯逐字转录；illustration → evidence 结构化证据；
//     photo → describe 视觉描述
//   - 分类结果与识别结果都进缓存（同图不重复付费、不重复分类）
//   - 显式 config.mode / 工具 mode 参数 / config.prompt 优先于自动判断
//
// v7 的既有能力：多图分隔线、提示词模式化（evidence/ocr/describe）、
// 缓存键纳入提示词、visb_read_image 工具按次指定 mode/prompt。
//
// 架构要点（同 v6/v7）：
//   - 为纯文本 provider 路由生成 `(vision)` 变体，声明支持图片 → 上传准入放行；
//     stream() 在请求时把图片块转成识别文本再委托回真实路由 → 会话日志保留原始
//     图片块、UI 显示缩略图，回放走缓存不重复付费。
//   - 只接管被元数据确认纯文本的模型；视觉模型保留原生贴图。
//   - 证据缓存：Promise 合并 + 失败冷却 + LRU + 规范键序。
//   - 回放连续性：restoreUpstreamSource 重标 provider，保住上游 replayState。
export default {
  name: 'vision-bridge',
  inject: ['llm', 'attachments', 'tools'],
  apply(ctx, config = {}) {
    const PINNED_ENGINE = config.provider
      ? { provider: config.provider, model: config.model || 'mimo-v2.5' }
      : null
    const FAMILIES = Array.isArray(config.families) && config.families.length > 0 ? config.families : ['deepseek']
    const TOOL_NAME = config.toolName || 'visb_read_image'
    const WRAP_SUFFIX = ' (vision)'
    const AUTO_READ = config.autoRead === true
    const IMAGE_SEPARATOR = config.separator !== undefined ? config.separator : '\n---\n'

    // 引擎解析：config.provider 固定时用固定的；否则自动发现目标机上第一个
    // 声明支持图片的 pi-ai 路由（如 xiaomi/mimo-v2.5、gemini、openai 兼容端点…），
    // 这样换环境部署时无需改配置，只要目标机配了任意一个视觉引擎即可。
    let engine = PINNED_ENGINE
    let engineScanning = Promise.resolve()
    async function resolveEngine(signal) {
      if (engine !== null) return engine
      if (typeof ctx.llm?.listProviders !== 'function' || typeof ctx.llm?.listModels !== 'function') {
        throw new Error('vision-bridge: llm discovery surface unavailable')
      }
      // 串行扫描，避免并发重复探测
      const run = engineScanning.then(async () => {
        if (engine !== null) return engine
        const providers = ctx.llm.listProviders()
        for (const info of providers) {
          const id = typeof info === 'string' ? info : info?.id
          if (!id || String(id).startsWith('visb-')) continue
          let models = []
          try {
            models = await ctx.llm.listModels(id, signal)
          } catch {
            continue
          }
          const candidate = models.find((m) => Array.isArray(m?.inputModalities) && m.inputModalities.includes('image'))
          if (candidate) {
            engine = { provider: id, model: candidate.id }
            console.log('[vision-bridge] engine auto-discovered: ' + id + '/' + candidate.id)
            return engine
          }
        }
        throw new Error('vision-bridge: no vision-capable provider route found. Configure one in settings (llm-pi-ai.providers, e.g. xiaomi/mimo-v2.5) or set config.provider/model.')
      })
      engineScanning = run.catch(() => {})
      return run
    }

    // ── 提示词模式 ──────────────────────────────────────────────────────────
    const PROMPTS = {
      classify:
        '你是图片分类器。判断这张图片主要属于哪一类，只回复一个英文类别词：\n' +
        '- document：文档/表单/表格/代码/界面截图等以文字为主的内容\n' +
        '- chart：图表/示意图/散点图等\n' +
        '- illustration：插画/绘画/概念设计图等\n' +
        '- photo：照片/自然图像\n' +
        '只回复类别词本身（document/chart/illustration/photo），不要任何其他内容。',
      evidence:
        '你是图片证据提取器。请把这张图片整理成结构化证据，严格按以下格式输出：\n' +
        '【总结】一句话概括图片内容。\n' +
        '【全文转录】逐字转录图片中的全部文字（截图、表格、代码、公式、界面文案），不要遗漏、不要改写、不要总结。\n' +
        '【版面区块】按阅读顺序列出每个区块：类型（标题/段落/表格/图表/代码/表单/按钮/图标等）、序号、内容。\n' +
        '【语义】场景与意图；实体列表（名称 + 类型 + 出处）。\n' +
        '【不确定项】无法确认的内容；没有则写"无"。\n' +
        '只输出以上结构化文本本身，不要任何客套话或解释。',
      ocr:
        '你是图片文字转录器。请逐字转录这张图片中的全部文字内容：界面文案、表单字段与取值、表格的行列、代码、公式、按钮文字，严格按视觉顺序输出。不要遗漏、不要改写、不要总结、不要评价视觉元素。只输出转录文本本身。',
      describe:
        '你是图片描述器。请详细描述这张图片的视觉内容：主体、构图、颜色、风格、材质、场景与氛围。图片中的文字若存在请简要摘录。只输出描述本身，不要客套。',
    }
    const MODE = config.mode && PROMPTS[config.mode] ? config.mode : 'auto'
    const FIXED_PROMPT = config.prompt || (MODE === 'auto' ? PROMPTS.evidence : PROMPTS[MODE])
    // 图片类别 → 识别模式（auto 模式用；识别失败或未知类别回退 evidence）
    const CLASS_TO_MODE = {
      document: 'ocr',
      chart: 'ocr',
      table: 'ocr',
      code: 'ocr',
      form: 'ocr',
      screenshot: 'ocr',
      illustration: 'evidence',
      drawing: 'evidence',
      art: 'evidence',
      photo: 'describe',
      photograph: 'describe',
      image: 'evidence',
    }

    // 失败占位必须是常量：字节稳定，避免失败文案变化改写历史、打爆 provider 前缀缓存。
    const FAILURE_TEXT = '[图片无法识别：vision-bridge 视觉引擎失败。请检查引擎配置。]'

    // ── 证据缓存：Promise 合并 / 失败冷却 / LRU / 规范键序（含提示词维度）─────
    const CACHE_LIMIT = 256
    const FAILURE_COOLDOWN_MS = 60_000
    const monotonicNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const evidenceCache = new Map()

    /** 键序无关的规范序列化：同一图片无论字段顺序如何都命中同一条目。 */
    function evidenceKey(value) {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return '[' + value.map(evidenceKey).join(',') + ']'
      return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + evidenceKey(value[k])).join(',') + '}'
    }

    function hashString(value) {
      let h = 5381
      for (let i = 0; i < value.length; i += 1) h = ((h * 33) ^ value.charCodeAt(i)) >>> 0
      return String(h)
    }

    function trimEvidenceCache() {
      while (evidenceCache.size > CACHE_LIMIT) {
        const first = evidenceCache.keys().next().value
        if (first === undefined) return
        evidenceCache.delete(first)
      }
    }

    /** 等待共享 Promise，但调用方中止不带走底层读取（读取完成仍入缓存）。 */
    function abortableWait(promise, signal) {
      if (!signal) return promise
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason ?? new Error('aborted'))
        const onAbort = () => reject(signal.reason ?? new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
          (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
          (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
        )
      })
    }

    function detailOf(error) {
      const failure = error && error.failure ? error.failure : error
      return failure && failure.message ? failure.message : String(error)
    }

    /** 识别文本缓存（按 提示词+图片 键；Promise 合并 / 失败冷却）。返回裸文本。 */
    function cachedText(ref, promptText, signal) {
      const key = evidenceKey({ p: hashString(promptText), a: ref })
      const hit = evidenceCache.get(key)
      if (hit !== undefined) {
        const cooling = typeof hit === 'object' && hit !== null && typeof hit.retryAfter === 'number'
        if (!cooling || monotonicNow() < hit.retryAfter) {
          evidenceCache.delete(key)
          evidenceCache.set(key, hit)
          return cooling ? Promise.resolve(hit.block) : hit
        }
      }
      const pending = recognize(ref, signal, promptText).then(
        (text) => {
          if (evidenceCache.get(key) === pending) evidenceCache.set(key, text)
          return text
        },
        (error) => {
          console.error('[vision-bridge] image read failed: ' + detailOf(error))
          if (evidenceCache.get(key) === pending) {
            evidenceCache.set(key, { retryAfter: monotonicNow() + FAILURE_COOLDOWN_MS, block: FAILURE_TEXT })
          }
          return FAILURE_TEXT
        },
      )
      evidenceCache.set(key, pending)
      trimEvidenceCache()
      return pending
    }

    /** 图片分类缓存（按 图片 键；失败按 unknown 冷却）。返回类别词。 */
    function cachedClass(ref, signal) {
      const key = evidenceKey({ k: 'class', a: ref })
      const hit = evidenceCache.get(key)
      if (hit !== undefined) {
        const cooling = typeof hit === 'object' && hit !== null && typeof hit.retryAfter === 'number'
        if (!cooling || monotonicNow() < hit.retryAfter) {
          evidenceCache.delete(key)
          evidenceCache.set(key, hit)
          return cooling ? Promise.resolve(hit.block) : hit
        }
      }
      const pending = recognize(ref, signal, PROMPTS.classify).then(
        (raw) => {
          const word = String(raw.trim().match(/[a-z]+/i)?.[0] ?? '').toLowerCase()
          if (evidenceCache.get(key) === pending) evidenceCache.set(key, word)
          return word
        },
        () => {
          if (evidenceCache.get(key) === pending) {
            evidenceCache.set(key, { retryAfter: monotonicNow() + FAILURE_COOLDOWN_MS, block: 'unknown' })
          }
          return 'unknown'
        },
      )
      evidenceCache.set(key, pending)
      trimEvidenceCache()
      return pending
    }

    /** 决定本次识别提示词：显式 prompt > 固定 mode > auto 分类后选模式。 */
    async function resolvePrompt(ref, signal) {
      if (config.prompt) return config.prompt
      if (MODE !== 'auto') return PROMPTS[MODE]
      const word = await abortableWait(cachedClass(ref, signal), signal)
      return PROMPTS[CLASS_TO_MODE[word] || 'evidence']
    }

    async function readImageBlock(block, signal) {
      try {
        const promptText = await resolvePrompt(block.attachment, signal)
        const text = await abortableWait(cachedText(block.attachment, promptText, signal), signal)
        return Object.freeze({ type: 'text', text: '[图片已由 vision-bridge 读取]\n' + text.trim() })
      } catch (error) {
        console.error('[vision-bridge] image read failed: ' + detailOf(error))
        throw error
      }
    }

    /** 图片块 → 识别文本块（Promise 合并 / 失败冷却，键 = 图片引用）。 */
    function cachedRead(block, signal) {
      const key = evidenceKey({ a: block.attachment ?? block })
      const hit = evidenceCache.get(key)
      if (hit !== undefined) {
        const cooling = typeof hit === 'object' && hit !== null && typeof hit.retryAfter === 'number'
        if (!cooling || monotonicNow() < hit.retryAfter) {
          evidenceCache.delete(key)
          evidenceCache.set(key, hit)
          return cooling ? Promise.resolve(hit.block) : hit
        }
      }
      const pending = readImageBlock(block, signal).then(
        (textBlock) => {
          if (evidenceCache.get(key) === pending) {
            evidenceCache.set(key, { retryAfter: monotonicNow() + FAILURE_COOLDOWN_MS, block: textBlock })
          }
          return textBlock
        },
        () => {
          const textBlock = Object.freeze({ type: 'text', text: FAILURE_TEXT })
          if (evidenceCache.get(key) === pending) {
            evidenceCache.set(key, { retryAfter: monotonicNow() + FAILURE_COOLDOWN_MS, block: textBlock })
          }
          return textBlock
        },
      )
      evidenceCache.set(key, pending)
      trimEvidenceCache()
      return pending
    }

    /** 调用视觉引擎：把持久化图片引用转成（模式化）识别文本。 */
    async function recognize(ref, signal, prompt) {
      const promptText = prompt || FIXED_PROMPT
      const { provider, model } = await resolveEngine(signal)
      let out = ''
      const stream = ctx.llm.stream({
        provider,
        model,
        ...(signal === undefined ? {} : { signal }),
        messages: [{
          id: 'visb-' + ref.attachmentId + '-' + (Date.now() % 1000000),
          role: 'user',
          source: { kind: 'user' },
          content: [
            { type: 'image', attachment: ref },
            { type: 'text', text: promptText },
          ],
        }],
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') out += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason === 'error' || chunk.reason === 'aborted') && out.length === 0) {
          throw new Error('vision engine finished with ' + chunk.reason)
        }
      }
      const text = out.trim()
      if (text.length === 0) throw new Error('vision engine returned empty evidence')
      return text
    }

    // ── 图片块转换（递归，含 tool-result 嵌套；多图之间插分隔线）──────────────
    function contentHasImage(blocks) {
      return (
        Array.isArray(blocks) &&
        blocks.some((b) => b?.type === 'image' || (b?.type === 'tool-result' && contentHasImage(b.content)))
      )
    }

    async function convertBlocks(blocks, convertOne) {
      const out = []
      let sawImage = false
      for (const block of blocks) {
        if (block?.type === 'image') {
          if (sawImage) out.push({ type: 'text', text: IMAGE_SEPARATOR })
          sawImage = true
          out.push(await convertOne(block))
        } else if (block?.type === 'tool-result' && contentHasImage(block.content)) {
          out.push({ ...block, content: await convertBlocks(block.content, convertOne) })
        } else {
          out.push(block)
        }
      }
      return out
    }

    async function convertImagesToEvidence(messages, signal) {
      const out = []
      for (const message of messages) {
        if (!contentHasImage(message.content)) {
          out.push(message)
          continue
        }
        const content = await convertBlocks(message.content, (block) => abortableWait(cachedRead(block, signal), signal))
        out.push({ ...message, content })
      }
      return out
    }

    // ── 包装适配器：为纯文本路由生成 (vision) 变体 ───────────────────────────

    // 视觉模型（当前或未来）无需桥接，按名字排除。
    const VISION_ID = /(deepseek-(vl|ocr)|janus|glm-[\d.]*v(\b|-))/i
    const shouldWrap = (info) => {
      const id = String(info?.id ?? '').toLowerCase()
      if (!FAMILIES.some((family) => id.startsWith(family))) return false
      if (VISION_ID.test(id)) return false
      if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) return false
      return true
    }

    const wrapperIdFor = (upstream) => 'visb-' + upstream
    const wrapperIdEncodes = (wrapperId, upstream) => wrapperId === 'visb-' + upstream

    /** 把助手消息的 provider 从包装路由重标回上游：这些消息是上游适配器生产的，
     * 其 replayState（推理连续性）应由上游读取。只有 id 能证明来源时才重标。 */
    function restoreUpstreamSource(messages, wrapperId, upstream) {
      if (!wrapperIdEncodes(wrapperId, upstream)) return messages
      let changed = false
      const out = messages.map((message) => {
        const source = message?.source
        if (message?.role !== 'assistant' || source?.kind !== 'model' || source.provider !== wrapperId) return message
        changed = true
        return { ...message, source: { ...source, provider: upstream } }
      })
      return changed ? out : messages
    }

    const registrations = new Map()
    const wrapped = new Set()

    function registerWrapper(upstream, providerId) {
      const upstreamName = () => {
        try {
          const found = ctx.llm.listProviders().find((entry) => (typeof entry === 'string' ? entry : entry?.id) === upstream)
          return (typeof found === 'string' ? found : found?.name) ?? upstream
        } catch {
          return upstream
        }
      }
      const displayName = upstreamName() + WRAP_SUFFIX
      const withVision = (info) => {
        const inputModalities = Array.isArray(info?.inputModalities) ? [...info.inputModalities] : []
        if (!inputModalities.includes('text')) inputModalities.unshift('text')
        if (!inputModalities.includes('image')) inputModalities.push('image')
        return { ...info, provider: providerId, inputModalities }
      }
      try {
        const registration = ctx.llm.registerAdapter([providerId], {
          providerInfo(provider) {
            return { id: provider, name: displayName }
          },
          providerRetryPolicy() {
            if (typeof ctx.llm.providerRetryPolicy !== 'function') return undefined
            return ctx.llm.providerRetryPolicy(upstream)
          },
          async listModels(_provider, signal) {
            const models = await ctx.llm.listModels(upstream, signal)
            return models.filter(shouldWrap).map((model) => ({
              ...withVision(model),
              name: (model.name ?? model.id) + WRAP_SUFFIX,
            }))
          },
          async resolveModel(_provider, model, signal) {
            const info = await ctx.llm.resolveModelInfo(upstream, model, signal)
            if (!shouldWrap(info)) {
              const declaresImage = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
              throw new Error(
                declaresImage
                  ? `model "${model}" declares native image input, so its "${WRAP_SUFFIX}" entry no longer applies. Select the same model from the provider group without "${WRAP_SUFFIX}".`
                  : `model "${model}" is outside the vision-bridge wrap scope`,
              )
            }
            return { ...withVision(info), id: model }
          },
          stream(options) {
            return (async function* () {
              const converted = await convertImagesToEvidence(options.messages, options.signal)
              const messages = restoreUpstreamSource(converted, providerId, upstream)
              yield* ctx.llm.stream({ ...options, provider: upstream, messages })
            })()
          },
        })
        registrations.set(upstream, { providerId, registration })
        return true
      } catch (error) {
        const duplicate = error?.code === 'DUPLICATE_ADAPTER' || /\balready registered\b|\bduplicate (adapter|provider)\b/i.test(String(error))
        if (duplicate) {
          console.error('[vision-bridge] vision provider ' + providerId + ' already registered, keeping the existing one')
          return true
        }
        console.error('[vision-bridge] vision provider registration skipped (' + providerId + '): ' + String(error))
        return false
      }
    }

    function dropWrapper(upstream, current) {
      registrations.delete(upstream)
      wrapped.delete(upstream)
      if (typeof current.registration === 'function') current.registration()
    }

    // 自动发现：扫描所有已注册路由，为 family 内纯文本模型生成包装；路由晚挂载
    // （llm-pi-ai 在 settings 加载后注册）时由 llm/adapters-updated 触发重扫。
    if (typeof ctx.llm?.registerAdapter === 'function' && typeof ctx.llm?.stream === 'function') {
      let sweeping = Promise.resolve()
      const sweepOnce = async () => {
        try {
          await sweepBody()
        } catch (error) {
          console.error('[vision-bridge] vision provider discovery sweep failed: ' + String(error))
        }
      }
      const sweepBody = async () => {
        if (typeof ctx.llm.listProviders !== 'function') return
        const providers = ctx.llm.listProviders()
        const idOf = (info) => (typeof info === 'string' ? info : info?.id)
        const available = new Set(providers.map(idOf).filter(Boolean))
        for (const [upstream, current] of registrations) {
          if (available.has(upstream)) continue
          dropWrapper(upstream, current)
        }
        for (const info of providers) {
          const id = idOf(info)
          if (!id || String(id).startsWith('visb-')) continue
          if (registrations.has(id)) continue
          if (wrapped.has(id)) continue
          wrapped.add(id)
          let models = []
          try {
            models = await ctx.llm.listModels(id)
          } catch {
            wrapped.delete(id)
            continue
          }
          if (!models.some(shouldWrap)) {
            wrapped.delete(id)
            continue
          }
          const providerId = wrapperIdFor(id)
          if (!registerWrapper(id, providerId)) {
            wrapped.delete(id)
          }
        }
      }
      const sweep = () => {
        sweeping = sweeping.then(sweepOnce, sweepOnce)
        return sweeping
      }
      void sweep()
      if (typeof ctx.on === 'function') {
        ctx.on('llm/adapters-updated', () => {
          void sweep()
        })
      }
    } else {
      console.error('[vision-bridge] llm adapter surface unavailable; wrapper disabled (read tool only)')
    }

    // ── 兜底：agent/pre-step 自动读取（config.autoRead === true 时启用）─────
    if (AUTO_READ && typeof ctx.on === 'function') {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        if (!decision.messages.some((message) => contentHasImage(message.content))) return decision
        const messages = []
        for (const message of decision.messages) {
          if (!contentHasImage(message.content)) {
            messages.push(message)
            continue
          }
          const content = await convertBlocks(message.content, (block) => abortableWait(cachedRead(block, payload.signal), payload.signal))
          messages.push({ ...message, content })
        }
        return { kind: 'enter', messages }
      })
    }

    // ── 启动自检：解析引擎并记录可用性（不阻塞；失败只记日志，识别时再报）──
    resolveEngine().then(
      (e) => console.log('[vision-bridge] engine ready: ' + e.provider + '/' + e.model),
      (error) => console.error('[vision-bridge] ' + (error && error.message ? error.message : String(error))),
    )

    // ── 模型工具：按需读图（路径 → 模式化识别结果；支持按次指定 mode/prompt）──
    if (TOOL_NAME && typeof ctx.tools?.register === 'function') {
      try {
        ctx.tools.register({
          name: TOOL_NAME,
          description:
            '通过 vision-bridge 读取一张本地图片：给定图片的绝对路径，返回识别结果（mode 默认 auto：自动判断图片类型选择模式——文档/表单/代码截图用逐字转录，插画用结构化证据，照片用视觉描述；也可显式指定 evidence/ocr/describe；prompt 可整体覆盖）。当前模型看不到图片时使用。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '图片的绝对本地路径（png/jpeg/webp/gif）' },
              mode: { type: 'string', description: 'auto（默认，自动按图片类型选模式）/ evidence / ocr / describe' },
              prompt: { type: 'string', description: '自定义识别提示词（覆盖 mode）' },
            },
            required: ['path'],
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args) {
            if (typeof args?.path !== 'string' || args.path.trim() === '') {
              throw new Error(TOOL_NAME + ' needs a non-empty string "path".')
            }
            const explicitPrompt = typeof args.prompt === 'string' && args.prompt.trim() !== ''
              ? args.prompt
              : (args.mode && PROMPTS[args.mode] ? PROMPTS[args.mode] : null)
            const fs = ctx.get('fs')
            if (!fs || typeof fs.readBytes !== 'function') throw new Error('fs service unavailable')
            const target = await fs.resolve(args.path)
            const data = await fs.readBytes(target, undefined, 50 * 1024 * 1024)
            const mediaType = sniffMediaType(data)
            if (!mediaType) throw new Error('not a recognized image (png/jpeg/webp/gif)')
            const ref = await ctx.attachments.saveImage({ data: Buffer.from(data), mediaType })
            const promptText = explicitPrompt || (await resolvePrompt(ref, undefined))
            const text = await abortableWait(cachedText(ref, promptText, undefined), undefined)
            return '[图片已由 vision-bridge 读取]\n' + text.trim()
          },
        })
      } catch (error) {
        console.error('[vision-bridge] read tool registration skipped: ' + String(error))
      }
    }
  },
}

/** 魔数嗅探：bytes → 受支持的媒体类型（png/jpeg/webp/gif）。 */
function sniffMediaType(bytes) {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6) {
    const head = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5])
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (b.length >= 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'image/webp'
  return undefined
}
