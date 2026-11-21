import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('@/api', () => ({
  adminListSources: vi.fn(),
  adminUploadFile: vi.fn(),
  adminDeleteSource: vi.fn(),
  adminReingest: vi.fn(),
  adminGetSettings: vi.fn(async () => ({ current_semester: null, active_semester: null, semesters: [] })),
  adminSetSemester: vi.fn(),
  adminListAliases: vi.fn(async () => ({ aliases: [] })),
  adminAddAlias: vi.fn(),
  adminDeleteAlias: vi.fn(),
  adminGetLog: vi.fn(async () => ({ log: [] })),
  adminGetQuestions: vi.fn(async () => ({ questions: 0, model_calls: 0, cached: 0, totals: {}, unanswered: [] })),
}))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

import { toast } from 'vue-sonner'
import {
  adminAddAlias, adminDeleteAlias, adminDeleteSource, adminGetLog, adminGetQuestions, adminGetSettings, adminListAliases,
  adminListSources, adminReingest,
} from '@/api'
import { useAdmin } from '@/composables/useAdmin'
import { TooltipProvider } from '@/components/ui/tooltip'
import AdminView from '../AdminView.vue'

const SOURCES = {
  sources: [
    { type: 'timetable', source_file: 'cs-timetable.xlsx', semester: '2025-2026 S1', ingested_at: '2026-11-19 10:02:11', row_count: 12 },
    { type: 'calendar', source_file: 'academic-calendar.pdf', semester: null, ingested_at: '2026-11-18 16:40:05', row_count: 0 },
  ],
  counts: { timetable: 12, calendar: 0, notices: 0, sources: 2 },
}

const apiError = (message, status) => Object.assign(new Error(message), { status })

function mountAdmin() {
  return mount({ components: { TooltipProvider, AdminView }, template: '<TooltipProvider><AdminView /></TooltipProvider>' }, {
    attachTo: document.body,
  })
}

