import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

vi.mock('@/api', async (original) => ({
  ...(await original()),
  sendQuestion: vi.fn(),
  sendQuestionStream: vi.fn(),
}))

import { sendQuestion, sendQuestionStream } from '@/api'
import { resetAuthForTests } from '../useAuth.js'
import { resetChatForTests, useChat } from '../useChat.js'

const chat = useChat()

/** Sign a student in (or out, with null), as the saved session would on page load. */
async function signInAs(id) {
  if (id == null) localStorage.removeItem('utg-auth-v1')
  else localStorage.setItem('utg-auth-v1', JSON.stringify({ token: 't', user: { id, mat_number: `2221600${id}`, email: `s${id}@utg.edu` } }))
  resetAuthForTests()
  await nextTick() // let the chats for that student load
}
const saved = (id = 7) => JSON.parse(localStorage.getItem(`utg-chats-v2:${id}`))

/** Make the next streamed answer deliver these chunks. */
function streamAnswer(chunks, meta = { matches: [], filters: null }) {
  sendQuestionStream.mockImplementationOnce(async (question, { onMeta, onChunk }) => {
    onMeta(meta)
    for (const chunk of chunks) onChunk(chunk)
  })
}

beforeEach(async () => {
  localStorage.clear()
  await signInAs(7)
  resetChatForTests()
})

describe('useChat', () => {
  it('adds the question and builds the answer from streamed chunks', async () => {
    const row = { id: 1, course_code: 'CPS 416' }
    streamAnswer(['On Monday ', 'at 08:30.'], { matches: [row], filters: { day: 'Mon' } })

    const answer = await chat.send('  When is AI?  ')

    expect(chat.messages.value.map((m) => [m.role, m.text])).toEqual([
      ['user', 'When is AI?'],
      ['assistant', 'On Monday at 08:30.'],
    ])
    expect(answer.status).toBe('done')
    expect(answer.sources).toEqual([row])
    expect(answer.filters).toEqual({ day: 'Mon' })
    expect(chat.busy.value).toBe(false)
  })

  it('shows text while the answer is still arriving', async () => {
    let release
    sendQuestionStream.mockImplementationOnce(async (q, { onChunk }) => {
      onChunk('First part')
      await new Promise((resolve) => { release = resolve })
    })

    const pending = chat.send('question')
    await vi.waitFor(() => expect(chat.messages.value[1].text).toBe('First part'))
    expect(chat.messages.value[1].status).toBe('streaming')
    expect(chat.busy.value).toBe(true)

    release()
    await pending
    expect(chat.messages.value[1].status).toBe('done')
  })

  it('ignores empty questions and a second question while busy', async () => {
    expect(await chat.send('   ')).toBeNull()

    let release
    sendQuestionStream.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = chat.send('one')
    expect(await chat.send('two')).toBeNull()
    release()
    await first

    expect(sendQuestionStream).toHaveBeenCalledTimes(1)
    expect(chat.messages.value).toHaveLength(2)
  })

  it('sends the earlier turns as history, without failed answers', async () => {
    streamAnswer(['Monday answer'])
    await chat.send('Show Monday for CS')
    sendQuestionStream.mockRejectedValueOnce(new Error('boom'))
    await chat.send('broken question')
    streamAnswer(['Tuesday answer'])
    await chat.send('What about Tuesday?')

    const history = sendQuestionStream.mock.calls.at(-1)[1].history
    expect(history).toEqual([
      { role: 'user', text: 'Show Monday for CS' },
      { role: 'assistant', text: 'Monday answer' },
      { role: 'user', text: 'broken question' },
    ])
  })

  it('keeps the error on the answer so it can be shown and retried', async () => {
    sendQuestionStream.mockRejectedValueOnce(new Error('The AI model is busy right now.'))
    const answer = await chat.send('question')
    expect(answer.status).toBe('error')
    expect(answer.error).toBe('The AI model is busy right now.')
    expect(chat.busy.value).toBe(false)
  })

  it('stop() aborts the request and keeps what arrived', async () => {
    sendQuestionStream.mockImplementationOnce((q, { signal, onChunk }) => {
      onChunk('Partial')
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })

    const pending = chat.send('question')
    await vi.waitFor(() => expect(chat.messages.value[1].text).toBe('Partial'))
    chat.stop()
    const answer = await pending

    expect(answer.status).toBe('stopped')
    expect(answer.text).toBe('Partial')
    expect(chat.busy.value).toBe(false)
  })

  it('retry() replaces the last exchange with a fresh answer', async () => {
    sendQuestionStream.mockRejectedValueOnce(new Error('boom'))
    await chat.send('Who teaches AI?')
    streamAnswer(['Dr. Ceesay.'])
    await chat.retry()

    expect(chat.messages.value.map((m) => [m.role, m.text, m.status])).toEqual([
      ['user', 'Who teaches AI?', 'done'],
      ['assistant', 'Dr. Ceesay.', 'done'],
    ])
  })

  it('takeLastQuestion() removes the last exchange and returns its text', async () => {
    streamAnswer(['first answer'])
    await chat.send('first')
    streamAnswer(['second answer'])
    await chat.send('second')

    expect(chat.takeLastQuestion()).toBe('second')
    expect(chat.messages.value.map((m) => m.text)).toEqual(['first', 'first answer'])
  })

  it('uses the non-streaming endpoint when live answers are off', async () => {
    chat.streaming.value = false
    sendQuestion.mockResolvedValueOnce({ answer: 'All at once.', matches: [{ id: 2 }], filters: { dept: 'CS' } })

    const answer = await chat.send('question')

    expect(sendQuestionStream).not.toHaveBeenCalled()
    expect(answer.text).toBe('All at once.')
    expect(answer.sources).toEqual([{ id: 2 }])
  })

  it('falls back to a clear message when the model says nothing', async () => {
    streamAnswer([])
    const answer = await chat.send('question')
    expect(answer.text).toBe('I could not find it.')
  })

  it('remembers the conversation across reloads', async () => {
    streamAnswer(['Saved answer'], { matches: [{ id: 3 }], filters: null })
    await chat.send('Saved question')

    resetChatForTests() // re-read from localStorage, as a page load would

    // a reload opens on a new chat; the saved one is in the list
    expect(chat.messages.value).toEqual([])
    chat.openChat(chat.conversations.value[0].id)
    expect(chat.messages.value.map((m) => m.text)).toEqual(['Saved question', 'Saved answer'])
    expect(chat.messages.value[1].sources).toEqual([{ id: 3 }])
  })

  it('marks an answer that was interrupted by a reload as stopped', () => {
    localStorage.setItem('utg-chats-v2:7', JSON.stringify([{
      id: 'c1', title: 'q', updatedAt: 1,
      messages: [
        { id: 'a', role: 'user', text: 'q', status: 'done' },
        { id: 'b', role: 'assistant', text: 'half an ans', status: 'streaming' },
      ],
    }]))
    resetChatForTests()
    chat.openChat('c1')
    expect(chat.messages.value[1].status).toBe('stopped')
  })

  it('survives corrupt saved data', () => {
    localStorage.setItem('utg-chats-v2:7', '{not json')
    resetChatForTests()
    expect(chat.conversations.value).toEqual([])
    expect(chat.messages.value).toEqual([])
  })
})

