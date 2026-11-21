import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adminListSources, ApiError, authLogin, getHealth, onStudentSignedOut, sendQuestion, sendQuestionStream, setStudentToken,
} from '../api.js'

const encoder = new TextEncoder()

/** A fetch Response whose body arrives in the given pieces. */
function streamResponse(pieces, init = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
  return new Response(body, { status: 200, ...init })
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('sendQuestionStream', () => {
  it('reports meta once, then each chunk in order', async () => {
    const meta = { event: 'meta', matches: [{ course_code: 'CPS 416' }], filters: { day: 'Mon' } }
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      frame(meta),
      frame({ event: 'chunk', text: 'Hello ' }),
      frame({ event: 'chunk', text: 'world' }),
      frame({ event: 'done' }),
    ])))

    const onMeta = vi.fn()
    const chunks = []
    await sendQuestionStream('hi', { onMeta, onChunk: (t) => chunks.push(t) })

    expect(onMeta).toHaveBeenCalledTimes(1)
    expect(onMeta.mock.calls[0][0].matches).toEqual([{ course_code: 'CPS 416' }])
    expect(chunks).toEqual(['Hello ', 'world'])
  })

  it('handles frames split across network packets', async () => {
    const whole = frame({ event: 'chunk', text: 'Monday 08:30' }) + frame({ event: 'done' })
    const cut = 17
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([whole.slice(0, cut), whole.slice(cut)])))

    const chunks = []
    await sendQuestionStream('hi', { onChunk: (t) => chunks.push(t) })
    expect(chunks).toEqual(['Monday 08:30'])
  })

  it('sends the question and history as JSON to the streaming endpoint', async () => {
    const fetchMock = vi.fn(async () => streamResponse([frame({ event: 'done' })]))
    vi.stubGlobal('fetch', fetchMock)

    const history = [{ role: 'user', text: 'Show Monday' }]
    await sendQuestionStream('What about Tuesday?', { history })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/chat\?stream=1$/)
    expect(JSON.parse(init.body)).toEqual({ question: 'What about Tuesday?', history })
  })

  it('rejects with the server message when the model fails part-way', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      frame({ event: 'chunk', text: 'On Mon' }),
      frame({ event: 'error', message: 'The AI model returned an error. Please try again.' }),
    ])))

    const chunks = []
    await expect(sendQuestionStream('hi', { onChunk: (t) => chunks.push(t) }))
      .rejects.toThrow('The AI model returned an error. Please try again.')
    expect(chunks).toEqual(['On Mon'])
  })

  it('rejects if the stream ends without a done event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([frame({ event: 'chunk', text: 'half' })])))
    await expect(sendQuestionStream('hi')).rejects.toThrow(/connection dropped/i)
  })

  it('ignores junk lines instead of failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      ': keep-alive\n\n',
      'data: not json\n\n',
      frame({ event: 'chunk', text: 'ok' }),
      frame({ event: 'done' }),
    ])))
    const chunks = []
    await sendQuestionStream('hi', { onChunk: (t) => chunks.push(t) })
    expect(chunks).toEqual(['ok'])
  })
})

describe('errors', () => {
  it('uses the error message from a JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'question is too long' }, 400)))
    const error = await sendQuestion('x').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.message).toBe('question is too long')
    expect(error.status).toBe(400)
  })

  it('does not show a raw HTML error page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })))
    const error = await sendQuestion('x').catch((e) => e)
    expect(error.message).toBe('The server had a problem. Please try again.')
  })

  it('explains a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const error = await getHealth().catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(0)
    expect(error.message).toMatch(/could not reach the server/i)
  })

  it('lets an abort through untouched so callers can tell it apart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError') }))
    const error = await sendQuestion('x').catch((e) => e)
    expect(error.name).toBe('AbortError')
  })
})

describe('admin auth', () => {
  it('sends Basic credentials, including non-Latin passwords', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ sources: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await adminListSources({ user: 'admin', pass: 'pässwörd-密码' })

    const header = fetchMock.mock.calls[0][1].headers.Authorization
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(header.replace('Basic ', '')), (c) => c.charCodeAt(0)))
    expect(decoded).toBe('admin:pässwörd-密码')
  })
})

describe('student session', () => {
  afterEach(() => {
    setStudentToken('')
    onStudentSignedOut(null)
  })

  it('sends the session token with questions, but not with public or admin calls', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answer: 'ok', sources: [] }))
    vi.stubGlobal('fetch', fetchMock)
    setStudentToken('student-token')

    await sendQuestion('hi')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer student-token')

    await getHealth()
    expect(fetchMock.mock.calls[1][1].headers?.Authorization).toBeUndefined()

    await adminListSources({ user: 'admin', pass: 'secret' })
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toMatch(/^Basic /)
  })

  it('reports a rejected session so the app can return to sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Please sign in to continue.' }, 401)))
    const signedOut = vi.fn()
    onStudentSignedOut(signedOut)
    setStudentToken('expired')

    const error = await sendQuestion('hi').catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(401)
    expect(signedOut).toHaveBeenCalledTimes(1)
  })

  it('a wrong password is not treated as a lost session, and the reply details are kept', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Confirm your email first.', needs_verification: true, email: 'a@utg.edu' }, 403)))
    const signedOut = vi.fn()
    onStudentSignedOut(signedOut)

    const error = await authLogin('a@utg.edu', 'pw').catch((e) => e)
    expect(error.message).toBe('Confirm your email first.')
    expect(error.data).toMatchObject({ needs_verification: true, email: 'a@utg.edu' })
    expect(signedOut).not.toHaveBeenCalled()
  })
})
