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
import { adminListSources, adminUploadFile } from '@/api'
import { useAdmin } from '@/composables/useAdmin'
import UploadCard from '../UploadCard.vue'

const file = (name, size = 1024) => {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: size })
  return f
}

async function pick(wrapper, f) {
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [f], configurable: true })
  await input.trigger('change')
}

const uploadButton = (wrapper) => wrapper.find('button[type="submit"]')

let wrapper
beforeEach(async () => {
  adminListSources.mockResolvedValue({ sources: [], counts: {} })
  await useAdmin().signIn('admin', 'secret')
  wrapper = mount(UploadCard, { attachTo: document.body })
})
afterEach(() => wrapper.unmount())

describe('UploadCard', () => {
  it('cannot upload until a file is chosen', () => {
    expect(uploadButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('rejects unsupported file types with a reason', async () => {
    await pick(wrapper, file('timetable.png'))
    expect(wrapper.find('[role="alert"]').text()).toContain('That file type is not supported')
    expect(uploadButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('rejects files over the size limit', async () => {
    await pick(wrapper, file('huge.pdf', 30 * 1024 * 1024))
    expect(wrapper.find('[role="alert"]').text()).toContain('The limit is 25 MB')
  })

  it('shows the chosen file and uploads it with the form values', async () => {
    adminUploadFile.mockResolvedValueOnce({ ok: true, file: 'cs.xlsx', ingest: { ok: true, log: '' } })
    const chosen = file('cs.xlsx', 20480)
    await pick(wrapper, chosen)
    expect(wrapper.text()).toContain('cs.xlsx')
    expect(wrapper.text()).toContain('20 KB')

    await wrapper.find('#upload-semester').setValue(' 2026 S1 ')
    await wrapper.find('#upload-dept').setValue(' law ')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(adminUploadFile).toHaveBeenCalledWith(
      { user: 'admin', pass: 'secret' },
      chosen,
      { type: 'timetable', semester: '2026 S1', dept: 'law', reingest: true, force: false },
    )
    expect(toast.success).toHaveBeenCalledWith('Uploaded and ingested cs.xlsx')
    // ready for the next file
    expect(uploadButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('shows how many rows were read and what the reader noted', async () => {
    adminUploadFile.mockResolvedValueOnce({
      ok: true,
      file: 'exams.pdf',
      ingest: {
        ok: true,
        log: [
          'Exam timetable PDF: exams.pdf -> +73',
          '  note: Page 5: "Tuesday 8th December 2025" was read as 2026.',
          '  note: Page 12: "Wireless Networks" (no. 73) has no course code in the file.',
          'Ingestion complete -> tmp/utg.db',
        ].join('\n'),
      },
    })
    await pick(wrapper, file('exams.pdf'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const result = wrapper.find('[data-testid="upload-result"]')
    expect(result.text()).toContain('exams.pdf: 73 rows read')
    expect(result.findAll('li').map((li) => li.text())).toEqual([
      'Page 5: "Tuesday 8th December 2025" was read as 2026.',
      'Page 12: "Wireless Networks" (no. 73) has no course code in the file.',
    ])
    expect(toast.success).toHaveBeenCalledWith('Uploaded and ingested exams.pdf')
  })

  it('warns instead of celebrating when nothing could be read from the file', async () => {
    toast.success.mockClear()
    adminUploadFile.mockResolvedValueOnce({
      ok: true,
      file: 'renamed-columns.xlsx',
      ingest: { ok: true, log: 'Excel: renamed-columns.xlsx -> +0\nIngestion complete -> tmp/utg.db' },
    })
    await pick(wrapper, file('renamed-columns.xlsx'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(toast.warning).toHaveBeenCalledWith('Uploaded renamed-columns.xlsx, but nothing could be read from it', expect.anything())
    expect(toast.success).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="upload-result"]').text()).toContain('nothing could be read')
  })

  it('when the server keeps the old version, says why and offers to replace anyway', async () => {
    adminUploadFile.mockResolvedValueOnce({
      ok: false,
      file: 'cs.xlsx',
      rows: 12,
      kept_previous: true,
      ingest: { ok: false, refused: true, log: 'Refused: cs.xlsx -> kept the 12 row(s) already loaded: this version of the file gives 0. Check the file (renamed columns? wrong type?), or replace anyway.' },
    })
    const chosen = file('cs.xlsx')
    await pick(wrapper, chosen)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const result = wrapper.find('[data-testid="upload-result"]')
    expect(result.text()).toContain('cs.xlsx was not replaced')
    expect(result.text()).toContain('kept the 12 row(s) already loaded: this version of the file gives 0')
    expect(toast.warning).toHaveBeenCalledWith('cs.xlsx was not replaced', expect.anything())
    // the file is still selected, so it can be sent again
    expect(wrapper.text()).toContain('cs.xlsx')

    adminUploadFile.mockResolvedValueOnce({ ok: true, file: 'cs.xlsx', rows: 0, ingest: { ok: true, log: 'Excel: cs.xlsx -> +0' } })
    await result.findAll('button').find((b) => b.text().includes('Replace anyway')).trigger('click')
    await flushPromises()
    expect(adminUploadFile.mock.calls.at(-1)[1]).toBe(chosen)
    expect(adminUploadFile.mock.calls.at(-1)[2].force).toBe(true)
  })

  it('withdraws "Replace anyway" when a different file is chosen, so the wrong file is never forced', async () => {
    adminUploadFile.mockResolvedValueOnce({
      ok: false, file: 'cs.xlsx', rows: 12, kept_previous: true,
      ingest: { ok: false, refused: true, log: 'Refused: cs.xlsx -> kept the 12 row(s) already loaded: this version of the file gives 0.' },
    })
    await pick(wrapper, file('cs.xlsx'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="upload-result"]').text()).toContain('The server kept the 12 row(s) already loaded')

    await pick(wrapper, file('ins.xlsx'))
    await flushPromises()
    expect(wrapper.find('[data-testid="upload-result"]').exists()).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text().includes('Replace anyway'))).toBe(false)
  })

  it('does not offer to force a file the server could not read at all', async () => {
    adminUploadFile.mockResolvedValueOnce({
      ok: false, file: 'cs.xlsx', rows: 12, kept_previous: true,
      ingest: { ok: false, refused: false, log: 'Failed: cs.xlsx -> not a spreadsheet' },
    })
    await pick(wrapper, file('cs.xlsx'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const result = wrapper.find('[data-testid="upload-result"]')
    expect(result.text()).toContain('The new version could not be read, so the one already loaded was kept.')
    expect(result.text()).not.toContain('The server The')
    expect(result.findAll('button')).toHaveLength(0)
  })

  it('starts each new file from its own type, not the previous file\'s', async () => {
    await pick(wrapper, file('final-exams.pdf'))
    adminUploadFile.mockResolvedValueOnce({ ok: true, file: 'final-exams.pdf', ingest: null })
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(adminUploadFile.mock.calls.at(-1)[2].type).toBe('exams')

    await pick(wrapper, file('cs-classes.pdf'))
    adminUploadFile.mockResolvedValueOnce({ ok: true, file: 'cs-classes.pdf', ingest: null })
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(adminUploadFile.mock.calls.at(-1)[2].type).toBe('timetable')
  })

  it('picks the only type a Word file can be', async () => {
    adminUploadFile.mockResolvedValueOnce({ ok: true, file: 'notice.docx', ingest: null })
    await pick(wrapper, file('notice.docx'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(adminUploadFile.mock.calls[0][2].type).toBe('notices')
  })

  it('guesses "calendar" for a PDF named like one', async () => {
    adminUploadFile.mockResolvedValueOnce({ ok: true, file: 'academic-calendar.pdf', ingest: null })
    await pick(wrapper, file('Academic-Calendar.pdf'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(adminUploadFile.mock.calls[0][2].type).toBe('calendar')
  })

  it('warns when the file uploaded but could not be read', async () => {
    adminUploadFile.mockResolvedValueOnce({
      ok: false,
      file: 'broken.pdf',
      ingest: { ok: false, log: 'Failed: broken.pdf -> Invalid PDF structure' },
    })
    await pick(wrapper, file('broken.pdf'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(toast.error).toHaveBeenCalledWith(
      'Uploaded broken.pdf, but it could not be read',
      expect.objectContaining({ description: 'Failed: broken.pdf -> Invalid PDF structure' }),
    )
  })

  it('keeps the file selected and shows the reason when the upload fails', async () => {
    adminUploadFile.mockRejectedValueOnce(Object.assign(new Error('File is too large'), { status: 413 }))
    await pick(wrapper, file('cs.xlsx'))
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toContain('File is too large')
    expect(wrapper.text()).toContain('cs.xlsx')
    expect(uploadButton(wrapper).attributes('disabled')).toBeUndefined()
  })
})
