import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SkillDef } from './loader'
import { parseFinalJsonLine, runSkillScript } from './runner'

describe('parseFinalJsonLine', () => {
  it('returns undefined for non-JSON stdout (backwards compat)', () => {
    expect(parseFinalJsonLine('hello world')).toBeUndefined()
    expect(parseFinalJsonLine('')).toBeUndefined()
    expect(parseFinalJsonLine('{"not ok"}')).toBeUndefined()
  })

  it('returns envelope for final ok:true line even with chatter above', () => {
    const stdout = [
      'doing stuff',
      'more stuff',
      JSON.stringify({ ok: true, files: [], warnings: [] }),
    ].join('\n')
    const parsed = parseFinalJsonLine(stdout)
    expect(parsed?.ok).toBe(true)
  })

  it('skips trailing truncate marker to find envelope', () => {
    const stdout = [
      JSON.stringify({ ok: false, error_code: 'x', message: 'm' }),
      '…[truncated, 100 more bytes]',
    ].join('\n')
    const parsed = parseFinalJsonLine(stdout)
    expect(parsed?.ok).toBe(false)
    expect(parsed?.error_code).toBe('x')
  })
})

describe('runSkillScript structured envelope integration', () => {
  let tmp: string
  let skillDir: string
  let outputDir: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-runner-test-'))
    skillDir = path.join(tmp, 'skill')
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true })
    outputDir = path.join(tmp, 'out')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function makeSkill(): SkillDef {
    return {
      kind: 'agent',
      name: 'test-skill',
      description: 'test',
      source: 'user',
      skillDir,
    } as SkillDef
  }

  it('passes through {ok:false} envelope verbatim and marks result not ok', async () => {
    const script = path.join(skillDir, 'scripts', 'fail.py')
    fs.writeFileSync(
      script,
      [
        'import json, sys',
        'print("some noise")',
        'print(json.dumps({"ok": False, "error_code": "bad_spec", "message": "boom", "suggestion": "fix it"}))',
        'sys.exit(1)',
      ].join('\n'),
    )
    const result = await runSkillScript(makeSkill(), 'scripts/fail.py', outputDir)
    expect(result.ok).toBe(false)
    expect(result.structured).toBeDefined()
    expect(result.structured?.ok).toBe(false)
    expect(result.structured?.error_code).toBe('bad_spec')
    expect(result.structured?.suggestion).toBe('fix it')
  })

  it('prefers envelope files over directory snapshot on success', async () => {
    const declared = path.join(outputDir, 'declared.pdf')
    const sneaky = path.join(outputDir, 'sneaky.tmp')
    const script = path.join(skillDir, 'scripts', 'ok.py')
    fs.writeFileSync(
      script,
      [
        'import json, os, sys',
        'out = os.environ["OPENHIVE_OUTPUT_DIR"]',
        'os.makedirs(out, exist_ok=True)',
        // Two files on disk, but only one declared in the envelope.
        `open(os.path.join(out, "declared.pdf"), "wb").write(b"x" * 500)`,
        `open(os.path.join(out, "sneaky.tmp"), "wb").write(b"junk")`,
        'print(json.dumps({',
        '    "ok": True,',
        '    "files": [{"name": "declared.pdf", "path": os.path.join(out, "declared.pdf"), "mime": "application/pdf"}],',
        '    "warnings": [],',
        '}))',
      ].join('\n'),
    )
    const result = await runSkillScript(makeSkill(), 'scripts/ok.py', outputDir)
    expect(result.ok).toBe(true)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.name).toBe('declared.pdf')
    expect(result.files[0]?.path).toBe(declared)
    expect(result.files[0]?.mime).toBe('application/pdf')
    // sanity: sneaky file exists on disk but is NOT in registered files
    expect(fs.existsSync(sneaky)).toBe(true)
    expect(result.files.some((f) => f.path === sneaky)).toBe(false)
  })
})
