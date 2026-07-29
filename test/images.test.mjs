import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyImageName, scanImageProjects } from '../src/images.mjs'
import { chooseDeterministically } from '../src/random.mjs'

test('classifies all five supported image prefixes', () => {
  assert.equal(classifyImageName('about-us-16-9-123.png').field.key, 'ap_img')
  assert.equal(classifyImageName('after-sales-1-1-123.jpg').field.key, 'af_img')
  assert.equal(classifyImageName('mobile-hot-products-banner-3-1-123.webp').field.key, 'hp_img')
  assert.equal(classifyImageName('mobile-banner-16-9-123.gif').field.key, 'mo_banner')
  assert.equal(classifyImageName('price-list-9-16-123.jpeg').field.key, 'pt_img')
})

test('rejects unknown prefixes and unsupported extensions', () => {
  assert.equal(classifyImageName('other-123.png').kind, 'unknown')
  assert.equal(classifyImageName('mobile-hot-products-123.png').kind, 'unknown')
  assert.equal(classifyImageName('about-us-123.bmp').kind, 'unsupported')
})

test('seeded selection is stable', () => {
  const files = ['a.png', 'b.png', 'c.png', 'd.png']
  const first = chooseDeterministically(files, 'fixed-seed', 'project:ap_img')
  const second = chooseDeterministically(files, 'fixed-seed', 'project:ap_img')
  assert.equal(first, second)
  assert.ok(files.includes(first))
})

test('scans real directory entries and selects one file per field', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-'))
  const projectDir = path.join(root, '测试项目')
  await mkdir(projectDir)
  const names = [
    'about-us-1.png',
    'after-sales-1.png',
    'mobile-hot-products-banner-1.png',
    'mobile-banner-1.png',
    'price-list-1.png'
  ]
  await Promise.all(names.map((name) => writeFile(path.join(projectDir, name), 'test')))

  try {
    const projects = await scanImageProjects(root, 'seed')
    assert.equal(projects.length, 1)
    assert.equal(projects[0].issues.length, 0)
    assert.deepEqual(Object.keys(projects[0].selected).sort(), [
      'af_img',
      'ap_img',
      'hp_img',
      'mo_banner',
      'pt_img'
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
