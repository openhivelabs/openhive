import { describe, expect, it } from 'vitest'
import { PYTHON_COLD_START_FLAGS } from './runner'

describe('PYTHON_COLD_START_FLAGS', () => {
  it('includes frozen_modules=on for faster stdlib import', () => {
    expect(PYTHON_COLD_START_FLAGS).toContain('-X')
    expect(PYTHON_COLD_START_FLAGS).toContain('frozen_modules=on')
  })

  it('-X flag precedes its argument', () => {
    const i = PYTHON_COLD_START_FLAGS.indexOf('-X')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(PYTHON_COLD_START_FLAGS[i + 1]).toBe('frozen_modules=on')
  })
})
