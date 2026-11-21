import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('@/api', () => ({
  adminListSources: vi.fn(),
  adminUploadFile: vi.fn(),
  adminDeleteSource: vi.fn(),
  adminReingest: vi.fn(),
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
      { type: 'timetable', semester: '2026 S1', dept: 'law', reingest: true },
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
