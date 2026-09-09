import { h } from './dom.js'
import { octicon } from './octicons.js'

const debugSecretPatterns = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

/**
 * @param {'user' | 'assistant'} role
 * @param {string} content
 * @param {string} traceId
 */
function debugCopilotMessage(role, content, traceId) {
  const redacted = debugSecretPatterns.reduce(
    (value, pattern) => value.replace(pattern, '[REDACTED]'),
    content,
  )
  console.debug(
    '[dashboard-copilot]',
    JSON.stringify({ traceId, role, content: redacted }),
  )
}

/**
 * @param {string} message
 * @param {unknown} details
 * @param {string} traceId
 */
function debugCopilotUpdate(message, details = {}, traceId) {
  console.debug(
    '[dashboard-copilot]',
    JSON.stringify({ traceId, message, details }),
  )
}

/**
 * @param {WebSocket} socket
 * @param {string} event
 * @param {string} traceId
 * @param {Record<string, unknown>} details
 */
function browserTrace(socket, event, traceId, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    source: 'browser',
    event,
    traceId,
    details,
  }
  console.debug('[dashboard-trace]', JSON.stringify(entry))
  if (socket.readyState === 1) {
    socket.send(
      JSON.stringify({ type: 'browser.trace', traceId, event, details }),
    )
  }
}

/**
 * @param {WebSocket} socket
 * @returns {HTMLFormElement}
 */
