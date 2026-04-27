import type {
  AppSettings,
  ImageApiResponse,
  ResponsesApiTextOutput,
  ResponsesImageOutput,
  ResponsesImageToolOptions,
  ResponsesReasoningEffort,
  TaskParams,
} from '../types'
import { buildApiUrl, readClientDevProxyConfig } from './devProxy'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export { normalizeBaseUrl } from './devProxy'

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  return blobToDataUrl(await response.blob(), fallbackMime)
}

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
}

export interface CallResponsesImageApiOptions {
  settings: AppSettings
  model: string
  prompt: string
  previousResponseId?: string
  reasoningEffort: ResponsesReasoningEffort
  toolOptions: ResponsesImageToolOptions
  inputImageDataUrls: string[]
}

export interface CallResponsesImageApiResult {
  responseId?: string
  images: ResponsesImageOutput[]
  texts: ResponsesApiTextOutput[]
}

interface ResponsesApiContentItem {
  type?: string
  text?: string
}

interface ResponsesApiOutputItem {
  id?: string
  type?: string
  result?: string
  revised_prompt?: string
  content?: ResponsesApiContentItem[]
}

interface ResponsesApiResponse {
  id?: string
  output?: ResponsesApiOutputItem[]
}

interface ResponsesImagePayloadBuildResult {
  body: Record<string, unknown>
  mime: string
}

interface ResponsesWebSocketEvent {
  type?: string
  id?: string
  response?: ResponsesApiResponse & {
    error?: {
      message?: string
    }
    incomplete_details?: {
      reason?: string
    }
  }
  item?: ResponsesApiOutputItem
  error?: {
    message?: string
  }
  delta?: string
  text?: string
}

const WEBSOCKET_PROTOCOL_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/
const SUB2API_WS_API_KEY_PROTOCOL_PREFIX = 'sub2api-api-key.'
const RESPONSES_WS_ABNORMAL_CLOSE_CODE = 1006
const RESPONSES_IMAGE_INSTRUCTIONS = [
  'You are an image generation assistant.',
  'Follow the latest user request and use prior response context when provided.',
  'Use the image_generation tool whenever the request asks for image generation or image editing.',
  'Use any attached images as visual references unless the user gives different instructions.',
  'Keep text responses concise and focused on useful generation details.',
].join(' ')

