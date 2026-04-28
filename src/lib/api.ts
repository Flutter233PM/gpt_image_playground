import type {
  AppSettings,
  ImageApiResponse,
  ResponsesApiTextOutput,
  ResponsesActualTransport,
  ResponsesImageOutput,
  ResponsesImageToolOptions,
  ResponsesReasoningContextItemRef,
  ResponsesReasoningEffort,
  TaskParams,
} from '../types'
import { normalizeImageCount } from '../types'
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
  reasoningEffort: ResponsesReasoningEffort
  toolOptions: ResponsesImageToolOptions
  inputImageDataUrls: string[]
  onProgress?: (event: ResponsesImageApiProgressEvent) => void
}

export interface CallResponsesImageApiResult {
  responseId?: string
  images: ResponsesImageOutput[]
  partialImages: ResponsesImageOutput[]
  texts: ResponsesApiTextOutput[]
  transport: ResponsesActualTransport
}

export interface ResponsesImageApiProgressEvent {
  transport: ResponsesActualTransport
  phase: 'connecting' | 'created' | 'in_progress' | 'text' | 'partial_image' | 'output_item' | 'completed' | 'fallback'
  responseId?: string
  text?: string
  images?: ResponsesImageOutput[]
  message?: string
}

interface ResponsesApiContentItem {
  type?: string
  text?: string
  [key: string]: unknown
}

interface ResponsesApiOutputItem {
  id?: string
  type?: string
  result?: string
  revised_prompt?: string
  content?: ResponsesApiContentItem[]
  summary?: Array<Record<string, unknown>>
  encrypted_content?: string
  status?: string
}

interface ResponsesApiResponse {
  id?: string
  output?: ResponsesApiOutputItem[]
}

interface ResponsesImagePayloadBuildResult {
  body: Record<string, unknown>
  mime: string
}

interface ResponsesOutputParseState {
  latestReasoning?: ResponsesReasoningContextItemRef
}

interface ResponsesStreamEvent {
  type?: string
  id?: string
  item_id?: string
  output_item_id?: string
  partial_image?: string
  partial_image_b64?: string
  partial_image_index?: number
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

async function readImageApiImages(response: Response, mime: string, signal: AbortSignal): Promise<string[]> {
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
      images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
    }
  }

  if (!images.length) {
    throw new Error('接口未返回可用图片数据')
  }

  return images
}

function normalizeRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []

  return value.filter((item): item is Record<string, unknown> => (
    typeof item === 'object' && item !== null && !Array.isArray(item)
  ))
}

function normalizeReasoningContextItem(item: ResponsesApiOutputItem): ResponsesReasoningContextItemRef | null {
  if (item.type !== 'reasoning') return null

  const id = item.id?.trim()
  if (!id) return null

  const ref: ResponsesReasoningContextItemRef = {
    type: 'reasoning',
    id,
    summary: normalizeRecordArray(item.summary),
  }

  if (typeof item.encrypted_content === 'string' && item.encrypted_content.trim()) {
    ref.encrypted_content = item.encrypted_content
  }

  const content = normalizeRecordArray(item.content)
  if (content.length) {
    ref.content = content
  }

  if (typeof item.status === 'string' && item.status.trim()) {
    ref.status = item.status
  }

  return ref
}

function buildResponsesImagePayload(
  opts: CallResponsesImageApiOptions,
  enablePartialImages = false,
): ResponsesImagePayloadBuildResult {
  const {
    model,
    prompt,
    reasoningEffort,
    toolOptions,
    inputImageDataUrls,
  } = opts
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
  if (enablePartialImages && toolOptions.partial_images) {
    tool.partial_images = toolOptions.partial_images
  }

  const content: Array<Record<string, string>> = []
  const trimmedPrompt = prompt.trim()
  if (trimmedPrompt) {
    content.push({ type: 'input_text', text: trimmedPrompt })
  }
  for (const dataUrl of inputImageDataUrls) {
    content.push({ type: 'input_image', image_url: dataUrl })
  }

  const input: Array<Record<string, unknown>> = [{
    role: 'user',
    content,
  }]

  const body: Record<string, unknown> = {
    model: model.trim(),
    instructions: RESPONSES_IMAGE_INSTRUCTIONS,
    input,
    tools: [tool],
  }

  if (reasoningEffort !== 'default') {
    body.reasoning = { effort: reasoningEffort }
  }

  return { body, mime }
}

