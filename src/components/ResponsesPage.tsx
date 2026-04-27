import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ResponsesContextItemRef,
  ResponsesContextMode,
  ResponsesImageToolOptions,
  ResponsesReasoningEffort,
  StoredResponseChatMessage,
  StoredResponseConversation,
  StoredResponseReferenceImage,
  TaskRecord,
} from '../types'
import { DEFAULT_PARAMS } from '../types'
import { callResponsesImageApi, callResponsesImageApiWebSocket } from '../lib/api'
import type { CallResponsesImageApiResult } from '../lib/api'
import {
  deleteResponseConversation,
  getAllResponseConversations,
  putTask,
  putResponseConversation,
  storeImage,
} from '../lib/db'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { normalizeImageSize } from '../lib/size'
import { useStore } from '../store'
import Select from './Select'
import SizePickerModal from './SizePickerModal'

const MAX_REFERENCE_IMAGES = 8

const DEFAULT_TOOL_OPTIONS: ResponsesImageToolOptions = {
  action: 'auto',
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
}

const ACTION_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '生成', value: 'generate' },
  { label: '编辑', value: 'edit' },
]

const QUALITY_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
]

const FORMAT_OPTIONS = [
  { label: 'PNG', value: 'png' },
  { label: 'JPEG', value: 'jpeg' },
  { label: 'WebP', value: 'webp' },
]

const MODERATION_OPTIONS = [
  { label: '标准 auto', value: 'auto' },
  { label: '低限制 low', value: 'low' },
]

const REASONING_OPTIONS = [
  { label: '默认', value: 'default' },
  { label: 'none', value: 'none' },
  { label: 'minimal', value: 'minimal' },
  { label: 'low', value: 'low' },
  { label: 'medium', value: 'medium' },
  { label: 'high', value: 'high' },
  { label: 'xhigh', value: 'xhigh' },
]

const CONTEXT_MODE_OPTIONS = [
  { label: '不发送上下文', value: 'off' },
  { label: '自动混合', value: 'auto' },
  { label: '图片上下文接续', value: 'image_generation_call' },
  { label: '响应 ID 接续', value: 'previous_response_id' },
]

interface ResponsesErrorDisplay {
  summary: string
  detail?: string
  requestId?: string
}

interface PersistConversationOptions {
  activate?: boolean
}

function isContinuationUnavailableError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('upstream continuation connection is unavailable')
    || normalized.includes('please restart the conversation')
  )
}

function isWebSocketAbnormalCloseError(message: string): boolean {
  return message.includes('1006') || message.toLowerCase().includes('websocket 异常断开')
}

