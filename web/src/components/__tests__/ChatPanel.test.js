import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChatPanel from '../ChatPanel.vue'
import { sendQuestion, sendQuestionStream } from '../../api.js'

vi.mock('../../api.js', () => ({
  sendQuestion: vi.fn(),
  sendQuestionStream: vi.fn(),
}))

afterEach(() => {
  vi.useRealTimers()
})

// The typing effect waits on setTimeout between words. Fake only that, so
// flushPromises (which uses setImmediate) keeps working.
function useFakeTypingTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

async function ask(wrapper, question) {
  await wrapper.find('textarea').setValue(question)
  await wrapper.find('form').trigger('submit')
}

async function turnStreamingOff(wrapper) {
  await wrapper.find('.stream-toggle input').setValue(false)
}

function bubbles(wrapper, role) {
  return wrapper.findAll(`.msg.${role} .msg-bubble`).map((b) => b.text())
}

describe('ChatPanel', () => {
  it('greets the user with example questions', () => {
    const wrapper = mount(ChatPanel)

    expect(bubbles(wrapper, 'assistant')[0]).toContain('Who is teaching AI?')
  })

  it('only enables Send when there is a question', async () => {
    const wrapper = mount(ChatPanel)
    const send = wrapper.find('button[type="submit"]')

    expect(send.attributes('disabled')).toBeDefined()
    await wrapper.find('textarea').setValue('   ')
    expect(send.attributes('disabled')).toBeDefined()
    await wrapper.find('textarea').setValue('Show Monday schedule')
    expect(send.attributes('disabled')).toBeUndefined()
  })

  it('shows the answer from the non-streaming endpoint when streaming is off', async () => {
    sendQuestion.mockResolvedValue({ answer: 'Artificial Intelligence is on Wednesday.' })
    const wrapper = mount(ChatPanel)
    await turnStreamingOff(wrapper)

    await ask(wrapper, 'When is AI?')
    await flushPromises()

    expect(sendQuestion).toHaveBeenCalledWith('When is AI?')
    expect(bubbles(wrapper, 'user')).toEqual(['When is AI?'])
    expect(bubbles(wrapper, 'assistant').at(-1)).toBe('Artificial Intelligence is on Wednesday.')
    expect(wrapper.find('textarea').element.value).toBe('')
  })

  it('types out a streamed answer', async () => {
    useFakeTypingTimers()
    sendQuestionStream.mockImplementation(async (question, onChunk) => {
      onChunk('Lab 2, ')
      onChunk('at 09:00.')
      return null
    })
    const wrapper = mount(ChatPanel)

    await ask(wrapper, 'Where is CPS101?')
    await vi.runAllTimersAsync()
    await flushPromises()

    expect(sendQuestionStream).toHaveBeenCalledWith('Where is CPS101?', expect.any(Function), expect.any(Object))
    expect(bubbles(wrapper, 'assistant').at(-1)).toBe('Lab 2, at 09:00.')
    expect(wrapper.find('button[type="submit"]').exists()).toBe(true)
  })

  it('stops typing the answer when you press Stop', async () => {
    useFakeTypingTimers()
    sendQuestionStream.mockImplementation(async (question, onChunk) => {
      onChunk('Monday: CPS101 at 09:00, CPS210 at 11:00, CPS305 at 14:00.')
    })
    const wrapper = mount(ChatPanel)

    await ask(wrapper, 'Show Monday schedule')
    await vi.advanceTimersByTimeAsync(100)
    const stop = wrapper.find('button.secondary')
    expect(stop.text()).toBe('Stop')
    await stop.trigger('click')
    await vi.runAllTimersAsync()
    await flushPromises()

    const last = bubbles(wrapper, 'assistant').at(-1)
    expect(last).toContain('(stopped)')
    expect(last).not.toContain('CPS305')
    expect(wrapper.find('button[type="submit"]').exists()).toBe(true)
  })

  it('shows HTML in an answer as text instead of rendering it', async () => {
    sendQuestion.mockResolvedValue({ answer: '<img src=x onerror="alert(1)"> Room B4' })
    const wrapper = mount(ChatPanel)
    await turnStreamingOff(wrapper)

    await ask(wrapper, 'Where?')
    await flushPromises()

    const last = wrapper.findAll('.msg.assistant .msg-bubble').at(-1)
    expect(last.find('img').exists()).toBe(false)
    expect(last.text()).toContain('<img src=x')
  })

  it('sends on Enter but not on Shift+Enter', async () => {
    sendQuestion.mockResolvedValue({ answer: 'ok' })
    const wrapper = mount(ChatPanel)
    await turnStreamingOff(wrapper)
    const textarea = wrapper.find('textarea')

    await textarea.setValue('Show Monday schedule')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(sendQuestion).not.toHaveBeenCalled()

    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(sendQuestion).toHaveBeenCalledWith('Show Monday schedule')
  })

  it('moves your last question back into the input when you edit it', async () => {
    sendQuestion.mockResolvedValue({ answer: 'On Monday.' })
    const wrapper = mount(ChatPanel)
    await turnStreamingOff(wrapper)
    await ask(wrapper, 'When is CPS101?')
    await flushPromises()

    const edit = wrapper.findAll('button').find((b) => b.text() === 'Edit')
    await edit.trigger('click')

    expect(wrapper.find('textarea').element.value).toBe('When is CPS101?')
    expect(bubbles(wrapper, 'user')).toEqual([])
    expect(wrapper.findAll('.msg.assistant')).toHaveLength(1)
  })

  it('copies a message and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = mount(ChatPanel)
    const copy = wrapper.find('.msg.assistant .ghost-btn')

    await copy.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('UTG Academic Assistant'))
    expect(copy.text()).toBe('Copied')
  })

  it('shows a friendly message and the error when the server fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    sendQuestionStream.mockRejectedValue(new Error('API error 500: boom'))
    const wrapper = mount(ChatPanel)

    await ask(wrapper, 'Who teaches AI?')
    await flushPromises()

    expect(bubbles(wrapper, 'assistant').at(-1)).toContain('something went wrong')
    expect(wrapper.find('.chat-error').text()).toBe('API error 500: boom')
  })
})
