import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ResponsesImageToolOptions,
  ResponsesReasoningEffort,
  StoredResponseChatMessage,
  StoredResponseConversation,
  StoredResponseReferenceImage,
} from '../types'
import { callResponsesImageApi } from '../lib/api'
import {
  deleteResponseConversation,
  getAllResponseConversations,
  putResponseConversation,
} from '../lib/db'
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
  { label: '兼容模式', value: 'off' },
  { label: '接续 response.id', value: 'previous_response_id' },
]

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

function normalizeLoadedMessages(messages: StoredResponseChatMessage[]): StoredResponseChatMessage[] {
  return messages.map((message) => (
    message.status === 'running'
      ? {
          ...message,
          status: 'error',
          error: message.error || '页面刷新后请求已中断',
        }
      : message
  ))
}

function sortConversations(conversations: StoredResponseConversation[]): StoredResponseConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
}

function isPreviousResponseUnsupported(message: string): boolean {
  return /previous_response_id/i.test(message) && /WebSocket v2/i.test(message)
}

export default function ResponsesPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const settings = useStore((s) => s.settings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const showToast = useStore((s) => s.showToast)

  const [model, setModel] = useState('gpt-5.5')
  const [prompt, setPrompt] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ResponsesReasoningEffort>('default')
  const [toolOptions, setToolOptions] = useState<ResponsesImageToolOptions>(DEFAULT_TOOL_OPTIONS)
  const [referenceImages, setReferenceImages] = useState<StoredResponseReferenceImage[]>([])
  const [messages, setMessages] = useState<StoredResponseChatMessage[]>([])
  const [conversationResponseId, setConversationResponseId] = useState('')
  const [conversations, setConversations] = useState<StoredResponseConversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [contextMode, setContextMode] = useState<'off' | 'previous_response_id'>('off')
  const [isRunning, setIsRunning] = useState(false)
  const [showSizePicker, setShowSizePicker] = useState(false)

  const canUseCompression = toolOptions.output_format !== 'png'
  const compressionValue = toolOptions.output_compression ?? 80
  const currentSize = normalizeImageSize(toolOptions.size) || 'auto'
  const shouldSendPreviousResponseId = contextMode === 'previous_response_id'

  const statusText = useMemo(() => {
    if (isRunning) return '请求中'
    if (shouldSendPreviousResponseId && conversationResponseId) return '已接续'
    if (conversationResponseId) return '兼容模式'
    return '新对话'
  }, [conversationResponseId, isRunning, shouldSendPreviousResponseId])

  useEffect(() => {
    let active = true

    getAllResponseConversations()
      .then((items) => {
        if (!active) return

        const loaded = sortConversations(items.map((item) => ({
          ...item,
          messages: normalizeLoadedMessages(item.messages),
        })))
        setConversations(loaded)

        const latest = loaded[0]
        if (latest) {
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
  ) => {
    const now = Date.now()
    const existing = conversations.find((item) => item.id === conversationId)
    const record: StoredResponseConversation = {
      id: conversationId,
      title: existing?.title || deriveConversationTitle(nextMessages, titleSeed),
      messages: nextMessages,
      responseId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    setActiveConversationId(conversationId)
    setConversations((current) => sortConversations([
      record,
      ...current.filter((item) => item.id !== conversationId),
    ]))

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

    const previousResponseId = shouldSendPreviousResponseId ? conversationResponseId : ''

    if (toolOptions.action === 'edit' && !inputImages.length && !previousResponseId) {
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
      status: 'running',
      createdAt: startedAt,
    }

    const nextMessages = [...messages, userMessage, assistantMessage]
    setMessages(nextMessages)
    setPrompt('')
    setReferenceImages([])
    setIsRunning(true)
    persistConversation(conversationId, nextMessages, previousResponseId, trimmedPrompt)
    scrollToBottom()

    try {
      const result = await callResponsesImageApi({
        settings,
        model: trimmedModel,
        prompt: trimmedPrompt,
        previousResponseId,
        reasoningEffort,
        toolOptions,
        inputImageDataUrls: inputImages.map((image) => image.dataUrl),
      })

      const nextResponseId = result.responseId ?? ''
      const revisedPrompts = result.images
        .map((item) => item.revisedPrompt)
        .filter((value): value is string => Boolean(value))
      const completedMessages = nextMessages.map((message) => (
        message.id === assistantId
          ? {
              ...message,
              outputs: result.images,
              texts: result.texts,
              revisedPrompts,
              responseId: nextResponseId,
              status: 'done' as const,
              elapsed: Date.now() - startedAt,
            }
          : message
      ))

      setMessages(completedMessages)
      if (nextResponseId) setConversationResponseId(nextResponseId)
      persistConversation(conversationId, completedMessages, nextResponseId, trimmedPrompt)
      showToast(
        result.images.length > 0
          ? `Responses API 返回 ${result.images.length} 张图片`
          : 'Responses API 返回文本内容',
        'success',
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isPreviousResponseUnsupported(message)) {
        setContextMode('off')
        showToast('当前后端不支持 previous_response_id，已切换到兼容模式', 'error')
      }
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
      setMessages(failedMessages)
      persistConversation(conversationId, failedMessages, previousResponseId, trimmedPrompt)
      showToast(`生成失败：${message}`, 'error')
    } finally {
      setIsRunning(false)
      scrollToBottom()
    }
  }

  const handleNewConversation = () => {
    if (isRunning) return
    setActiveConversationId('')
    setMessages([])
    setConversationResponseId('')
    setPrompt('')
    setReferenceImages([])
  }

  const handleSelectConversation = (conversation: StoredResponseConversation) => {
    if (isRunning) {
      showToast('当前请求完成后再切换会话', 'error')
      return
    }
    setActiveConversationId(conversation.id)
    setMessages(conversation.messages)
    setConversationResponseId(conversation.responseId)
    setPrompt('')
    setReferenceImages([])
    scrollToBottom()
  }

  const handleDeleteConversation = (event: React.MouseEvent, conversationId: string) => {
    event.stopPropagation()
    if (isRunning) return

    const remaining = conversations.filter((item) => item.id !== conversationId)
    setConversations(remaining)
    deleteResponseConversation(conversationId).catch((err) => {
      showToast(`历史会话删除失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    })

    if (conversationId !== activeConversationId) return

    const next = remaining[0]
    if (next) {
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
              disabled={isRunning}
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
                {conversations.map((conversation) => (
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
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {formatConversationTime(conversation.updatedAt)}
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
                        title="删除会话"
                      >
                        删除
                      </span>
                    </div>
                  </button>
                ))}
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
                兼容模式默认不发送 previous_response_id，可手动切换为接续模式。
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

                    {message.error && (
                      <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                        {message.error}
                      </div>
                    )}

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
                {isRunning ? '发送中' : '发送'}
              </button>
            </div>
          </div>
        </section>

        <aside className="grid gap-4 overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-gray-900">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">请求参数</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              兼容模式适合当前 sub2api HTTP Responses 代理。
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
              onChange={(value) => setContextMode(value)}
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
            <div className="mt-1 break-all font-mono text-[11px] text-gray-500 dark:text-gray-400">
              {shouldSendPreviousResponseId ? conversationResponseId || '无' : '未发送'}
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}