function extractOpenAIRequestId(message: string): string {
  return message.match(/request id\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? ''
}

function getResponsesErrorDisplay(message: string): ResponsesErrorDisplay {
  const requestId = extractOpenAIRequestId(message)
  const normalized = message.toLowerCase()
  const isGenericOpenAIError = normalized.includes('an error occurred while processing your request')
    && normalized.includes('help.openai.com')

  if (isGenericOpenAIError && requestId) {
    return {
      summary: '上游 OpenAI 返回通用失败，请用 request ID 在 sub2api 日志中定位具体原因。',
      detail: message,
      requestId,
    }
  }

  return { summary: message, requestId }
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function formatElapsed(ms: number | null | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatConversationTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function createReferenceImage(dataUrl: string, name: string): StoredResponseReferenceImage {
  return {
    id: genId(),
    name,
    dataUrl,
  }
}

function deriveConversationTitle(messages: StoredResponseChatMessage[], fallback?: string): string {
  const text = messages.find((message) => message.role === 'user' && message.text.trim())?.text.trim()
    || fallback?.trim()
    || messages.find((message) => message.images.length > 0)?.images[0]?.name
    || '未命名对话'

  return text.length > 28 ? `${text.slice(0, 28)}...` : text
}

const REFRESH_INTERRUPTED_ERROR = '请求在页面刷新时停止，请重新发送这一轮'

function hasRecoverableAssistantContent(message: StoredResponseChatMessage): boolean {
  return (
    (message.outputs?.length ?? 0) > 0
    || (message.texts?.length ?? 0) > 0
    || (message.revisedPrompts?.length ?? 0) > 0
    || Boolean(message.responseId)
  )
}

function normalizeLoadedMessages(messages: StoredResponseChatMessage[]): StoredResponseChatMessage[] {
  let changed = false
  const normalized: StoredResponseChatMessage[] = []

  for (const message of messages) {
    if (message.status !== 'running') {
      normalized.push(message)
      continue
    }

    changed = true
    if (
      message.role === 'assistant'
      && !message.error
      && !hasRecoverableAssistantContent(message)
    ) {
      continue
    }

    normalized.push({
      ...message,
      status: 'error',
      error: message.error || REFRESH_INTERRUPTED_ERROR,
    })
  }

  return changed ? normalized : messages
}

function sortConversations(conversations: StoredResponseConversation[]): StoredResponseConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
}

function uniqueContextItemRefs(items: ResponsesContextItemRef[]): ResponsesContextItemRef[] {
  const refs: ResponsesContextItemRef[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const id = item.id.trim()
    if (!id) continue

    const key = `${item.type}:${id}`
    if (seen.has(key)) continue

    seen.add(key)
    if (item.type === 'reasoning') {
      refs.push({ ...item, id })
    } else {
      refs.push({ type: 'image_generation_call', id })
    }
  }

  return refs
}

function getImageGenerationCallIdsFromContextRefs(items: ResponsesContextItemRef[]): string[] {
  return items
    .filter((item) => item.type === 'image_generation_call')
    .map((item) => item.id)
}

function formatContextItemRef(item: ResponsesContextItemRef): string {
  return `${item.type === 'reasoning' ? 'reasoning' : 'image_generation_call'}: ${item.id}`
}

function getLatestImageContextItemRefs(messages: StoredResponseChatMessage[]): ResponsesContextItemRef[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const refs: ResponsesContextItemRef[] = []

    for (const item of messages[i].outputs) {
      const reasoning = item.reasoning
      const callId = item.callId?.trim()

      if (!reasoning?.id?.trim() || !callId) continue

      refs.push(
        reasoning,
        { type: 'image_generation_call', id: callId },
      )
    }

    if (refs.length) return uniqueContextItemRefs(refs)
  }

  return []
}

function buildContinuationFallbackPrompt(messages: StoredResponseChatMessage[], currentPrompt: string): string {
  const priorUserMessages = messages
    .filter((message) => message.role === 'user' && message.text.trim())
    .slice(-6)
    .map((message, index) => `${index + 1}. ${message.text.trim()}`)

  if (!priorUserMessages.length) return currentPrompt

  return [
    'Continue the same image-generation conversation.',
    'Use the prior user requests as context for the current request.',
    '',
    'Prior user requests:',
    ...priorUserMessages,
    '',
    `Current request: ${currentPrompt || 'continue from the prior request'}`,
  ].join('\n')
}

async function createImageApiTaskFromResponsesResult(
  prompt: string,
  inputImages: StoredResponseReferenceImage[],
  toolOptions: ResponsesImageToolOptions,
  outputImages: Array<{ image: string }>,
  startedAt: number,
): Promise<TaskRecord | null> {
  if (!outputImages.length) return null

  const inputImageIds: string[] = []
  for (const image of inputImages) {
    inputImageIds.push(await storeImage(image.dataUrl, 'upload'))
  }

  const outputImageIds: string[] = []
  for (const image of outputImages) {
    outputImageIds.push(await storeImage(image.image, 'generated'))
  }

  return {
    id: genId(),
    prompt,
    params: {
      ...DEFAULT_PARAMS,
      size: normalizeImageSize(toolOptions.size) || DEFAULT_PARAMS.size,
      quality: toolOptions.quality,
      output_format: toolOptions.output_format,
      output_compression: toolOptions.output_format === 'png'
        ? null
        : toolOptions.output_compression,
      moderation: toolOptions.moderation,
      n: Math.max(outputImageIds.length, 1),
    },
    inputImageIds,
    outputImages: outputImageIds,
    status: 'done',
    error: null,
    createdAt: startedAt,
    finishedAt: Date.now(),
    elapsed: Date.now() - startedAt,
  }
}

export default function ResponsesPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const activeConversationIdRef = useRef('')
  const conversationsRef = useRef<StoredResponseConversation[]>([])
  const settings = useStore((s) => s.settings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const showToast = useStore((s) => s.showToast)
  const setTasks = useStore((s) => s.setTasks)

  const [model, setModel] = useState('gpt-5.5')
  const [prompt, setPrompt] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ResponsesReasoningEffort>('default')
  const [toolOptions, setToolOptions] = useState<ResponsesImageToolOptions>(DEFAULT_TOOL_OPTIONS)
  const [referenceImages, setReferenceImages] = useState<StoredResponseReferenceImage[]>([])
  const [messages, setMessages] = useState<StoredResponseChatMessage[]>([])
  const [conversationResponseId, setConversationResponseId] = useState('')
  const [conversations, setConversations] = useState<StoredResponseConversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [contextMode, setContextMode] = useState<ResponsesContextMode>('auto')
  const [isRunning, setIsRunning] = useState(false)
  const [runningConversationId, setRunningConversationId] = useState('')
  const [showSizePicker, setShowSizePicker] = useState(false)

  const canUseCompression = toolOptions.output_format !== 'png'
  const compressionValue = toolOptions.output_compression ?? 80
  const currentSize = normalizeImageSize(toolOptions.size) || 'auto'
  const latestImageContextItemRefs = useMemo(() => getLatestImageContextItemRefs(messages), [messages])
  const hasLatestImageContext = latestImageContextItemRefs.length > 0
  const shouldSendImageContext = (
    contextMode === 'image_generation_call'
    || (contextMode === 'auto' && !conversationResponseId && hasLatestImageContext)
  )
  const shouldSendPreviousResponseId = (
    contextMode === 'previous_response_id'
    || (contextMode === 'auto' && Boolean(conversationResponseId))
  )
  const isActiveConversationRunning = isRunning && runningConversationId === activeConversationId

  const statusText = useMemo(() => {
    if (isActiveConversationRunning) return '请求中'
    if (isRunning) return '后台生成中'
    if (shouldSendPreviousResponseId && conversationResponseId) return '响应 ID 接续'
    if (shouldSendImageContext) return hasLatestImageContext ? '图片上下文接续' : '无可用图片上下文'
    if (conversationResponseId) return '未发送上下文'
    return 'WS v2 新对话'
  }, [
    conversationResponseId,
    hasLatestImageContext,
    isActiveConversationRunning,
    isRunning,
    shouldSendImageContext,
    shouldSendPreviousResponseId,
  ])
  const contextPreviewText = useMemo(() => {
    if (shouldSendPreviousResponseId) {
      return conversationResponseId || '下一条从新对话开始'
    }
    if (shouldSendImageContext) {
      return latestImageContextItemRefs.map(formatContextItemRef).join('\n')
        || '暂无 reasoning + image_generation_call 配对，下一条从新对话开始'
    }

    return '本次不发送'
  }, [
    conversationResponseId,
    latestImageContextItemRefs,
    shouldSendImageContext,
    shouldSendPreviousResponseId,
  ])

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  useEffect(() => {
    let active = true

    getAllResponseConversations()
      .then((items) => {
        if (!active) return

        const loaded = sortConversations(items.map((item) => {
          const messages = normalizeLoadedMessages(item.messages)
          if (messages === item.messages) return item

          const normalized = { ...item, messages }
          putResponseConversation(normalized).catch((err) => {
            showToast(`历史会话清理失败：${err instanceof Error ? err.message : String(err)}`, 'error')
          })
          return normalized
        }))
        conversationsRef.current = loaded
        setConversations(loaded)

        const latest = loaded[0]
        if (latest) {
          activeConversationIdRef.current = latest.id
          setActiveConversationId(latest.id)
          setMessages(latest.messages)
          setConversationResponseId(latest.responseId)
        }
      })
      .catch((err) => {
        showToast(`历史会话加载失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      })

    return () => {
      active = false
    }
  }, [showToast])

  const updateToolOptions = (patch: Partial<ResponsesImageToolOptions>) => {
    setToolOptions((current) => ({ ...current, ...patch }))
  }

  const scrollToBottom = () => {
    window.setTimeout(() => {
      messageListRef.current?.scrollTo({
        top: messageListRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }, 0)
  }

  const persistConversation = (
    conversationId: string,
    nextMessages: StoredResponseChatMessage[],
    responseId: string,
    titleSeed?: string,
    options: PersistConversationOptions = {},
  ) => {
    const activate = options.activate ?? true
    const now = Date.now()
    const currentConversations = conversationsRef.current
    const existing = currentConversations.find((item) => item.id === conversationId)
    const record: StoredResponseConversation = {
      id: conversationId,
      title: existing?.title || deriveConversationTitle(nextMessages, titleSeed),
      messages: nextMessages,
      responseId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const nextConversations = sortConversations([
      record,
      ...currentConversations.filter((item) => item.id !== conversationId),
    ])

    conversationsRef.current = nextConversations
    setConversations(nextConversations)

    if (activate || activeConversationIdRef.current === conversationId) {
      activeConversationIdRef.current = conversationId
      setActiveConversationId(conversationId)
      setMessages(nextMessages)
      setConversationResponseId(responseId)
    }

    putResponseConversation(record).catch((err) => {
      showToast(`历史会话保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    })
  }

  const addReferenceImages = async (files: File[] | FileList, source: 'upload' | 'paste') => {
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (!images.length) return

    const remaining = MAX_REFERENCE_IMAGES - referenceImages.length
    if (remaining <= 0) {
      showToast(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`, 'error')
      return
    }

    const accepted = images.slice(0, remaining)
    const added: StoredResponseReferenceImage[] = []
    for (const file of accepted) {
      const dataUrl = await fileToDataUrl(file)
      added.push(createReferenceImage(dataUrl, file.name || `${source}-image.png`))
    }

    setReferenceImages((current) => [...current, ...added])
    showToast(source === 'paste' ? `已粘贴 ${added.length} 张参考图` : `已添加 ${added.length} 张参考图`, 'success')

    if (accepted.length < images.length) {
      showToast(`已达上限，${images.length - accepted.length} 张图片未添加`, 'error')
    }
  }

  const handlePaste = async (event: React.ClipboardEvent) => {
    if (event.defaultPrevented) return

    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (!imageFiles.length) return

    event.preventDefault()
    await addReferenceImages(imageFiles, 'paste')
  }

  const handleCopyResponseError = async (text: string, successMessage: string) => {
    try {
      await copyTextToClipboard(text)
      showToast(successMessage, 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制失败', err), 'error')
    }
  }

  const handleSubmit = async () => {
    const trimmedPrompt = prompt.trim()
    const trimmedModel = model.trim()
    const inputImages = referenceImages

    if (!settings.apiKey) {
      showToast('请先在设置中配置 API Key', 'error')
      setShowSettings(true)
      return
    }

    if (!trimmedModel) {
      showToast('请输入 Responses API 模型', 'error')
      return
    }

    if (!trimmedPrompt && !inputImages.length) {
      showToast('请输入提示词或粘贴参考图', 'error')
      return
    }

    const fallbackImageContextItemRefs = getLatestImageContextItemRefs(messages)
    const contextItemRefs = shouldSendImageContext ? fallbackImageContextItemRefs : []
    const imageGenerationCallIds = getImageGenerationCallIdsFromContextRefs(contextItemRefs)
    const previousResponseId = shouldSendPreviousResponseId ? conversationResponseId : ''

    if (
      toolOptions.action === 'edit'
      && !inputImages.length
      && !previousResponseId
      && !contextItemRefs.length
    ) {
      showToast('编辑模式需要参考图或已有对话上下文', 'error')
      return
    }

    const startedAt = Date.now()
    const conversationId = activeConversationId || genId()
    const userMessage: StoredResponseChatMessage = {
      id: genId(),
      role: 'user',
      text: trimmedPrompt,
      images: inputImages,
      outputs: [],
      texts: [],
      revisedPrompts: [],
      previousResponseId,
      contextItemRefs,
      imageGenerationCallIds,
      createdAt: startedAt,
    }
    const assistantId = genId()
    const assistantMessage: StoredResponseChatMessage = {
      id: assistantId,
      role: 'assistant',
      text: '',
      images: [],
      outputs: [],
      texts: [],
      revisedPrompts: [],
      previousResponseId,
      contextItemRefs,
      imageGenerationCallIds,
      status: 'running',
      createdAt: startedAt,
    }

    const nextMessages = [...messages, userMessage, assistantMessage]
    setMessages(nextMessages)
    setPrompt('')
    setReferenceImages([])
    setIsRunning(true)
    setRunningConversationId(conversationId)
    persistConversation(conversationId, nextMessages, previousResponseId, trimmedPrompt)
    scrollToBottom()

    try {
      let usedPreviousResponseId = previousResponseId
      let usedContextItemRefs = contextItemRefs
      let usedImageGenerationCallIds = imageGenerationCallIds
      let retriedWithTranscriptContext = false
      let retriedWithImageContext = false
      let retriedWithHttp = false
      let result: CallResponsesImageApiResult

      try {
        result = await callResponsesImageApiWebSocket({
          settings,
          model: trimmedModel,
          prompt: trimmedPrompt,
          previousResponseId,
          contextItemRefs,
          reasoningEffort,
          toolOptions,
          inputImageDataUrls: inputImages.map((image) => image.dataUrl),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const canRetryWithoutContext = toolOptions.action !== 'edit' || inputImages.length > 0
        if (isWebSocketAbnormalCloseError(message)) {
          retriedWithHttp = true
          result = await callResponsesImageApi({
            settings,
            model: trimmedModel,
            prompt: trimmedPrompt,
            previousResponseId,
            contextItemRefs,
            reasoningEffort,
            toolOptions,
            inputImageDataUrls: inputImages.map((image) => image.dataUrl),
          })
        } else if (!previousResponseId || !isContinuationUnavailableError(message)) {
          throw err
        } else if (fallbackImageContextItemRefs.length) {
          const fallbackPrompt = buildContinuationFallbackPrompt(messages, trimmedPrompt)
          usedPreviousResponseId = ''
          usedContextItemRefs = fallbackImageContextItemRefs
          usedImageGenerationCallIds = getImageGenerationCallIdsFromContextRefs(fallbackImageContextItemRefs)
          retriedWithImageContext = true
          result = await callResponsesImageApiWebSocket({
            settings,
            model: trimmedModel,
            prompt: fallbackPrompt,
            previousResponseId: '',
            contextItemRefs: fallbackImageContextItemRefs,
            reasoningEffort,
            toolOptions,
            inputImageDataUrls: inputImages.map((image) => image.dataUrl),
          })
        } else if (!canRetryWithoutContext) {
          throw err
        } else {
          const fallbackPrompt = buildContinuationFallbackPrompt(messages, trimmedPrompt)
          usedPreviousResponseId = ''
          usedContextItemRefs = []
          usedImageGenerationCallIds = []
          retriedWithTranscriptContext = fallbackPrompt !== trimmedPrompt
          result = await callResponsesImageApiWebSocket({
            settings,
            model: trimmedModel,
            prompt: fallbackPrompt,
            previousResponseId: '',
            contextItemRefs: [],
            reasoningEffort,
            toolOptions,
            inputImageDataUrls: inputImages.map((image) => image.dataUrl),
          })
        }
      }

      const nextResponseId = result.responseId ?? ''
      const revisedPrompts = result.images
        .map((item) => item.revisedPrompt)
        .filter((value): value is string => Boolean(value))
      const completedMessages = nextMessages.map((message) => (
        message.id === assistantId
          ? {
              ...message,
              previousResponseId: usedPreviousResponseId,
              contextItemRefs: usedContextItemRefs,
              imageGenerationCallIds: usedImageGenerationCallIds,
              outputs: result.images,
              texts: result.texts,
              revisedPrompts,
              responseId: nextResponseId,
              status: 'done' as const,
              elapsed: Date.now() - startedAt,
            }
          : message.id === userMessage.id
            ? {
                ...message,
                previousResponseId: usedPreviousResponseId,
                contextItemRefs: usedContextItemRefs,
                imageGenerationCallIds: usedImageGenerationCallIds,
              }
          : message
      ))

      persistConversation(conversationId, completedMessages, nextResponseId, trimmedPrompt, { activate: false })

      let syncedToImageApi = false
      let imageApiSyncFailed = false
      if (result.images.length > 0) {
        try {
          const imageApiTask = await createImageApiTaskFromResponsesResult(
            trimmedPrompt,
            inputImages,
            toolOptions,
            result.images,
            startedAt,
          )
          if (!imageApiTask) throw new Error('没有可同步的图片')
          await putTask(imageApiTask)
          const currentTasks = useStore.getState().tasks
          setTasks([imageApiTask, ...currentTasks.filter((item) => item.id !== imageApiTask.id)])
          syncedToImageApi = true
        } catch (err) {
          imageApiSyncFailed = true
          console.error('Sync Responses result to Image API failed', err)
        }
      }

      showToast(
        result.images.length > 0
          ? `Responses API 返回 ${result.images.length} 张图片${syncedToImageApi ? '，已同步到 Image API' : imageApiSyncFailed ? '，同步到 Image API 失败' : ''}`
          : retriedWithHttp
            ? 'WebSocket 断开，已用 HTTP Responses 重试完成'
          : retriedWithImageContext
            ? '响应 ID 接续失败，已用图片上下文接续完成'
          : retriedWithTranscriptContext
            ? '响应 ID 接续失败，已用本地对话转述完成'
          : 'Responses API 返回文本内容',
        imageApiSyncFailed ? 'error' : 'success',
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failedMessages = nextMessages.map((item) => (
        item.id === assistantId
          ? {
              ...item,
              status: 'error' as const,
              error: message,
              elapsed: Date.now() - startedAt,
            }
          : item
      ))
      persistConversation(conversationId, failedMessages, previousResponseId, trimmedPrompt, { activate: false })
      showToast(`生成失败：${getResponsesErrorDisplay(message).summary}`, 'error')
    } finally {
      setIsRunning(false)
      setRunningConversationId('')
      scrollToBottom()
    }
  }

  const handleNewConversation = () => {
    activeConversationIdRef.current = ''
    setActiveConversationId('')
    setMessages([])
    setConversationResponseId('')
    setPrompt('')
    setReferenceImages([])
  }

  const handleSelectConversation = (conversation: StoredResponseConversation) => {
    activeConversationIdRef.current = conversation.id
    setActiveConversationId(conversation.id)
    setMessages(conversation.messages)
    setConversationResponseId(conversation.responseId)
    setPrompt('')
    setReferenceImages([])
    scrollToBottom()
  }

  const handleDeleteConversation = (event: React.MouseEvent, conversationId: string) => {
    event.stopPropagation()
    if (conversationId === runningConversationId) {
      showToast('这条会话正在生成，完成后再删除', 'error')
      return
    }

    const remaining = conversations.filter((item) => item.id !== conversationId)
    conversationsRef.current = remaining
    setConversations(remaining)
    deleteResponseConversation(conversationId).catch((err) => {
      showToast(`历史会话删除失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    })

    if (conversationId !== activeConversationId) return

    const next = remaining[0]
    if (next) {
      activeConversationIdRef.current = next.id
      setActiveConversationId(next.id)
      setMessages(next.messages)
      setConversationResponseId(next.responseId)
    } else {
      handleNewConversation()
    }
  }

  return (
    <>
      {showSizePicker && (
        <SizePickerModal
          currentSize={toolOptions.size}
          onSelect={(size) => updateToolOptions({ size })}
          onClose={() => setShowSizePicker(false)}
        />
      )}

      <div className="grid h-[calc(100vh-56px)] min-h-[680px] gap-4 py-4 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
        <aside className="flex min-h-[150px] max-h-56 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-gray-900 lg:max-h-none">
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-3 dark:border-white/[0.08]">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">历史会话</h3>
            <button
              type="button"
              onClick={handleNewConversation}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              新建
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {conversations.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-gray-400 dark:text-gray-500">
                暂无会话
              </div>
            ) : (
              <div className="space-y-1">
                {conversations.map((conversation) => {
                  const isConversationRunning = conversation.id === runningConversationId

                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => handleSelectConversation(conversation)}
                      className={`group w-full rounded-lg border px-2 py-2 text-left transition-colors ${
                        activeConversationId === conversation.id
                          ? 'border-blue-200 bg-blue-50 dark:border-blue-500/30 dark:bg-blue-500/10'
                          : 'border-transparent hover:bg-gray-50 dark:hover:bg-white/[0.06]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                            {conversation.title}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                            <span>{formatConversationTime(conversation.updatedAt)}</span>
                            {isConversationRunning && (
                              <span className="font-medium text-blue-600 dark:text-blue-300">生成中</span>
                            )}
                          </div>
                        </div>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(event) => handleDeleteConversation(event, conversation.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              handleDeleteConversation(event as unknown as React.MouseEvent, conversation.id)
                            }
                          }}
                          className="rounded px-1 text-xs text-gray-400 opacity-0 transition-colors hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-500/10"
                          title={isConversationRunning ? '生成中，暂不能删除' : '删除会话'}
                        >
                          删除
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-gray-900">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Responses 对话生图
              </h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                使用 sub2api Responses WebSocket v2，自动选择图片上下文或响应 ID 接续。
              </p>
            </div>
            <span className="hidden rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 dark:border-white/[0.08] dark:text-gray-400 sm:inline">
              {statusText}
            </span>
          </div>

          <div
            ref={messageListRef}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
            onPaste={handlePaste}
          >
            {!messages.length && (
              <div className="flex h-full min-h-[320px] items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-400 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-500">
                输入提示词，或直接粘贴一张参考图
              </div>
            )}

            <div className="space-y-4">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[88%] rounded-lg border px-3 py-2 ${
                      message.role === 'user'
                        ? 'border-blue-200 bg-blue-50 text-gray-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-gray-100'
                        : 'border-gray-200 bg-white text-gray-900 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100'
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
                      <span>{message.role === 'user' ? '你' : 'Responses'}</span>
                      {message.status === 'running' && <span>生成中...</span>}
                      {message.elapsed != null && <span>{formatElapsed(message.elapsed)}</span>}
                    </div>

                    {message.text && (
                      <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
                    )}

                    {message.images.length > 0 && (
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        {message.images.map((image) => (
                          <img
                            key={image.id}
                            src={image.dataUrl}
                            alt={image.name}
                            className="aspect-square rounded-lg border border-gray-200 object-cover dark:border-white/[0.08]"
                          />
                        ))}
                      </div>
                    )}

                    {message.texts.map((item, index) => (
                      <p key={`${message.id}-text-${index}`} className="mt-2 whitespace-pre-wrap text-sm leading-6">
                        {item.text}
                      </p>
                    ))}

                    {message.outputs.length > 0 && (
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        {message.outputs.map((item, index) => (
                          <figure key={`${item.callId ?? 'image'}-${index}`} className="overflow-hidden rounded-lg border border-gray-200 bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900">
                            <img src={item.image} alt={`生成结果 ${index + 1}`} className="aspect-square w-full object-contain" />
                            <figcaption className="flex items-center justify-between border-t border-gray-200 px-2 py-1.5 text-xs text-gray-500 dark:border-white/[0.08] dark:text-gray-400">
                              <span>图片 {index + 1}</span>
                              <a
                                href={item.image}
                                download={`responses-image-${index + 1}.${toolOptions.output_format}`}
                                className="font-medium text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                              >
                                下载
                              </a>
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    )}

                    {message.revisedPrompts.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                          revised_prompt
                        </summary>
                        <div className="mt-2 space-y-2">
                          {message.revisedPrompts.map((item, index) => (
                            <pre key={`${message.id}-revised-${index}`} className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs leading-5 text-gray-700 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300">
                              {item}
                            </pre>
                          ))}
                        </div>
                      </details>
                    )}

                    {message.error && (() => {
                      const error = getResponsesErrorDisplay(message.error)

                      return (
                        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 leading-6">{error.summary}</p>
                            <button
                              type="button"
                              onClick={() => handleCopyResponseError(message.error || '', '完整报错已复制')}
                              className="inline-flex h-7 w-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:bg-white/[0.04] dark:text-red-300 dark:hover:bg-red-500/10"
                              aria-label="复制完整报错"
                              title="复制完整报错"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                              </svg>
                            </button>
                          </div>

                          {error.requestId && (
                            <div className="mt-2 flex items-center gap-2 rounded-lg border border-red-200/70 bg-white/70 px-2 py-1 text-xs dark:border-red-500/20 dark:bg-white/[0.03]">
                              <span className="flex-shrink-0 text-red-500 dark:text-red-300">request ID</span>
                              <span className="min-w-0 flex-1 break-all font-mono text-red-700 dark:text-red-200">
                                {error.requestId}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleCopyResponseError(error.requestId || '', 'request ID 已复制')}
                                className="inline-flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:bg-white/[0.04] dark:text-red-300 dark:hover:bg-red-500/10"
                                aria-label="复制 request ID"
                                title="复制 request ID"
                              >
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                                </svg>
                              </button>
                            </div>
                          )}

                          {error.detail && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs text-red-600 transition-colors hover:text-red-700 dark:text-red-300 dark:hover:text-red-200">
                                原始错误
                              </summary>
                              <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-red-600 dark:text-red-300">
                                {error.detail}
                              </p>
                            </details>
                          )}
                        </div>
                      )
                    })()}

                    {message.responseId && (
                      <div className="mt-2 truncate font-mono text-[11px] text-gray-400 dark:text-gray-500">
                        {message.responseId}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="border-t border-gray-200 p-3 dark:border-white/[0.08]" onPaste={handlePaste}>
            {referenceImages.length > 0 && (
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                {referenceImages.map((image) => (
                  <div key={image.id} className="group relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-white/[0.08] dark:bg-gray-950">
                    <img src={image.dataUrl} alt={image.name} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => setReferenceImages((current) => current.filter((item) => item.id !== image.id))}
                      className="absolute right-1 top-1 rounded bg-black/60 px-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mb-0.5 inline-flex h-10 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg border border-gray-200 text-gray-600 transition-colors hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]"
                title="添加参考图"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 4v12m0-12l-4 4m4-4l4 4" />
                </svg>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) addReferenceImages(event.target.files, 'upload')
                  event.currentTarget.value = ''
                }}
              />
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={handlePaste}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    if (!isRunning) handleSubmit()
                  }
                }}
                rows={2}
                className="max-h-40 min-h-10 flex-1 resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-gray-900 transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100"
                placeholder="输入下一轮要求，或 Ctrl+V 粘贴参考图..."
              />
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isRunning}
                className="mb-0.5 inline-flex h-10 cursor-pointer items-center justify-center rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400 dark:bg-blue-500 dark:hover:bg-blue-400 dark:disabled:bg-blue-500/50"
              >
                {isActiveConversationRunning ? '发送中' : isRunning ? '后台生成中' : '发送'}
              </button>
            </div>
          </div>
        </section>

        <aside className="grid gap-4 overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-gray-900">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">请求参数</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              自动混合优先使用响应 ID，响应接续不可用时回退到图片上下文。
            </p>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">模型</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-mono text-sm text-gray-900 transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100"
              placeholder="gpt-5.5"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">思考强度</span>
            <Select
              value={reasoningEffort}
              onChange={(value) => setReasoningEffort(value)}
              options={REASONING_OPTIONS}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-white/[0.06]"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">上下文</span>
            <Select
              value={contextMode}
              onChange={(value) => setContextMode(value as ResponsesContextMode)}
              options={CONTEXT_MODE_OPTIONS}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-white/[0.06]"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">动作</span>
              <Select
                value={toolOptions.action}
                onChange={(value) => updateToolOptions({ action: value })}
                options={ACTION_OPTIONS}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-white/[0.06]"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">尺寸</span>
              <button
                type="button"
                onClick={() => setShowSizePicker(true)}
                className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left font-mono text-sm text-gray-900 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-white/[0.06]"
                title="使用与 Image API 页面相同的尺寸选择器"
              >
                <span className="truncate">{currentSize}</span>
                <svg className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">质量</span>
              <Select
                value={toolOptions.quality}
                onChange={(value) => updateToolOptions({ quality: value })}
                options={QUALITY_OPTIONS}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-white/[0.06]"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">格式</span>
              <Select
                value={toolOptions.output_format}
                onChange={(value) => updateToolOptions({ output_format: value })}
                options={FORMAT_OPTIONS}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-white/[0.06]"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">审核强度</span>
              <Select
                value={toolOptions.moderation}
                onChange={(value) => updateToolOptions({ moderation: value })}
                options={MODERATION_OPTIONS}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100 dark:hover:bg-white/[0.06]"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">压缩</span>
              <input
                type="number"
                min={0}
                max={100}
                disabled={!canUseCompression}
                value={canUseCompression ? compressionValue : ''}
                onChange={(event) => updateToolOptions({ output_compression: Number(event.target.value) })}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-100 dark:disabled:bg-white/[0.03]"
                placeholder="PNG 不使用"
              />
            </label>
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-white/[0.08] dark:bg-gray-950">
            <div className="text-xs font-medium text-gray-600 dark:text-gray-300">当前上下文</div>
            <div className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-gray-500 dark:text-gray-400">
              {contextPreviewText}
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}
