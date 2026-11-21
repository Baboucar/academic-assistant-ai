import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('@/api', async (original) => ({
  ...(await original()),
  getHealth: vi.fn(),
  authRegister: vi.fn(),
  authVerify: vi.fn(),
  authResend: vi.fn(),
  authLogin: vi.fn(),
  authForgot: vi.fn(),
  authReset: vi.fn(),
  authLogout: vi.fn(),
  authMe: vi.fn(),
}))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

import { ApiError, authForgot, authLogin, authRegister, authReset, authVerify, getHealth } from '@/api'
import { resetAuthForTests, useAuth } from '@/composables/useAuth'
import { router } from '@/router'
import AuthView from '../AuthView.vue'

const SESSION = { token: 'tok', user: { id: 7, mat_number: '22216000', email: 'awa@utg.edu' } }

async function mountAuth(path = '/login') {
  router.push(path)
  await router.isReady()
  await flushPromises()
  const wrapper = mount(AuthView, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const field = (wrapper, id) => wrapper.find(`#auth-${id}`)
const linkButton = (wrapper, text) => wrapper.findAll('button').find((b) => b.text().includes(text))
async function submit(wrapper) {
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}

let wrapper
beforeEach(async () => {
  localStorage.clear()
  resetAuthForTests()
  await nextTick()
  getHealth.mockResolvedValue({ ok: true, email_domains: ['utg.edu'] })
})
afterEach(() => wrapper?.unmount())

describe('routing', () => {
  it('sends a visitor who is not signed in to the sign-in screen, and back once signed in', async () => {
    router.push('/')
    await router.isReady()
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('login')

    localStorage.setItem('utg-auth-v1', JSON.stringify(SESSION))
    resetAuthForTests()
    await router.push('/login?again=1')
    expect(router.currentRoute.value.name).toBe('chat')
  })
})

describe('AuthView', () => {
  it('signs in with a matriculation number and opens the chat', async () => {
    authLogin.mockResolvedValueOnce(SESSION)
    wrapper = await mountAuth()
    await field(wrapper, 'identifier').setValue(' 22216000 ')
    await field(wrapper, 'password').setValue('correct horse')
    await submit(wrapper)

    expect(authLogin).toHaveBeenCalledWith('22216000', 'correct horse')
    expect(useAuth().user.value.mat_number).toBe('22216000')
    expect(JSON.parse(localStorage.getItem('utg-auth-v1')).token).toBe('tok')
    expect(router.currentRoute.value.name).toBe('chat')
  })

  it('shows why sign-in failed and stays put', async () => {
    authLogin.mockRejectedValueOnce(new ApiError('Wrong email, matriculation number or password.', 401))
    wrapper = await mountAuth()
    await field(wrapper, 'identifier').setValue('awa@utg.edu')
    await field(wrapper, 'password').setValue('nope')
    await submit(wrapper)

    expect(wrapper.find('[role="alert"]').text()).toContain('Wrong email, matriculation number or password.')
    expect(useAuth().isSignedIn.value).toBe(false)
  })

  it('checks the form before calling the server', async () => {
    wrapper = await mountAuth()
    await linkButton(wrapper, 'Create an account').trigger('click')

    await field(wrapper, 'mat').setValue('22216001')
    await field(wrapper, 'email').setValue('someone@gmail.com')
    await field(wrapper, 'password').setValue('long enough')
    await submit(wrapper)
    expect(wrapper.find('[role="alert"]').text()).toContain('@utg.edu')

    await field(wrapper, 'email').setValue('someone@utg.edu')
    await field(wrapper, 'password').setValue('short')
    await submit(wrapper)
    expect(wrapper.find('[role="alert"]').text()).toContain('at least 8 characters')
    expect(authRegister).not.toHaveBeenCalled()
  })

  it('creates an account: details, then the emailed code, then the chat', async () => {
    authRegister.mockResolvedValueOnce({ ok: true, email: 'fatou@utg.edu' })
    authVerify.mockResolvedValueOnce({ token: 'tok2', user: { id: 8, mat_number: '22216001', email: 'fatou@utg.edu' } })
    wrapper = await mountAuth()
    await linkButton(wrapper, 'Create an account').trigger('click')

    await field(wrapper, 'mat').setValue('22216001')
    await field(wrapper, 'email').setValue('Fatou@UTG.edu')
    await field(wrapper, 'password').setValue('correct horse')
    await submit(wrapper)

    expect(authRegister).toHaveBeenCalledWith({ mat_number: '22216001', email: 'fatou@utg.edu', password: 'correct horse' })
    expect(wrapper.text()).toContain('Check your email')
    expect(wrapper.text()).toContain('fatou@utg.edu')
    expect(wrapper.find('[data-testid="dev-code"]').exists()).toBe(false)

    await field(wrapper, 'code').setValue('123 456')
    await submit(wrapper)
    expect(authVerify).toHaveBeenCalledWith('fatou@utg.edu', '123 456')
    expect(router.currentRoute.value.name).toBe('chat')
  })

  it('moves an unconfirmed account to the code step when it signs in', async () => {
    authLogin.mockRejectedValueOnce(new ApiError('Confirm your email first. We sent you a code.', 403, { needs_verification: true, email: 'musa@utg.edu' }))
    wrapper = await mountAuth()
    await field(wrapper, 'identifier').setValue('musa@utg.edu')
    await field(wrapper, 'password').setValue('correct horse')
    await submit(wrapper)

    expect(wrapper.text()).toContain('Check your email')
    expect(wrapper.text()).toContain('musa@utg.edu')
  })

  it('shows the code on screen only when a local test server hands it over', async () => {
    authRegister.mockResolvedValueOnce({ ok: true, email: 'dev@utg.edu', dev_code: '654321' })
    wrapper = await mountAuth()
    await linkButton(wrapper, 'Create an account').trigger('click')
    await field(wrapper, 'mat').setValue('22216002')
    await field(wrapper, 'email').setValue('dev@utg.edu')
    await field(wrapper, 'password').setValue('correct horse')
    await submit(wrapper)

    expect(wrapper.find('[data-testid="dev-code"]').text()).toContain('654321')
  })

  it('resets a forgotten password with an emailed code', async () => {
    authForgot.mockResolvedValueOnce({ ok: true })
    authReset.mockResolvedValueOnce(SESSION)
    wrapper = await mountAuth()
    await linkButton(wrapper, 'Forgot password?').trigger('click')

    await field(wrapper, 'forgot-email').setValue('awa@utg.edu')
    await submit(wrapper)
    expect(authForgot).toHaveBeenCalledWith('awa@utg.edu')
    expect(wrapper.text()).toContain('Choose a new password')

    await field(wrapper, 'code').setValue('111222')
    await field(wrapper, 'password').setValue('brand new pass')
    await submit(wrapper)
    expect(authReset).toHaveBeenCalledWith('awa@utg.edu', '111222', 'brand new pass')
    expect(router.currentRoute.value.name).toBe('chat')
  })
})