function parseResponsesOutput(
  payload: ResponsesApiResponse,
  mime: string,
  transport: ResponsesActualTransport,
): CallResponsesImageApiResult {
  const images: ResponsesImageOutput[] = []
  const texts: ResponsesApiTextOutput[] = []
  const state: ResponsesOutputParseState = {}

  for (const item of payload.output ?? []) {
    collectResponsesOutputItem(item, mime, images, texts, state)
  }

  return {
    responseId: payload.id,
    images,
    partialImages: [],
    texts,
    transport,
  }
}

function collectResponsesOutputItem(
  item: ResponsesApiOutputItem,
  mime: string,
  images: ResponsesImageOutput[],
  texts: ResponsesApiTextOutput[],
  state?: ResponsesOutputParseState,
) {
  if (item.type === 'reasoning') {
    const reasoning = normalizeReasoningContextItem(item)
    if (reasoning && state) state.latestReasoning = reasoning
    return
  }

  if (item.type === 'image_generation_call' && item.result) {
    const imageData = normalizeBase64Image(item.result, mime)
    const callId = item.id?.trim()
    const existing = images.find((image) => (
      (callId ? image.callId === callId : false) || image.image === imageData
    ))

    if (existing) {
      if (!existing.reasoning && state?.latestReasoning) {
        existing.reasoning = state.latestReasoning
        existing.reasoningId = state.latestReasoning.id
      }
      if (!existing.revisedPrompt && item.revised_prompt) {
        existing.revisedPrompt = item.revised_prompt
      }
    } else {
      images.push({
        image: imageData,
        revisedPrompt: item.revised_prompt,
        callId,
        reasoningId: state?.latestReasoning?.id,
        reasoning: state?.latestReasoning,
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

function readResponsesStreamError(event: ResponsesStreamEvent): string {
  return event.error?.message
    || event.response?.error?.message
    || event.response?.incomplete_details?.reason
    || 'Responses HTTP 流式请求失败'
}

function readPartialImageIndex(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.trunc(value))
}

function getPartialImageOutput(
  event: ResponsesStreamEvent,
  mime: string,
): ResponsesImageOutput | null {
  const partialImage = event.partial_image_b64 || event.partial_image
  if (!partialImage) return null

  const callId = event.item_id?.trim() || event.output_item_id?.trim() || event.id?.trim()
  return {
    image: normalizeBase64Image(partialImage, mime),
    callId,
    partial: true,
    partialIndex: readPartialImageIndex(event.partial_image_index),
  }
}

function upsertImageOutput(images: ResponsesImageOutput[], nextImage: ResponsesImageOutput): ResponsesImageOutput[] {
  const next = [...images]
  const existingIndex = next.findIndex((image) => {
    if (nextImage.partial || image.partial) {
      if (nextImage.partialIndex != null && image.partialIndex === nextImage.partialIndex) return true
      return image.image === nextImage.image
    }
    if (nextImage.callId && image.callId === nextImage.callId) return true
    return image.image === nextImage.image
  })

  if (existingIndex >= 0) {
    next[existingIndex] = {
      ...next[existingIndex],
      ...nextImage,
    }
    return next
  }

  next.push(nextImage)
  return next
}

function createResponsesStreamCollector(
  mime: string,
  transport: ResponsesActualTransport,
  onProgress?: (event: ResponsesImageApiProgressEvent) => void,
) {
  let responseId = ''
  let textBuffer = ''
  let partialImages: ResponsesImageOutput[] = []
  const images: ResponsesImageOutput[] = []
  const texts: ResponsesApiTextOutput[] = []
  const outputState: ResponsesOutputParseState = {}

  const publish = (event: Omit<ResponsesImageApiProgressEvent, 'transport'>) => {
    onProgress?.({ transport, responseId: (event.responseId ?? responseId) || undefined, ...event })
  }

  const finish = (payload?: ResponsesApiResponse): CallResponsesImageApiResult => {
    const parsed = payload ? parseResponsesOutput(payload, mime, transport) : undefined
    const finalImages = parsed?.images.length ? parsed.images : images
    const finalTexts = parsed?.texts.length ? parsed.texts : texts
    const bufferedText = textBuffer.trim()

    if (!finalTexts.length && bufferedText) {
      finalTexts.push({ text: bufferedText })
    }

    if (!finalImages.length && !partialImages.length && !finalTexts.length) {
      throw new Error('Responses HTTP 流式请求未返回可显示内容')
    }

    const result = {
      responseId: parsed?.responseId || responseId || undefined,
      images: finalImages.map((image) => ({ ...image, partial: false })),
      partialImages,
      texts: finalTexts,
      transport,
    }
    publish({ phase: 'completed', responseId: result.responseId })
    return result
  }

  const handleEvent = (event: ResponsesStreamEvent): CallResponsesImageApiResult | null => {
    const eventResponseId = event.response?.id || event.id
    if (eventResponseId) responseId = eventResponseId

    switch (event.type) {
      case 'response.created':
        publish({ phase: 'created' })
        return null
      case 'response.in_progress':
        publish({ phase: 'in_progress' })
        return null
      case 'response.output_text.delta':
        if (event.delta) {
          textBuffer += event.delta
          publish({ phase: 'text', text: textBuffer })
        }
        return null
      case 'response.output_text.done':
        if (event.text) {
          texts.push({ text: event.text })
          textBuffer = ''
          publish({ phase: 'text', text: event.text })
        }
        return null
      case 'response.image_generation_call.partial_image':
      case 'image_generation.partial_image':
      case 'image_edit.partial_image': {
        const image = getPartialImageOutput(event, mime)
        if (image) {
          partialImages = upsertImageOutput(partialImages, image)
          publish({ phase: 'partial_image', images: partialImages })
        }
        return null
      }
      case 'response.output_item.done':
        if (event.item) {
          collectResponsesOutputItem(event.item, mime, images, texts, outputState)
          publish({ phase: 'output_item' })
        }
        return null
      case 'response.completed':
      case 'response.done':
        return finish(event.response)
      case 'response.failed':
      case 'response.incomplete':
      case 'error':
        throw new Error(readResponsesStreamError(event))
      default:
        if (event.item) {
          collectResponsesOutputItem(event.item, mime, images, texts, outputState)
          publish({ phase: 'output_item' })
        }
        return null
    }
  }

  return {
    handleEvent,
    finish,
  }
}

function parseSseBlock(block: string): ResponsesStreamEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()

  if (!data || data === '[DONE]') return null
  return JSON.parse(data) as ResponsesStreamEvent
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const { settings, prompt, params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const imageCount = normalizeImageCount(params.n)
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = {
    Authorization: `Bearer ${settings.apiKey}`,
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)

  try {
    const images: string[] = []

    for (let index = 0; index < imageCount; index++) {
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

      images.push(...await readImageApiImages(response, mime, controller.signal))
    }

    if (!images.length) {
      throw new Error('接口未返回可用图片数据')
    }

    return { images: images.slice(0, imageCount) }
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
    const result = parseResponsesOutput(payload, mime, 'http_json')

    if (!result.images.length && !result.texts.length) {
      throw new Error('Responses API 未返回可显示内容')
    }

    return result
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function callResponsesImageApiStream(
  opts: CallResponsesImageApiOptions,
): Promise<CallResponsesImageApiResult> {
  const { settings, onProgress } = opts
  const proxyConfig = readClientDevProxyConfig()
  const { body, mime } = buildResponsesImagePayload(opts, true)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout * 1000)
  const collector = createResponsesStreamCollector(mime, 'http_stream', onProgress)

  onProgress?.({ transport: 'http_stream', phase: 'connecting', message: '正在建立 HTTP 流式连接' })

  try {
    const response = await fetch(buildApiUrl(settings.baseUrl, 'responses', proxyConfig), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const payload = await response.json() as ResponsesApiResponse
      const result = parseResponsesOutput(payload, mime, 'http_json')
      if (!result.images.length && !result.texts.length) {
        throw new Error('Responses API 未返回可显示内容')
      }
      onProgress?.({
        transport: 'http_json',
        phase: 'fallback',
        responseId: result.responseId,
        message: '上游返回 JSON，已按 HTTP JSON 解析',
      })
      return result
    }

    if (!response.body) {
      throw new Error('Responses HTTP 流式响应不可读取，请改用 HTTP JSON 或检查代理是否缓冲了 SSE')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let separator = buffer.match(/\r?\n\r?\n/)
      while (separator?.index != null) {
        const block = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const event = parseSseBlock(block)
        if (event) {
          const result = collector.handleEvent(event)
          if (result) return result
        }
        separator = buffer.match(/\r?\n\r?\n/)
      }
    }

    buffer += decoder.decode()
    const trailing = buffer.trim()
    if (trailing) {
      const event = parseSseBlock(trailing)
      if (event) {
        const result = collector.handleEvent(event)
        if (result) return result
      }
    }

    return collector.finish()
  } finally {
    clearTimeout(timeoutId)
  }
}
