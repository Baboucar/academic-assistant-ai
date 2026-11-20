import { describe, it, expect, beforeEach } from 'vitest'
import { h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import App from '../App.vue'

async function mountApp() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'chat', component: { render: () => h('div', 'chat') } },
      { path: '/admin', name: 'admin', component: { render: () => h('div', 'admin') } },
    ],
  })
  router.push('/')
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('App theme toggle', () => {
  it('switches to dark mode and remembers the choice', async () => {
    const wrapper = await mountApp()
    const toggle = wrapper.find('.theme-toggle')
    expect(toggle.text()).toBe('Dark Mode')

    await toggle.trigger('click')

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(toggle.text()).toBe('Light Mode')
  })

  it('restores the saved theme on load', async () => {
    localStorage.setItem('theme', 'dark')

    const wrapper = await mountApp()

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(wrapper.find('.theme-toggle').text()).toBe('Light Mode')
  })

  it('links to the chat and the admin page', async () => {
    const wrapper = await mountApp()

    const links = wrapper.findAll('a').map((a) => a.attributes('href'))
    expect(links).toEqual(expect.arrayContaining(['/', '/admin']))
  })
})
