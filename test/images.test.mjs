import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyImageName, scanImageProjects } from '../src/images.mjs'
import { chooseDeterministically } from '../src/random.mjs'

test('classifies the original image prefixes by ratio', () => {
  assert.equal(classifyImageName('about-us-16-9-123.png').field.key, 'ap_img')
  assert.equal(classifyImageName('after-sales-1-1-123.jpg').field.key, 'af_img')
  assert.equal(classifyImageName('mobile-hot-products-banner-3-1-123.webp').field.key, 'hp_img')
  assert.equal(classifyImageName('mobile-banner-16-9-123.gif').field.key, 'mo_banner')
  assert.equal(classifyImageName('price-list-9-16-123.jpeg').field.key, 'pt_img')
})

test('classifies all fifteen new 3:1 image categories', () => {
  const keys = [
    'hot-products', 'new-products', 'all-products', 'products', 'about-us', 'after-sales',
    'agentcy', 'catalog', 'contact-us', 'faq', 'home', 'oem', 'order-terms', 'price-list', 'quality-control'
  ]
  for (const key of keys) {
    assert.equal(classifyImageName(`${key}-3-1-123.png`).field.key, key)
  }
})

test('rejects unknown prefixes and unsupported extensions', () => {
  assert.equal(classifyImageName('other-123.png').kind, 'unknown')
  assert.equal(classifyImageName('mobile-hot-products-123.png').kind, 'unknown')
  assert.equal(classifyImageName('about-us-16-9-123.bmp').kind, 'unsupported')
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
    'about-us-16-9-1.png',
    'after-sales-1-1-1.png',
    'mobile-hot-products-banner-3-1-1.png',
    'mobile-banner-16-9-1.png',
    'price-list-9-16-1.png'
  ]
  await Promise.all(names.map((name) => writeFile(path.join(projectDir, name), 'test')))

  try {
    const projects = await scanImageProjects(root, 'seed')
    assert.equal(projects.length, 1)
    assert.equal(projects[0].issues.length, 0)
    assert.equal(Object.keys(projects[0].selected).length, 20)
    assert.equal(projects[0].selected['hot-products'], null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows an imported project list to load before the image root is selected', async () => {
  const missingRoot = path.join(os.tmpdir(), `auto-publisher-missing-root-${Date.now()}`)
  const projects = await scanImageProjects(missingRoot, 'seed', ['about-us'], {
    allowMissingRoot: true
  })
  assert.deepEqual(projects, [])
})

test('only requires image categories selected for the current plan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-fields-'))
  const projectDir = path.join(root, '测试项目')
  await mkdir(projectDir)
  await writeFile(path.join(projectDir, 'about-us-16-9-1.png'), 'test')

  try {
    const [project] = await scanImageProjects(root, 'seed', ['ap_img'])
    assert.deepEqual(project.issues, [])
    assert.equal(path.basename(project.selected.ap_img), 'about-us-16-9-1.png')
    assert.equal(project.selected.af_img, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('records a missing selected category without making the project invalid', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-missing-image-'))
  const projectDir = path.join(root, '测试项目')
  await mkdir(projectDir)

  try {
    const [project] = await scanImageProjects(root, 'seed', ['ap_img'])
    assert.deepEqual(project.issues, [])
    assert.equal(project.selected.ap_img, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores unsupported files that belong to an unselected category', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-ignored-field-'))
  const projectDir = path.join(root, '测试项目')
  await mkdir(projectDir)
  await Promise.all([
    writeFile(path.join(projectDir, 'about-us-16-9-1.png'), 'test'),
    writeFile(path.join(projectDir, 'after-sales-1-1-1.bmp'), 'test')
  ])

  try {
    const [project] = await scanImageProjects(root, 'seed', ['ap_img'])
    assert.deepEqual(project.issues, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ignores files outside the configured image categories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-extra-files-'))
  const projectDir = path.join(root, '测试项目')
  await mkdir(projectDir)
  await Promise.all([
    writeFile(path.join(projectDir, 'hot-products-3-1-1.png'), 'test'),
    writeFile(path.join(projectDir, 'unconfigured-3-1-1.png'), 'test')
  ])

  try {
    const [project] = await scanImageProjects(root, 'seed', ['hot-products'])
    assert.deepEqual(project.issues, [])
    assert.equal(path.basename(project.selected['hot-products']), 'hot-products-3-1-1.png')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows missing optional categories and selects one of one or more images', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-new-fields-'))
  const projectDir = path.join(root, '测试项目')
  await mkdir(projectDir)
  await Promise.all([
    writeFile(path.join(projectDir, 'hot-products-3-1-100.png'), 'test'),
    writeFile(path.join(projectDir, 'new-products-3-1-100.png'), 'test'),
    writeFile(path.join(projectDir, 'new-products-3-1-200.png'), 'test')
  ])

  try {
    const [project] = await scanImageProjects(root, 'seed', [
      'hot-products', 'new-products', 'quality-control'
    ])
    assert.deepEqual(project.issues, [])
    assert.equal(path.basename(project.selected['hot-products']), 'hot-products-3-1-100.png')
    assert.ok([
      'new-products-3-1-100.png',
      'new-products-3-1-200.png'
    ].includes(path.basename(project.selected['new-products'])))
    assert.equal(project.selected['quality-control'], null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