export function renderCopilotPrompt(socket) {
  const input = /** @type {HTMLTextAreaElement} */ (
    h('textarea', {
      id: 'dashboard-copilot-request',
      name: 'request',
      rows: 2,
      required: true,
      maxLength: 10000,
      'aria-label': 'Modify this view',
      placeholder: 'Describe the change to this view',
    })
  )
  const sendButton = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      {
        type: 'submit',
        className: 'dashboard-copilot-action dashboard-copilot-send',
        title: 'Send message',
        'aria-label': 'Send message',
      },
      octicon('paper-airplane'),
    )
  )
  const toolbarStatus = h('output', {
    id: 'dashboard-copilot-status',
    'aria-live': 'polite',
  })
  const conversation = h('div', {
    className: 'dashboard-copilot-conversation',
    role: 'log',
    'aria-live': 'polite',
  })
  let sessionActive = false
  let activeViewName = ''
  let assistantResponse = ''
  let activeTraceId = ''
  /** @type {HTMLElement | null} */
  let assistantContent = null
  /** @type {HTMLElement | null} */
  let reasoningContent = null
  let activeReasoningId = ''
  /**
   * @param {string} content
   * @param {'response'|'reasoning'|'update'|'refusal'|'error'} kind
   */
  const appendAssistantMessage = (content = '', kind = 'response') => {
    if (!content.trim()) return null
    const message = h(
      'div',
      {
        className: `dashboard-copilot-message dashboard-copilot-message-assistant dashboard-copilot-message-${kind}`,
      },
      h('div', { className: 'dashboard-copilot-message-content' }, content),
    )
    conversation.append(message)
    const contentElement = /** @type {HTMLElement | null} */ (
      message.querySelector('.dashboard-copilot-message-content')
    )
    scrollConversation()
    return contentElement
  }
  const reuseLatestReasoningMessage = () => {
    const previous = conversation.lastElementChild
    if (!previous?.classList.contains('dashboard-copilot-message-reasoning'))
      return null
    return /** @type {HTMLElement | null} */ (
      previous.querySelector('.dashboard-copilot-message-content')
    )
  }
  /** @param {string} content */
  const appendStatusMessage = (content) => {
    if (!content.trim()) return
    const previous = conversation.lastElementChild
    if (previous?.classList.contains('dashboard-copilot-message-update')) {
      const previousContent = previous.querySelector(
        '.dashboard-copilot-message-content',
      )
      if (previousContent) previousContent.textContent = content
    } else {
      appendAssistantMessage(content, 'update')
    }
    scrollConversation()
  }
  const scrollConversation = () => {
    conversation.scrollTop = conversation.scrollHeight
  }
  const stopSession = () => {
    if (!sessionActive) return
    sessionActive = false
    if (socket.readyState === 1) {
      socket.send(
        JSON.stringify({ type: 'copilot.stop', traceId: activeTraceId }),
      )
      browserTrace(socket, 'copilot.stop.sent', activeTraceId)
    }
  }
  /** @param {boolean} active */
  const setSessionActive = (active) => {
    sessionActive = active
    sendButton.type = active ? 'button' : 'submit'
    sendButton.classList.toggle('dashboard-copilot-cancel', active)
    sendButton.classList.toggle('dashboard-copilot-send', !active)
    const label = active ? 'Cancel request' : 'Send message'
    sendButton.title = label
    sendButton.setAttribute('aria-label', label)
    sendButton.replaceChildren(
      octicon(active ? 'square-fill' : 'paper-airplane'),
    )
    sendButton.disabled = socket.readyState !== 1
  }
  const cancelSession = () => {
    stopSession()
    setSessionActive(false)
    toolbarStatus.textContent = 'Stopping…'
    input.focus()
  }
  sendButton.addEventListener('click', (event) => {
    if (!sessionActive) return
    event.preventDefault()
    cancelSession()
  })
  const form = /** @type {HTMLFormElement} */ (
    h(
      'form',
      {
        id: 'dashboard-copilot-prompt',
        className: 'dashboard-copilot-prompt',
        'aria-labelledby': 'dashboard-copilot-title',
      },
      h(
        'h2',
        { id: 'dashboard-copilot-title', className: 'sr-only' },
        'Modify this view',
      ),
      conversation,
      h(
        'div',
        { className: 'dashboard-copilot-composer' },
        h('div', { className: 'dashboard-copilot-input' }, input, sendButton),
      ),
      toolbarStatus,
    )
  )

  sendButton.disabled = socket.readyState !== 1
  socket.addEventListener('open', () => {
    sendButton.disabled = false
  })
  socket.addEventListener('close', () => {
    setSessionActive(false)
    sendButton.disabled = true
    toolbarStatus.textContent = 'Copilot connection closed.'
    if (activeTraceId)
      browserTrace(socket, 'copilot.socket.closed', activeTraceId)
  })
  socket.addEventListener('message', (event) => {
    const streamEvent = JSON.parse(String(event.data))
    if (!streamEvent?.type) return
    if (
      streamEvent.traceId &&
      activeTraceId &&
      streamEvent.traceId !== activeTraceId
    )
      return
    if (streamEvent.type === 'stopped') {
      toolbarStatus.textContent = 'Session stopped.'
      setSessionActive(false)
      return
    }
    if (!sessionActive) return
    if (
      streamEvent.type === 'debug' &&
      typeof streamEvent.message === 'string'
    ) {
      debugCopilotUpdate(
        streamEvent.message,
        streamEvent.details,
        activeTraceId,
      )
    } else if (
      streamEvent.type === 'assistant-delta' &&
      typeof streamEvent.content === 'string'
    ) {
      if (!streamEvent.content.trim() && !assistantContent) return
      if (!assistantContent) {
        assistantContent = appendAssistantMessage(streamEvent.content)
      } else {
        assistantContent.textContent += streamEvent.content
      }
      assistantResponse += streamEvent.content
      scrollConversation()
    } else if (
      streamEvent.type === 'assistant-message' &&
      typeof streamEvent.content === 'string'
    ) {
      if (!streamEvent.content.trim()) return
      if (!assistantContent)
        assistantContent = appendAssistantMessage(streamEvent.content)
      else assistantContent.textContent = streamEvent.content
      assistantResponse = streamEvent.content
      scrollConversation()
      debugCopilotMessage('assistant', assistantResponse, activeTraceId)
      assistantContent = null
    } else if (
      streamEvent.type === 'reasoning-delta' &&
      typeof streamEvent.content === 'string'
    ) {
      if (!streamEvent.content.trim() && !reasoningContent) return
      if (!reasoningContent || activeReasoningId !== streamEvent.reasoningId) {
        reasoningContent =
          reuseLatestReasoningMessage() ??
          appendAssistantMessage(streamEvent.content, 'reasoning')
        activeReasoningId = streamEvent.reasoningId ?? ''
        if (reasoningContent?.textContent === streamEvent.content) {
          scrollConversation()
          return
        }
      }
      if (reasoningContent) reasoningContent.textContent += streamEvent.content
      scrollConversation()
    } else if (
      streamEvent.type === 'reasoning-message' &&
      typeof streamEvent.content === 'string'
    ) {
      if (!streamEvent.content.trim()) return
      if (!reasoningContent || activeReasoningId !== streamEvent.reasoningId) {
        reasoningContent =
          reuseLatestReasoningMessage() ??
          appendAssistantMessage(streamEvent.content, 'reasoning')
        if (reasoningContent) reasoningContent.textContent = streamEvent.content
      } else {
        reasoningContent.textContent = streamEvent.content
      }
      reasoningContent = null
      activeReasoningId = ''
      scrollConversation()
    } else if (
      streamEvent.type === 'status' &&
      typeof streamEvent.message === 'string'
    ) {
      appendStatusMessage(streamEvent.message)
    } else if (
      streamEvent.type === 'tool-refused' &&
      typeof streamEvent.message === 'string'
    ) {
      if (!streamEvent.message.trim()) return
      appendAssistantMessage(streamEvent.message, 'refusal')
      toolbarStatus.textContent = 'A tool was refused; Copilot is continuing.'
      debugCopilotUpdate(
        streamEvent.message,
        streamEvent.details,
        activeTraceId,
      )
    } else if (streamEvent.type === 'reloaded') {
      toolbarStatus.textContent = 'Updated.'
      browserTrace(socket, 'copilot.preview.confirmed', activeTraceId, {
        view: activeViewName,
      })
    } else if (streamEvent.type === 'done') {
      toolbarStatus.textContent = 'Updated.'
      setSessionActive(false)
      input.focus()
      debugCopilotUpdate(
        'Dashboard view update stream completed.',
        {},
        activeTraceId,
      )
      browserTrace(socket, 'copilot.request.completed', activeTraceId, {
        view: activeViewName,
      })
    } else if (
      streamEvent.type === 'error' &&
      typeof streamEvent.message === 'string'
    ) {
      toolbarStatus.textContent = streamEvent.message
      const recovery =
        streamEvent.details?.phase === 'hot-reload'
          ? streamEvent.details.recovered
            ? 'The previous dashboard is still available.'
            : 'The previous dashboard could not be fully restored.'
          : ''
      const errorLog =
        typeof streamEvent.details?.errorLog === 'string'
          ? streamEvent.details.errorLog.trim()
          : ''
      appendAssistantMessage(
        [
          streamEvent.message,
          recovery,
          errorLog ? `Error log:\n${errorLog}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        'error',
      )
      setSessionActive(false)
      console.error('Copilot dashboard update failed.', {
        traceId: activeTraceId,
        view: activeViewName,
        error: streamEvent.message,
      })
    }
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (socket.readyState !== 1 || sessionActive) return
    const activeView = document.querySelector(
      '[data-nav-page-id][aria-current=page]',
    )
    const view =
      activeView?.getAttribute('aria-label') ||
      activeView?.getAttribute('data-nav-page-id') ||
      location.hash.match(/^#page-([^?]+)/)?.[1] ||
      'overview'
    activeViewName = view
    const request = input.value
    activeTraceId =
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`
    debugCopilotMessage('user', request, activeTraceId)
    assistantResponse = ''
    assistantContent = null
    reasoningContent = null
    activeReasoningId = ''
    conversation.append(
      h(
        'div',
        {
          className: 'dashboard-copilot-message dashboard-copilot-message-user',
        },
        h('strong', null, 'You'),
        h('div', { className: 'dashboard-copilot-message-content' }, request),
      ),
    )
    input.value = ''
    scrollConversation()
    toolbarStatus.textContent = 'Working…'

    setSessionActive(true)
    debugCopilotUpdate(
      'Sending dashboard view update request.',
      {
        view,
        requestLength: request.length,
      },
      activeTraceId,
    )
    browserTrace(socket, 'copilot.request.sent', activeTraceId, {
      view,
      requestLength: request.length,
    })
    socket.send(
      JSON.stringify({
        type: 'copilot.start',
        traceId: activeTraceId,
        view,
        request,
      }),
    )
  })
  return form
}
