import { describe, expect, it } from 'vitest'
import { mdToHtml, mdToPlain } from '../markdown.js'

describe('mdToHtml', () => {
  it('escapes HTML so model output cannot inject markup', () => {
    const html = mdToHtml('<img src=x onerror="alert(1)"> **<script>bold</script>**')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img')
    expect(html).toContain('<strong>&lt;script&gt;bold&lt;/script&gt;</strong>')
  })

  it('renders bold, italics and inline code', () => {
    expect(mdToHtml('**Artificial Intelligence** at *08:30* in `Lab 2`'))
      .toBe('<p><strong>Artificial Intelligence</strong> at <em>08:30</em> in <code>Lab 2</code></p>')
  })

  it('groups consecutive bullets into one list', () => {
    expect(mdToHtml('Two classes:\n\n- **AI** on Mon\n- **OS** on Mon\n\nThat is all.'))
      .toBe('<p>Two classes:</p><ul><li><strong>AI</strong> on Mon</li><li><strong>OS</strong> on Mon</li></ul><p>That is all.</p>')
  })

  it('renders numbered lists and headings', () => {
    expect(mdToHtml('### Monday\n1. AI\n2. OS')).toBe('<h5>Monday</h5><ol><li>AI</li><li>OS</li></ol>')
  })

  it('leaves a lone asterisk alone (half-streamed bold)', () => {
    expect(mdToHtml('**Artif')).toBe('<p>**Artif</p>')
    expect(mdToHtml('5 * 3 = 15')).toBe('<p>5 * 3 = 15</p>')
  })

  it('handles empty input', () => {
    expect(mdToHtml('')).toBe('')
    expect(mdToHtml(null)).toBe('')
  })
})

describe('mdToPlain', () => {
  it('strips formatting for copying and reading aloud', () => {
    expect(mdToPlain('### Monday\n- **AI** at *08:30* in `Lab 2`')).toBe('Monday\nAI at 08:30 in Lab 2')
  })
})