async function readErrorMessage(response: Response): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  try {
    const errJson = await response.json()
    if (errJson.error?.message) errorMsg = errJson.error.message
    else if (errJson.message) errorMsg = errJson.message
  } catch {
    try {
      errorMsg = await response.text()
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

function buildWebSocketApiUrl(baseUrl: string, path: string, proxyConfig?: ReturnType<typeof readClientDevProxyConfig>): string {
  const apiUrl = buildApiUrl(baseUrl, path, proxyConfig)
  const url = new URL(apiUrl, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function buildSub2ApiWebSocketProtocols(apiKey: string): string[] {
  const trimmedApiKey = apiKey.trim()
  const authProtocol = `${SUB2API_WS_API_KEY_PROTOCOL_PREFIX}${trimmedApiKey}`

  if (!WEBSOCKET_PROTOCOL_TOKEN_RE.test(authProtocol)) {
    throw new Error('当前 API Key 包含 WebSocket subprotocol 不支持的字符，无法使用 sub2api WS v2 代理')
  }

  return ['sub2api.responses.v2', authProtocol]
}

function buildResponsesImagePayload(opts: CallResponsesImageApiOptions): ResponsesImagePayloadBuildResult {
  const { model, prompt, previousResponseId, reasoningEffort, toolOptions, inputImageDataUrls } = opts
  const mime = MIME_MAP[toolOptions.output_format] || 'image/png'
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: toolOptions.action,
    size: toolOptions.size,
    quality: toolOptions.quality,
    output_format: toolOptions.output_format,
  }

  if (toolOptions.output_format !== 'png' && toolOptions.output_compression != null) {
    tool.output_compression = toolOptions.output_compression
  }
  tool.moderation = toolOptions.moderation

  const content: Array<Record<string, string>> = []
  const trimmedPrompt = prompt.trim()
  if (trimmedPrompt) {
    content.push({ type: 'input_text', text: trimmedPrompt })
  }
  for (const dataUrl of inputImageDataUrls) {
    content.push({ type: 'input_image', image_url: dataUrl })
  }

  const body: Record<string, unknown> = {
    model: model.trim(),
    instructions: RESPONSES_IMAGE_INSTRUCTIONS,
    input: [
      {
        role: 'user',
        content,
      },
    ],
    tools: [tool],
  }

  const trimmedPreviousResponseId = previousResponseId?.trim()
  if (trimmedPreviousResponseId) {
    body.previous_response_id = trimmedPreviousResponseId
  }
  if (reasoningEffort !== 'default') {
    body.reasoning = { effort: reasoningEffort }
  }

  return { body, mime }
}

function parseResponsesOutput(payload: ResponsesApiResponse, mime: string): CallResponsesImageApiResult {
  const images: ResponsesImageOutput[] = []
  const texts: ResponsesApiTextOutput[] = []

  for (const item of payload.output ?? []) {
    collectResponsesOutputItem(item, mime, images, texts)
  }

  return {
    responseId: payload.id,
    images,
    texts,
  }
}

function collectResponsesOutputItem(
  item: ResponsesApiOutputItem,
  mime: string,
  images: ResponsesImageOutput[],
  texts: ResponsesApiTextOutput[],
) {
  if (item.type === 'image_generation_call' && item.result) {
    const alreadyCollected = images.some((image) => (
      image.callId === item.id || image.image === normalizeBase64Image(item.result!, mime)
    ))

    if (!alreadyCollected) {
      images.push({
        image: normalizeBase64Image(item.result, mime),
        revisedPrompt: item.revised_prompt,
        callId: item.id,
      })
    }
    return
  }

  for (const content of item.content ?? []) {
    if (content.type === 'output_text' && content.text) {
      texts.push({ text: content.text })
    }
  }
}

function readResponsesWebSocketError(event: ResponsesWebSocketEvent): string {
  return event.error?.message
    || event.response?.error?.message
    || event.response?.incomplete_details?.reason
    || 'Responses WebSocket 请求失败'
}

function readResponsesWebSocketCloseError(event: CloseEvent): string {
  if (event.code === RESPONSES_WS_ABNORMAL_CLOSE_CODE) {
    return 'Responses WebSocket 异常断开（1006）：代理或上游在长时间生成时关闭了连接，请检查 API_PROXY_TIMEOUT、Caddy/Nginx WebSocket 代理和 sub2api 日志'
  }

  const reason = event.reason ? `：${event.reason}` : ''
  return `Responses WebSocket 已关闭（${event.code}）${reason}`
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, prompt, params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = {
    Authorization: `Bearer ${settings.apiKey}`,
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)

  try {
    let response: Response

    if (isEdit) {
      const formData = new FormData()
      formData.append('model', settings.model)
      formData.append('prompt', prompt)
      formData.append('size', params.size)
      formData.append('quality', params.quality)
      formData.append('output_format', params.output_format)
      formData.append('moderation', params.moderation)

      if (params.output_format !== 'png' && params.output_compression != null) {
        formData.append('output_compression', String(params.output_compression))
      }

      for (let i = 0; i < inputImageDataUrls.length; i++) {
        const dataUrl = inputImageDataUrls[i]
        const resp = await fetch(dataUrl)
        const blob = await resp.blob()
        const ext = blob.type.split('/')[1] || 'png'
        formData.append('image[]', blob, `input-${i + 1}.${ext}`)
      }

      response = await fetch(buildApiUrl(settings.baseUrl, 'images/edits', proxyConfig), {
        method: 'POST',
        headers: requestHeaders,
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      })
    } else {
      const body: Record<string, unknown> = {
        model: settings.model,
        prompt,
        size: params.size,
        quality: params.quality,
        output_format: params.output_format,
        moderation: params.moderation,
      }

      if (params.output_format !== 'png' && params.output_compression != null) {
        body.output_compression = params.output_compression
      }
      if (params.n > 1) {
        body.n = params.n
      }

      response = await fetch(buildApiUrl(settings.baseUrl, 'images/generations', proxyConfig), {
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const payload = await response.json() as ImageApiResponse
    const data = payload.data
    if (!Array.isArray(data) || !data.length) {
      throw new Error('接口未返回图片数据')
    }

    const images: string[] = []
    for (const item of data) {
      const b64 = item.b64_json
      if (b64) {
        images.push(normalizeBase64Image(b64, mime))
        continue
      }

      if (isHttpUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, controller.signal))
      }
    }

    if (!images.length) {
      throw new Error('接口未返回可用图片数据')
    }

    return { images }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function callResponsesImageApi(
  opts: CallResponsesImageApiOptions,
): Promise<CallResponsesImageApiResult> {
  const { settings } = opts
  const proxyConfig = readClientDevProxyConfig()
  const { body, mime } = buildResponsesImagePayload(opts)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)

  try {
    const response = await fetch(buildApiUrl(settings.baseUrl, 'responses', proxyConfig), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const payload = await response.json() as ResponsesApiResponse
    const result = parseResponsesOutput(payload, mime)

    if (!result.images.length && !result.texts.length) {
      throw new Error('Responses API 未返回可显示内容')
    }

    return result
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function callResponsesImageApiWebSocket(
  opts: CallResponsesImageApiOptions,
): Promise<CallResponsesImageApiResult> {
  const { settings } = opts
  const proxyConfig = readClientDevProxyConfig()
  const wsUrl = buildWebSocketApiUrl(settings.baseUrl, 'responses', proxyConfig)
  const parsedWsUrl = new URL(wsUrl)

  if (parsedWsUrl.origin !== window.location.origin.replace(/^http/, 'ws')) {
    throw new Error('Responses WebSocket v2 需要使用同源 /v1/ 代理；请将 API URL 设为 same-origin 并配置 API_PROXY_URL')
  }

  const { body, mime } = buildResponsesImagePayload(opts)
  const wsPayload = {
    type: 'response.create',
    ...body,
    stream: true,
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let responseId = ''
    let textBuffer = ''
    const images: ResponsesImageOutput[] = []
    const texts: ResponsesApiTextOutput[] = []
    const timeoutId = window.setTimeout(() => {
      rejectOnce(new Error(`Responses WebSocket 请求超时（${settings.timeout}s）`))
      try {
        ws.close(1000, 'timeout')
      } catch {
        /* ignore */
      }
    }, settings.timeout * 1000)

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl, buildSub2ApiWebSocketProtocols(settings.apiKey))
    } catch (err) {
      window.clearTimeout(timeoutId)
      reject(err)
      return
    }

    const rejectOnce = (err: Error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      reject(err)
    }

    const resolveOnce = (result: CallResponsesImageApiResult) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      resolve(result)
      try {
        ws.close(1000, 'complete')
      } catch {
        /* ignore */
      }
    }

    const finish = (payload?: ResponsesApiResponse) => {
      const parsed = payload ? parseResponsesOutput(payload, mime) : undefined
      const finalImages = parsed?.images.length ? parsed.images : images
      const finalTexts = parsed?.texts.length ? parsed.texts : texts
      const bufferedText = textBuffer.trim()

      if (!finalTexts.length && bufferedText) {
        finalTexts.push({ text: bufferedText })
      }

      if (!finalImages.length && !finalTexts.length) {
        rejectOnce(new Error('Responses WebSocket 未返回可显示内容'))
        return
      }

      resolveOnce({
        responseId: parsed?.responseId || responseId || undefined,
        images: finalImages,
        texts: finalTexts,
      })
    }

    const handleEvent = (event: ResponsesWebSocketEvent) => {
      const eventResponseId = event.response?.id || event.id
      if (eventResponseId) responseId = eventResponseId

      switch (event.type) {
        case 'response.created':
        case 'response.in_progress':
          return
        case 'response.output_text.delta':
          if (event.delta) textBuffer += event.delta
          return
        case 'response.output_text.done':
          if (event.text) texts.push({ text: event.text })
          return
        case 'response.output_item.done':
          if (event.item) collectResponsesOutputItem(event.item, mime, images, texts)
          return
        case 'response.completed':
        case 'response.done':
          finish(event.response)
          return
        case 'response.failed':
        case 'response.incomplete':
        case 'error':
          rejectOnce(new Error(readResponsesWebSocketError(event)))
          return
        default:
          if (event.item) collectResponsesOutputItem(event.item, mime, images, texts)
      }
    }

    ws.onopen = () => {
      ws.send(JSON.stringify(wsPayload))
    }

    ws.onmessage = async (messageEvent) => {
      try {
        const raw = typeof messageEvent.data === 'string'
          ? messageEvent.data
          : messageEvent.data instanceof Blob
            ? await messageEvent.data.text()
            : new TextDecoder().decode(messageEvent.data)
        handleEvent(JSON.parse(raw) as ResponsesWebSocketEvent)
      } catch (err) {
        rejectOnce(err instanceof Error ? err : new Error(String(err)))
      }
    }

    ws.onerror = () => {
      rejectOnce(new Error('Responses WebSocket 连接失败'))
    }

    ws.onclose = (event) => {
      if (settled) return
      if (
        event.code === RESPONSES_WS_ABNORMAL_CLOSE_CODE
        && (images.length > 0 || texts.length > 0 || textBuffer.trim())
      ) {
        finish()
        return
      }

      rejectOnce(new Error(readResponsesWebSocketCloseError(event)))
    }
  })
}
