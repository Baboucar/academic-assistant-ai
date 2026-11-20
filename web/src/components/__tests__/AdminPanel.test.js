import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AdminPanel from '../AdminPanel.vue'
import { adminListSources, adminDeleteSource } from '../../api.js'

vi.mock('../../api.js', () => ({
  adminListSources: vi.fn(),
  adminUploadFile: vi.fn(),
  adminDeleteSource: vi.fn(),
  adminReingest: vi.fn(),
}))

const SOURCE = {
  type: 'timetable',
  source_file: 'sample-timetable.pdf',
  semester: '2025/26 Semester 2',
  ingested_at: '2026-11-19 10:00:00',
}

async function logIn(wrapper, user, pass) {
  await wrapper.find('input[placeholder="Username"]').setValue(user)
  await wrapper.find('input[type="password"]').setValue(pass)
  await wrapper.find('.login-row button').trigger('click')
  await flushPromises()
}

describe('AdminPanel', () => {
  it('shows an error and no sources when the login fails', async () => {
    adminListSources.mockRejectedValue(new Error('Admin error 401'))
    const wrapper = mount(AdminPanel)

    await logIn(wrapper, 'admin', 'wrong')

    expect(wrapper.find('.error').text()).toBe('Auth failed or server error.')
    expect(wrapper.find('.src-table').exists()).toBe(false)
  })

  it('lists the ingested sources after logging in', async () => {
    adminListSources.mockResolvedValue({ sources: [SOURCE] })
    const wrapper = mount(AdminPanel)

    await logIn(wrapper, 'admin', 'secret')

    expect(adminListSources).toHaveBeenCalledWith({ user: 'admin', pass: 'secret' })
    const cells = wrapper.findAll('.src-table tbody td').map((td) => td.text())
    expect(cells.slice(0, 4)).toEqual(['timetable', 'sample-timetable.pdf', '2025/26 Semester 2', '2026-11-19 10:00:00'])
  })

  it('deletes a source from the database only, then reloads the list', async () => {
    adminListSources.mockResolvedValue({ sources: [SOURCE] })
    adminDeleteSource.mockResolvedValue({ ok: true })
    const wrapper = mount(AdminPanel)
    await logIn(wrapper, 'admin', 'secret')

    const deleteFromDb = wrapper.findAll('.src-table button').find((b) => b.text() === 'Delete (DB)')
    await deleteFromDb.trigger('click')
    await flushPromises()

    expect(adminDeleteSource).toHaveBeenCalledWith({ user: 'admin', pass: 'secret' }, 'sample-timetable.pdf', false)
    expect(adminListSources).toHaveBeenCalledTimes(2)
  })
})