async function signIn(wrapper, user = 'admin', pass = 'secret') {
  await wrapper.find('#admin-user').setValue(user)
  await wrapper.find('#admin-pass').setValue(pass)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

const button = (wrapper, text) => wrapper.findAll('button').find((b) => b.text().includes(text))

let wrapper
beforeEach(() => {
  useAdmin().signOut()
})
afterEach(() => wrapper?.unmount())

describe('AdminView sign in', () => {
  it('shows the sign-in form and calls no admin API until it is submitted', () => {
    wrapper = mountAdmin()
    expect(wrapper.text()).toContain('Admin sign in')
    expect(adminListSources).not.toHaveBeenCalled()
  })

  it('asks for both fields before calling the server', async () => {
    wrapper = mountAdmin()
    await wrapper.find('form').trigger('submit')
    expect(wrapper.find('[role="alert"]').text()).toContain('Enter the admin username and password.')
    expect(adminListSources).not.toHaveBeenCalled()
  })

  it('explains a wrong password and clears it', async () => {
    adminListSources.mockRejectedValueOnce(apiError('Invalid username or password', 401))
    wrapper = mountAdmin()
    await signIn(wrapper, 'admin', 'wrong')

    expect(wrapper.find('[role="alert"]').text()).toContain('That username or password is not right.')
    expect(wrapper.find('#admin-pass').element.value).toBe('')
    expect(wrapper.find('#admin-user').element.value).toBe('admin')
    expect(wrapper.text()).toContain('Admin sign in')
  })

  it('passes on the server message when admin is not configured', async () => {
    adminListSources.mockRejectedValueOnce(apiError('Admin is not configured. Set ADMIN_USER and ADMIN_PASS in server/.env', 503))
    wrapper = mountAdmin()
    await signIn(wrapper)
    expect(wrapper.find('[role="alert"]').text()).toContain('Admin is not configured')
  })

  it('signs in with the typed credentials and shows the dashboard', async () => {
    adminListSources.mockResolvedValueOnce(SOURCES)
    wrapper = mountAdmin()
    await signIn(wrapper, ' admin ', 'secret')

    expect(adminListSources).toHaveBeenCalledWith({ user: 'admin', pass: 'secret' })
    expect(wrapper.text()).toContain('Signed in as admin')
    expect(wrapper.text()).not.toContain('Admin sign in')
  })
})

describe('AdminView dashboard', () => {
  beforeEach(async () => {
    adminListSources.mockResolvedValue(SOURCES)
    wrapper = mountAdmin()
    await signIn(wrapper)
  })

  it('lists every source with its type, semester and row count', () => {
    const rows = wrapper.findAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('cs-timetable.xlsx')
    expect(rows[0].text()).toContain('Timetable')
    expect(rows[0].text()).toContain('2025-2026 S1')
    expect(rows[0].text()).toContain('12')
    expect(rows[1].text()).toContain('academic-calendar.pdf')
    expect(rows[1].text()).toContain('Calendar')
  })

  it('shows the totals', () => {
    const stats = Object.fromEntries(wrapper.findAll('dl > div').map((d) => [d.find('dt').text(), d.find('dd').text()]))
    expect(stats).toEqual({ Files: '2', 'Timetable classes': '12', Exams: '0', 'Calendar events': '0', Notices: '0' })
  })

  it('re-ingests everything and reports the result', async () => {
    adminReingest.mockResolvedValueOnce({ ok: true, log: 'done' })
    await button(wrapper, 'Re-ingest all').trigger('click')
    await flushPromises()

    expect(adminReingest).toHaveBeenCalledWith({ user: 'admin', pass: 'secret' }, { file: '' })
    expect(toast.success).toHaveBeenCalledWith('Re-ingested everything in the data folder', expect.anything())
  })

  it('reports a failed re-ingest', async () => {
    adminReingest.mockRejectedValueOnce(apiError('Ingest failed. See the log for details.', 500))
    await button(wrapper, 'Re-ingest all').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('Re-ingest did not finish', expect.objectContaining({ description: 'Ingest failed. See the log for details.' }))
  })

  it('signs out when the server stops accepting the credentials', async () => {
    adminReingest.mockRejectedValueOnce(apiError('Invalid username or password', 401))
    await button(wrapper, 'Re-ingest all').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Admin sign in')
  })

  it('Sign out returns to the form and forgets the credentials', async () => {
    await button(wrapper, 'Sign out').trigger('click')
    expect(wrapper.text()).toContain('Admin sign in')
    expect(useAdmin().creds.value).toBeNull()
  })

  it('shows an empty state when there are no files', async () => {
    adminListSources.mockResolvedValue({ sources: [], counts: { timetable: 0, calendar: 0, notices: 0, sources: 0 } })
    await useAdmin().refresh()
    await flushPromises()
    expect(wrapper.text()).toContain('No files yet')
    expect(wrapper.find('table').exists()).toBe(false)
  })
})

describe('useAdmin actions', () => {
  it('remove() deletes, then reloads the list', async () => {
    adminListSources.mockResolvedValue(SOURCES)
    const admin = useAdmin()
    await admin.signIn('admin', 'secret')
    adminDeleteSource.mockResolvedValueOnce({ ok: true, removed_rows: 12 })
    adminListSources.mockResolvedValueOnce({ sources: [SOURCES.sources[1]], counts: { ...SOURCES.counts, timetable: 0 } })

    const result = await admin.remove('cs-timetable.xlsx', true)

    expect(adminDeleteSource).toHaveBeenCalledWith({ user: 'admin', pass: 'secret' }, 'cs-timetable.xlsx', true)
    expect(result.removed_rows).toBe(12)
    expect(admin.sources.value.map((s) => s.source_file)).toEqual(['academic-calendar.pdf'])
    expect(admin.counts.value.timetable).toBe(0)
  })
})

describe('AdminView settings and activity', () => {
  beforeEach(async () => {
    adminListSources.mockResolvedValue(SOURCES)
    adminGetSettings.mockResolvedValue({
      current_semester: null,
      active_semester: '2026-2027 S1',
      semesters: [{ semester: '2026-2027 S1', files: 2 }, { semester: '2025-2026 S2', files: 3 }],
    })
    adminListAliases.mockResolvedValue({ aliases: [{ alias: 'AI', title: 'Artificial Intelligence' }] })
    adminGetLog.mockResolvedValue({
      log: [{ at: Date.now() - 60_000, admin: 'awa', action: 'upload', target: 'exams.pdf', detail: 'exams, SITC: 73 rows' }],
    })
    adminGetQuestions.mockResolvedValue({
      questions: 40, model_calls: 30, cached: 8,
      totals: { answered: 30, clarify: 4, not_found: 5, not_understood: 1 },
      unanswered: [
        { question: 'when is the os exam', outcome: 'not_found', times: 4, last_at: Date.now() - 3_600_000 },
        { question: 'whats happening', outcome: 'not_understood', times: 1, last_at: Date.now() - 7_200_000 },
      ],
    })
    wrapper = mountAdmin()
    await signIn(wrapper)
    await flushPromises()
  })

  it('says which semester answers come from', () => {
    expect(wrapper.find('[data-testid="semester-note"]').text()).toContain('Answers use 2026-2027 S1 only.')
  })

  it('explains a pinned semester whose files are gone, instead of showing an empty choice', async () => {
    adminGetSettings.mockResolvedValue({
      current_semester: '2024-2025 S1',
      active_semester: '2026-2027 S1',
      semesters: [{ semester: '2026-2027 S1', files: 2 }],
    })
    wrapper.unmount()
    useAdmin().signOut()
    wrapper = mountAdmin()
    await signIn(wrapper)
    await flushPromises()
    expect(wrapper.find('[data-testid="semester-note"]').text()).toContain(
      'Nothing is loaded for 2024-2025 S1 any more, so it is being ignored and answers use 2026-2027 S1.',
    )
  })

  it('lists course aliases, and adds and removes them', async () => {
    const list = wrapper.find('[aria-label="Course aliases"]')
    expect(list.text()).toContain('AI means Artificial Intelligence')

    adminAddAlias.mockResolvedValueOnce({ aliases: [] })
    adminListAliases.mockResolvedValue({ aliases: [{ alias: 'AI', title: 'Artificial Intelligence' }, { alias: 'OS', title: 'Operating Systems' }] })
    await wrapper.find('#alias-name').setValue(' OS ')
    await wrapper.find('#alias-title').setValue('Operating Systems')
    await wrapper.find('#alias-name').element.closest('form').dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(adminAddAlias).toHaveBeenCalledWith({ user: 'admin', pass: 'secret' }, 'OS', 'Operating Systems')
    expect(wrapper.find('[aria-label="Course aliases"]').text()).toContain('OS means Operating Systems')
    expect(wrapper.find('#alias-name').element.value).toBe('')

    adminDeleteAlias.mockResolvedValueOnce({ aliases: [] })
    await wrapper.find('[aria-label="Remove OS"]').trigger('click')
    await flushPromises()
    expect(adminDeleteAlias).toHaveBeenCalledWith({ user: 'admin', pass: 'secret' }, 'OS')
  })

  it('asks for both parts of an alias before calling the server', async () => {
    await wrapper.find('#alias-name').setValue('OS')
    await wrapper.find('#alias-name').element.closest('form').dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(adminAddAlias).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Enter the short name and the full course title it stands for.')
  })

  it('shows the questions that got no answer, with how often they were asked', () => {
    expect(wrapper.find('[data-testid="question-summary"]').text()).toContain('40 questions, 85% answered')
    expect(wrapper.find('[data-testid="question-summary"]').text()).toContain('0.8 AI calls per question')
    expect(wrapper.text()).toContain('when is the os exam')
    expect(wrapper.text()).toContain('Asked 4 times')
    expect(wrapper.text()).toContain('No match')
    expect(wrapper.text()).toContain('Not understood')
  })

  it('shows who changed what', () => {
    expect(wrapper.text()).toContain('awa')
    expect(wrapper.text()).toContain('Uploaded')
    expect(wrapper.text()).toContain('exams.pdf')
    expect(wrapper.text()).toContain('exams, SITC: 73 rows')
  })
})

