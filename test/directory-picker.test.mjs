import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveBrowserSelectedDirectory } from '../src/directory-picker.mjs'

test('locates a selected image root nested below a known local directory', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-picker-'))
  const selected = path.join(base, 'mobile-baaner', '1')
  const project = path.join(selected, '折叠帐篷')
  const decoy = path.join(base, 'other', '1')
  await Promise.all([mkdir(project, { recursive: true }), mkdir(decoy, { recursive: true })])
  await writeFile(path.join(project, 'mobile-banner-16-9-594157.png'), 'image')

  try {
    const result = await resolveBrowserSelectedDirectory('1', [
      '1/折叠帐篷/mobile-banner-16-9-594157.png'
    ], {
      candidateBases: [base],
      searchBases: [base],
      maxDepth: 2
    })
    assert.equal(result, selected)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('prefers a directly known selected image root', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-picker-direct-'))
  const selected = path.join(base, '图片1')
  const project = path.join(selected, '测试项目')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'about-us-3-1-1.png'), 'image')

  try {
    const result = await resolveBrowserSelectedDirectory('图片1', [
      '图片1/测试项目/about-us-3-1-1.png'
    ], { candidateBases: [selected], searchBases: [] })
    assert.equal(result, selected)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