describe('conversations', () => {
  it('starts a conversation on the first question, titled after it', async () => {
    expect(chat.conversations.value).toEqual([])
    streamAnswer(['answer'])
    await chat.send('When is   the AI\nexam?')

    expect(chat.conversations.value).toHaveLength(1)
    expect(chat.conversations.value[0].title).toBe('When is the AI exam?')
    expect(chat.activeId.value).toBe(chat.conversations.value[0].id)

    streamAnswer(['more'])
    await chat.send('And where?')
    expect(chat.conversations.value).toHaveLength(1) // a follow-up stays in the same chat
    expect(chat.messages.value).toHaveLength(4)
  })

  it('shortens long titles', async () => {
    streamAnswer(['answer'])
    await chat.send('x'.repeat(200))
    expect(chat.conversations.value[0].title).toHaveLength(60)
    expect(chat.conversations.value[0].title.endsWith('…')).toBe(true)
  })

  it('newChat() opens a blank chat and keeps the old one in the list', async () => {
    streamAnswer(['first answer'])
    await chat.send('first chat')
    chat.newChat()
    expect(chat.messages.value).toEqual([])
    expect(chat.conversations.value).toHaveLength(1)

    streamAnswer(['second answer'])
    await chat.send('second chat')
    expect(chat.conversations.value.map((c) => c.title)).toEqual(['second chat', 'first chat'])
    // each chat sends only its own history
    expect(sendQuestionStream.mock.calls.at(-1)[1].history).toEqual([])
  })

  it('openChat() switches, and asking in an older chat moves it to the top', async () => {
    streamAnswer(['a1'])
    await chat.send('older')
    const older = chat.activeId.value
    chat.newChat()
    streamAnswer(['a2'])
    await chat.send('newer')

    chat.openChat(older)
    expect(chat.messages.value.map((m) => m.text)).toEqual(['older', 'a1'])

    streamAnswer(['a3'])
    await chat.send('follow-up')
    expect(chat.conversations.value.map((c) => c.title)).toEqual(['older', 'newer'])
    expect(saved().map((c) => c.title)).toEqual(['older', 'newer'])
  })

  it('deleteChat() removes a chat and can be undone', async () => {
    streamAnswer(['a1'])
    await chat.send('keep me')
    chat.newChat()
    streamAnswer(['a2'])
    await chat.send('delete me')
    const doomed = chat.activeId.value

    const undo = chat.deleteChat(doomed)
    expect(chat.conversations.value.map((c) => c.title)).toEqual(['keep me'])
    expect(chat.messages.value).toEqual([]) // the open chat was the deleted one
    expect(saved().map((c) => c.title)).toEqual(['keep me'])

    undo()
    expect(chat.conversations.value.map((c) => c.title)).toEqual(['delete me', 'keep me'])
    expect(saved()).toHaveLength(2)
  })

  it('keeps each student\'s chats apart on a shared device', async () => {
    streamAnswer(['private answer'])
    await chat.send('private question')

    await signInAs(8)
    expect(chat.conversations.value).toEqual([])
    streamAnswer(['other answer'])
    await chat.send('other question')

    await signInAs(null)
    expect(chat.conversations.value).toEqual([])

    await signInAs(7)
    expect(chat.conversations.value.map((c) => c.title)).toEqual(['private question'])
    expect(saved(8).map((c) => c.title)).toEqual(['other question'])
  })
})
