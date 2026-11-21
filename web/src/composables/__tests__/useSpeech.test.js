import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useSpeechRecognition, useSpeechSynthesis } from '../useSpeech.js'

/** Minimal stand-in for the browser's SpeechRecognition. */
class FakeRecognition {
  static last = null
  constructor() { FakeRecognition.last = this }
  start() { this.started = true }
  stop() { this.onend?.() }
  // helpers for the tests
  hear(...parts) {
    this.onresult?.({ results: parts.map((transcript) => [{ transcript }]) })
  }
  finish() { this.onend?.() }
  fail(error) { this.onerror?.({ error }); this.onend?.() }
}

/** Run a composable inside a component so lifecycle hooks work. */
function withSetup(composable) {
  let result
  const wrapper = mount(defineComponent({
    setup() { result = composable(); return () => h('div') },
  }))
  return [result, wrapper]
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
})

describe('useSpeechRecognition', () => {
  it('reports unsupported when the browser has no speech recognition', () => {
    const [voice] = withSetup(() => useSpeechRecognition())
    expect(voice.supported).toBe(false)
    voice.start() // must not throw
    expect(voice.listening.value).toBe(false)
  })

  describe('when supported', () => {
    let handlers
    beforeEach(() => {
      window.webkitSpeechRecognition = FakeRecognition
      handlers = { onResult: vi.fn(), onFinal: vi.fn(), onError: vi.fn() }
    })

    it('streams what it hears, then fires onFinal when the speaker stops', () => {
      const [voice] = withSetup(() => useSpeechRecognition(handlers))
      voice.start()
      expect(voice.listening.value).toBe(true)

      FakeRecognition.last.hear('who teaches ')
      FakeRecognition.last.hear('who teaches ', 'AI')
      expect(handlers.onResult).toHaveBeenLastCalledWith('who teaches AI')

      FakeRecognition.last.finish()
      expect(voice.listening.value).toBe(false)
      expect(handlers.onFinal).toHaveBeenCalledExactlyOnceWith('who teaches AI')
    })

    it('stop() keeps the words but does not send them', () => {
      const [voice] = withSetup(() => useSpeechRecognition(handlers))
      voice.start()
      FakeRecognition.last.hear('who teach')
      voice.stop()

      expect(voice.listening.value).toBe(false)
      expect(handlers.onFinal).not.toHaveBeenCalled()
    })

    it('does not send anything if nothing was heard', () => {
      const [voice] = withSetup(() => useSpeechRecognition(handlers))
      voice.start()
      FakeRecognition.last.fail('no-speech')
      expect(handlers.onFinal).not.toHaveBeenCalled()
      expect(handlers.onError).not.toHaveBeenCalled()
    })

    it('explains a blocked microphone and does not send', () => {
      const [voice] = withSetup(() => useSpeechRecognition(handlers))
      voice.start()
      FakeRecognition.last.hear('partial')
      FakeRecognition.last.fail('not-allowed')

      expect(handlers.onError).toHaveBeenCalledWith(expect.stringMatching(/microphone access is blocked/i))
      expect(handlers.onFinal).not.toHaveBeenCalled()
    })

    it('stops listening when the component goes away', () => {
      const [voice, wrapper] = withSetup(() => useSpeechRecognition(handlers))
      voice.start()
      wrapper.unmount()
      expect(voice.listening.value).toBe(false)
    })
  })
})

describe('useSpeechSynthesis', () => {
  let spoken
  beforeEach(() => {
    spoken = []
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
    window.speechSynthesis = {
      speak: vi.fn((u) => spoken.push(u)),
      cancel: vi.fn(),
    }
  })
  afterEach(() => {
    useSpeechSynthesis().stop()
    delete window.speechSynthesis
    delete window.SpeechSynthesisUtterance
  })

  it('reads the answer without Markdown symbols', () => {
    const speech = useSpeechSynthesis()
    speech.speak('m1', '- **Artificial Intelligence** at `08:30`')
    expect(spoken[0].text).toBe('Artificial Intelligence at 08:30')
    expect(speech.speakingId.value).toBe('m1')
  })

  it('toggle() stops the message that is being read', () => {
    const speech = useSpeechSynthesis()
    speech.toggle('m1', 'Hello')
    speech.toggle('m1', 'Hello')
    expect(window.speechSynthesis.cancel).toHaveBeenCalled()
    expect(speech.speakingId.value).toBeNull()
  })

  it('switching to another message replaces the first', () => {
    const speech = useSpeechSynthesis()
    speech.toggle('m1', 'First')
    speech.toggle('m2', 'Second')
    expect(speech.speakingId.value).toBe('m2')
    // the first utterance ending late must not clear the second
    spoken[0].onend()
    expect(speech.speakingId.value).toBe('m2')
    spoken[1].onend()
    expect(speech.speakingId.value).toBeNull()
  })
})
