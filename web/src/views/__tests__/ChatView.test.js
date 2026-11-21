import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

vi.mock('@/api', async (original) => ({
  ...(await original()),
  API_BASE: 'http://localhost:5051',
  getHealth: vi.fn(),
  sendQuestion: vi.fn(),
  sendQuestionStream: vi.fn(),
  authLogout: vi.fn(),
}))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

import { nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { getHealth, sendQuestionStream } from '@/api'
import { resetAuthForTests } from '@/composables/useAuth'
import { resetChatForTests } from '@/composables/useChat'
import { TooltipProvider } from '@/components/ui/tooltip'
import ChatView from '../ChatView.vue'

const HEALTHY = { ok: true, ai_configured: true, counts: { timetable: 12 } }

const ROWS = [
  { id: 1, course_code: 'CPS 416', course_title: 'Artificial Intelligence', day: 'Mon', start_time: '08:30', end_time: '11:00', venue: 'Lab 2', lecturer: 'Dr. Awa Ceesay' },
  { id: 2, course_code: 'CPS 313', course_title: 'Operating Systems', day: 'Mon', start_time: '11:30', end_time: '14:00', venue: 'Hall A', lecturer: 'Mr. Lamin Jobe' },
]

function streamAnswer(text, meta = { matches: [], filters: null }) {
  sendQuestionStream.mockImplementationOnce(async (q, { onMeta, onChunk }) => {
    onMeta(meta)
    onChunk(text)
  })
}

async function mountChat() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: ChatView },
      { path: '/admin', component: { template: '<div />' } },
      { path: '/login', name: 'login', component: { template: '<div>sign in page</div>' } },
    ],
  })
  router.push('/')
  await router.isReady()
  // Tooltips need a provider, as in App.vue
  const wrapper = mount({ components: { TooltipProvider, ChatView }, template: '<TooltipProvider><ChatView /></TooltipProvider>' }, {
    global: { plugins: [router] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const byLabel = (wrapper, label) => wrapper.find(`[aria-label="${label}"]`)

async function ask(wrapper, text) {
  await wrapper.find('textarea').setValue(text)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

let wrapper
beforeEach(async () => {
  localStorage.clear()
  localStorage.setItem('utg-auth-v1', JSON.stringify({ token: 't', user: { id: 7, mat_number: '22216000', email: 'awa@utg.edu' } }))
  resetAuthForTests()
  await nextTick()
  resetChatForTests()
  getHealth.mockResolvedValue(HEALTHY)
})
afterEach(() => {
  wrapper?.unmount()
  delete window.webkitSpeechRecognition
  delete window.speechSynthesis
  delete window.SpeechSynthesisUtterance
})

describe('ChatView', () => {
  it('starts with quick questions under the box and sends one when it is picked', async () => {
    wrapper = await mountChat()
    expect(wrapper.text()).toContain('What do you want to know?')
    expect(wrapper.find('[aria-label="Quick questions"]').findAll('button').map((b) => b.text())).toEqual([
      'Today’s classes', 'Tomorrow', 'Upcoming exams', 'Who teaches AI?',
    ])

    streamAnswer('Dr. Awa Ceesay teaches it.')
    const suggestion = wrapper.findAll('button').find((b) => b.text().includes('Who teaches AI?'))
    await suggestion.trigger('click')
    await flushPromises()

    expect(sendQuestionStream.mock.calls[0][0]).toBe('Who is teaching AI?')
    expect(wrapper.find('[data-role="user"]').text()).toContain('Who is teaching AI?')
    expect(wrapper.find('[data-role="assistant"]').text()).toContain('Dr. Awa Ceesay teaches it.')
    expect(wrapper.text()).not.toContain('What do you want to know?')
    expect(wrapper.find('[aria-label="Quick questions"]').exists()).toBe(false)
  })

  it('sends on Enter but not on Shift+Enter, and clears the box', async () => {
    wrapper = await mountChat()
    const box = wrapper.find('textarea')

    await box.setValue('line one')
    await box.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(sendQuestionStream).not.toHaveBeenCalled()

    streamAnswer('ok')
    await box.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(sendQuestionStream).toHaveBeenCalledTimes(1)
    expect(box.element.value).toBe('')
  })

  it('disables Send until there is something to send', async () => {
    wrapper = await mountChat()
    expect(byLabel(wrapper, 'Send question').attributes('disabled')).toBeDefined()
    await wrapper.find('textarea').setValue('  ')
    expect(byLabel(wrapper, 'Send question').attributes('disabled')).toBeDefined()
    await wrapper.find('textarea').setValue('hi')
    expect(byLabel(wrapper, 'Send question').attributes('disabled')).toBeUndefined()
  })

  it('renders Markdown in answers and escapes HTML', async () => {
    wrapper = await mountChat()
    streamAnswer('**Artificial Intelligence** <img src=x onerror=alert(1)>')
    await ask(wrapper, 'When is AI?')

    const answer = wrapper.find('[data-role="assistant"]')
    expect(answer.find('strong').text()).toBe('Artificial Intelligence')
    expect(answer.find('img').exists()).toBe(false)
    expect(answer.text()).toContain('<img src=x onerror=alert(1)>')
  })

  it('lists the matching classes under the answer', async () => {
    wrapper = await mountChat()
    streamAnswer('Two classes on Monday.', { matches: ROWS, filters: { day: 'Mon', dept: 'CS' } })
    await ask(wrapper, 'Show Monday schedule for CS')

    const trigger = wrapper.findAll('button').find((b) => b.text().includes('2 matching classes'))
    expect(trigger.exists()).toBe(true)
    expect(wrapper.text()).toContain('Monday')
    expect(wrapper.text()).toContain('CS')

    // two rows: the answer text covers them, so the schedule waits behind the button
    expect(wrapper.find('[data-testid="schedule"]').exists()).toBe(false)
    await trigger.trigger('click')
    await flushPromises()
    const schedule = wrapper.find('[data-testid="schedule"]')
    expect(schedule.findAll('h3').map((h) => h.text())).toEqual(['Monday'])
    expect(schedule.findAll('li')).toHaveLength(2)
    expect(schedule.findAll('li')[0].text()).toContain('08:30–11:00')
    expect(schedule.findAll('li')[0].text()).toContain('Artificial Intelligence')
    expect(schedule.findAll('li')[0].text()).toContain('CPS 416 · Dr. Awa Ceesay')
    expect(schedule.findAll('li')[0].text()).toContain('Lab 2')
  })

  it('shows a longer result as an open schedule grouped by day, and copies it with the summary', async () => {
    wrapper = await mountChat()
    const rows = [
      ...ROWS,
      { id: 3, course_code: 'ICT 202', course_title: 'Web Programming II', day: 'Tue', start_time: '08:30', end_time: '11:00', venue: 'Lab 1', lecturer: 'Ms. Fatou Sanneh' },
    ]
    streamAnswer('There are **3 classes** on Monday and Tuesday.', { matches: rows, filters: { dept: 'CS' }, schedule: true })
    await ask(wrapper, 'Show CS classes')

    const schedule = wrapper.find('[data-testid="schedule"]')
    expect(schedule.exists()).toBe(true) // no click needed
    expect(schedule.findAll('h3').map((h) => h.text())).toEqual(['Monday', 'Tuesday'])
    expect(schedule.findAll('section')[0].findAll('li')).toHaveLength(2)
    expect(schedule.findAll('section')[1].findAll('li')).toHaveLength(1)

    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await byLabel(wrapper, 'Copy answer').trigger('click')
    await flushPromises()
    expect(writeText.mock.calls[0][0]).toBe([
      'There are 3 classes on Monday and Tuesday.',
      '',
      'Monday:',
      'CPS 416 Artificial Intelligence, 08:30 to 11:00, Lab 2, Dr. Awa Ceesay.',
      'CPS 313 Operating Systems, 11:30 to 14:00, Hall A, Mr. Lamin Jobe.',
      '',
      'Tuesday:',
      'ICT 202 Web Programming II, 08:30 to 11:00, Lab 1, Ms. Fatou Sanneh.',
    ].join('\n'))
  })

  it('shows Stop while answering and aborts when it is pressed', async () => {
    wrapper = await mountChat()
    let signal
    sendQuestionStream.mockImplementationOnce((q, options) => {
      signal = options.signal
      options.onChunk('Partial answer')
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    await ask(wrapper, 'question')

    expect(byLabel(wrapper, 'Send question').exists()).toBe(false)
    await byLabel(wrapper, 'Stop answering').trigger('click')
    await flushPromises()

    expect(signal.aborted).toBe(true)
    expect(wrapper.text()).toContain('Partial answer')
    expect(wrapper.text()).toContain('Stopped before the answer finished.')
    expect(byLabel(wrapper, 'Send question').exists()).toBe(true)
  })

  it('shows a failed answer with its reason and retries it', async () => {
    wrapper = await mountChat()
    sendQuestionStream.mockRejectedValueOnce(new Error('The AI model is busy right now.'))
    await ask(wrapper, 'Who teaches AI?')
    expect(wrapper.find('[role="alert"]').text()).toContain('The AI model is busy right now.')

    streamAnswer('Dr. Awa Ceesay.')
    await byLabel(wrapper, 'Try again').trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-role="user"]')).toHaveLength(1)
    expect(wrapper.find('[data-role="assistant"]').text()).toContain('Dr. Awa Ceesay.')
  })

  it('Edit puts the last question back in the box', async () => {
    wrapper = await mountChat()
    streamAnswer('answer')
    await ask(wrapper, 'Who teaches AI?')

    await byLabel(wrapper, 'Edit question').trigger('click')
    await flushPromises()

    expect(wrapper.find('textarea').element.value).toBe('Who teaches AI?')
    expect(wrapper.findAll('[data-role]')).toHaveLength(0)
  })

  it('copies the answer as plain text', async () => {
    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    wrapper = await mountChat()
    streamAnswer('**AI** at 08:30')
    await ask(wrapper, 'When is AI?')

    await byLabel(wrapper, 'Copy answer').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('AI at 08:30')
    expect(byLabel(wrapper, 'Copied').exists()).toBe(true)
  })

  it('New chat clears the conversation', async () => {
    wrapper = await mountChat()
    streamAnswer('answer')
    await ask(wrapper, 'question')

    const newChat = wrapper.findAll('button').find((b) => b.text().includes('New chat'))
    await newChat.trigger('click')

    expect(wrapper.findAll('[data-role]')).toHaveLength(0)
    expect(wrapper.text()).toContain('What do you want to know?')
  })

  it('lists saved chats under Recents and opens one when it is picked', async () => {
    localStorage.setItem('utg-chats-v2:7', JSON.stringify([{
      id: 'c1', title: 'Earlier question', updatedAt: 1,
      messages: [
        { id: 'a', role: 'user', text: 'Earlier question', status: 'done' },
        { id: 'b', role: 'assistant', text: 'Earlier answer', status: 'done' },
      ],
    }]))
    resetChatForTests()
    wrapper = await mountChat()

    // a new chat is showing; the saved one waits in the sidebar
    expect(wrapper.text()).toContain('What do you want to know?')
    expect(wrapper.text()).not.toContain('Earlier answer')
    const recent = wrapper.find('nav[aria-label="Recent chats"]').findAll('button').find((b) => b.text() === 'Earlier question')
    await recent.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Earlier answer')
    expect(recent.attributes('aria-current')).toBe('page')
  })

  it('keeps separate chats, and a deleted one can be brought back', async () => {
    wrapper = await mountChat()
    streamAnswer('first answer')
    await ask(wrapper, 'first chat')
    await wrapper.findAll('button').find((b) => b.text().includes('New chat')).trigger('click')
    streamAnswer('second answer')
    await ask(wrapper, 'second chat')

    const titles = () => wrapper.find('nav[aria-label="Recent chats"]').findAll('li > button:first-child').map((b) => b.text())
    expect(titles()).toEqual(['second chat', 'first chat'])

    await byLabel(wrapper, 'Delete chat: second chat').trigger('click')
    expect(titles()).toEqual(['first chat'])
    expect(wrapper.text()).toContain('What do you want to know?')

    // the toast offers Undo
    const [message, options] = toast.mock.calls.at(-1)
    expect(message).toBe('Chat deleted')
    options.action.onClick()
    await flushPromises()
    expect(titles()).toEqual(['second chat', 'first chat'])
  })

  it('offers the choices when the assistant asks which department, and sends the one picked', async () => {
    wrapper = await mountChat()
    streamAnswer('There are classes on Tuesday in 2 departments: CS and INS. Which department do you want?', {
      matches: [], filters: { day: 'Tue' }, clarify: { options: ['CS', 'INS', 'All departments'] },
    })
    await ask(wrapper, 'What classes are on Tuesday?')

    const choices = wrapper.find('[aria-label="Choose one"]')
    expect(choices.findAll('button').map((b) => b.text())).toEqual(['CS', 'INS', 'All departments'])

    streamAnswer('INS has Database Systems.', { matches: [ROWS[0]], filters: { day: 'Tue', dept: 'INS' } })
    await choices.findAll('button')[1].trigger('click')
    await flushPromises()

    const [question, options] = sendQuestionStream.mock.calls.at(-1)
    expect(question).toBe('INS')
    // the earlier question and the assistant's question go along, so the server can re-ask it
    expect(options.history.map((t) => t.text)).toEqual([
      'What classes are on Tuesday?',
      'There are classes on Tuesday in 2 departments: CS and INS. Which department do you want?',
    ])
    // the choices belong to the latest exchange only
    expect(wrapper.find('[aria-label="Choose one"]').exists()).toBe(false)
  })

  it('shows who is signed in', async () => {
    wrapper = await mountChat()
    const account = byLabel(wrapper, 'Account menu')
    expect(account.text()).toContain('22216000')
    expect(account.text()).toContain('awa@utg.edu')
  })

  it('shows exams with their dates, and offers calendar and spreadsheet downloads', async () => {
    wrapper = await mountChat()
    const exam = { id: 9, kind: 'exam', course_code: 'CPS 416', course_title: 'Artificial Intelligence', date: '2026-12-07', day: 'Mon', start_time: '09:00', end_time: '12:00', venue: 'Exam Hall 1' }
    streamAnswer('It is on Monday 7 December.', { matches: [exam], filters: { exam: true, title: 'Artificial Intelligence' } })
    await ask(wrapper, 'When is the AI exam?')

    const trigger = wrapper.findAll('button').find((b) => b.text().includes('1 matching exam'))
    await trigger.trigger('click')
    await flushPromises()

    const schedule = wrapper.find('[data-testid="schedule"]')
    expect(schedule.find('h3').text()).toBe('Monday 7 December 2026')
    expect(schedule.find('li').text()).toContain('09:00–12:00')
    expect(schedule.find('li').text()).toContain('Exam Hall 1')

    // downloads: capture what would be saved
    const blobs = []
    URL.createObjectURL = vi.fn((blob) => { blobs.push(blob); return 'blob:x' })
    URL.revokeObjectURL = vi.fn()
    const names = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { names.push(this.download) })

    await wrapper.findAll('button').find((b) => b.text().includes('Add to calendar')).trigger('click')
    await wrapper.findAll('button').find((b) => b.text().includes('Download spreadsheet')).trigger('click')
    click.mockRestore()

    expect(names).toEqual(['exams-artificial-intelligence.ics', 'exams-artificial-intelligence.csv'])
    const [ics, csv] = await Promise.all(blobs.map((b) => b.text()))
    expect(ics).toContain('SUMMARY:Exam: CPS 416 Artificial Intelligence')
    expect(ics).toContain('DTSTART:20261207T090000')
    expect(csv).toContain('Exam,CPS 416,Artificial Intelligence,Monday,2026-12-07,09:00,12:00,Exam Hall 1,')
  })

  describe('server status', () => {
    it('says when the server cannot be reached', async () => {
      getHealth.mockRejectedValue(new Error('offline'))
      wrapper = await mountChat()
      expect(wrapper.text()).toContain('Can’t reach the server')
    })

    it('points to Admin when no timetable is loaded', async () => {
      getHealth.mockResolvedValue({ ok: true, ai_configured: true, counts: { timetable: 0, exams: 0 } })
      wrapper = await mountChat()
      expect(wrapper.text()).toContain('No timetable loaded yet')
      expect(wrapper.find('a[href="/admin"]').exists()).toBe(true)
    })

    it('says when the model key is missing', async () => {
      getHealth.mockResolvedValue({ ok: true, ai_configured: false, counts: { timetable: 5 } })
      wrapper = await mountChat()
      expect(wrapper.text()).toContain('The AI model is not set up yet')
    })

    it('shows nothing extra when all is well', async () => {
      wrapper = await mountChat()
      expect(wrapper.text()).not.toContain('Can’t reach the server')
      expect(wrapper.text()).not.toContain('No timetable loaded yet')
    })
  })

  describe('voice', () => {
    class FakeRecognition {
      static last = null
      constructor() { FakeRecognition.last = this }
      start() {}
      stop() { this.onend?.() }
    }

    it('hides the mic when the browser has no speech recognition', async () => {
      wrapper = await mountChat()
      expect(byLabel(wrapper, 'Ask by voice').exists()).toBe(false)
    })

    it('sends a spoken question and reads the answer back', async () => {
      window.webkitSpeechRecognition = FakeRecognition
      const spoken = []
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
      window.speechSynthesis = { speak: (u) => spoken.push(u.text), cancel: vi.fn() }

      wrapper = await mountChat()
      await byLabel(wrapper, 'Ask by voice').trigger('click')
      expect(byLabel(wrapper, 'Stop listening').exists()).toBe(true)

      const recognition = FakeRecognition.last
      recognition.onresult({ results: [[{ transcript: 'who teaches AI' }]] })
      await flushPromises()
      expect(wrapper.find('textarea').element.value).toBe('who teaches AI')

      streamAnswer('**Dr. Awa Ceesay** teaches it.')
      recognition.onend()
      await flushPromises()

      expect(sendQuestionStream.mock.calls[0][0]).toBe('who teaches AI')
      expect(spoken).toEqual(['Dr. Awa Ceesay teaches it.'])
    })

    it('does not read typed questions aloud', async () => {
      const speak = vi.fn()
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
      window.speechSynthesis = { speak, cancel: vi.fn() }

      wrapper = await mountChat()
      streamAnswer('answer')
      await ask(wrapper, 'typed question')

      expect(speak).not.toHaveBeenCalled()
      // but the answer can be read on request
      await byLabel(wrapper, 'Read aloud').trigger('click')
      expect(speak).toHaveBeenCalledTimes(1)
    })
  })
})
