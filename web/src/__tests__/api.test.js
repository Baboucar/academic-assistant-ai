// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendQuestion, sendQuestionStream } from '../api.js'

// A fetch Response whose body arrives in the given pieces, like a real SSE stream.
function sseResponse(pieces) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendQuestionStream', () => {
  it('passes every chunk on, even when an event is split across reads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"event":"chunk","text":"Hel"}\n\n',
      'data: {"event":"chunk","te',
      'xt":"lo"}\n\ndata: {"event":"done"}\n\n',
    ])))

    const chunks = []
    await sendQuestionStream('hi', (text) => chunks.push(text))

    expect(chunks).toEqual(['Hel', 'lo'])
  })

  it('resolves with the tool answer sent at the end of the stream', async () => {
    const toolAnswer = { slots: { day: 'Mon' }, matches: [] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'data: {"event":"chunk","text":"ok"}\n\n',
      'data: {"event":"done"}\n\n',
      `data: ${JSON.stringify({ event: 'tool', toolAnswer })}\n\n`,
    ])))

    await expect(sendQuestionStream('hi', () => {})).resolves.toEqual(toolAnswer)
  })

  it('skips comments and lines that are not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      ': keep-alive\n\n',
      'data: not json\n\n',
      'data: {"event":"chunk","text":"fine"}\n\n',
    ])))

    const chunks = []
    await sendQuestionStream('hi', (text) => chunks.push(text))

    expect(chunks).toEqual(['fine'])
  })

  it('posts the question to the streaming endpoint with the abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([]))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await sendQuestionStream('Who teaches AI?', () => {}, { signal: controller.signal })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/chat\?stream=1$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ question: 'Who teaches AI?' })
    expect(init.signal).toBe(controller.signal)
  })

  it('throws with the status and body when the server fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))

    await expect(sendQuestionStream('hi', () => {})).rejects.toThrow('API error 500: boom')
  })
})

describe('sendQuestion', () => {
  it('returns the JSON answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ answer: 'Monday, 09:00' })))

    await expect(sendQuestion('When?')).resolves.toEqual({ answer: 'Monday, 09:00' })
  })
})
