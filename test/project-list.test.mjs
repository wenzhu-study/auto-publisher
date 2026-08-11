import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isLocalProjectUrl,
  matchImportedProjects,
  normalizeProjectUrl,
  parseProjectList
} from '../src/project-list.mjs'

test('parses Chinese project TXT lines and reports malformed or duplicate rows', () => {
  const parsed = parseProjectList(`\uFEFF宝石：https://www.china-gemstone.com/\n宠物玩具: https://www.china-pettoy.com/\n宝石副本：https://china-gemstone.com\n格式错误`)
  assert.deepEqual(parsed.entries.map((entry) => entry.name), ['宝石', '宠物玩具'])
  assert.equal(parsed.summary.parsed, 2)
  assert.equal(parsed.summary.duplicates, 1)
  assert.equal(parsed.summary.invalidLines, 1)
  assert.match(parsed.issues.join('；'), /重复/)
  assert.match(parsed.issues.join('；'), /格式无效/)
  assert.equal(normalizeProjectUrl('http://WWW.Example.com/path/'), 'example.com/path')
})

test('matches imported projects by name and URL while preserving TXT order', () => {
  const imageProjects = [
    imageProject('宝石'),
    imageProject('宠物玩具'),
    imageProject('别名文件夹')
  ]
  const keyHubProjects = [
    credential('1', '宝石', 'https://www.china-gemstone.com/'),
    credential('2', '宠物玩具', 'https://www.china-pettoy.com/'),
    credential('3', '真实项目名', 'https://www.renamed-project.com/')
  ]
  const text = [
    '宠物玩具：https://china-pettoy.com',
    '清单中的旧名称：https://www.renamed-project.com/',
    '宝石：https://www.china-gemstone.com/'
  ].join('\n')
  const result = matchImportedProjects(
    imageProjects,
    keyHubProjects,
    { 别名文件夹: '真实项目名' },
    text,
    ['hot-products']
  )

  assert.deepEqual(result.projects.map((project) => project.folderName), [
    '宠物玩具', '别名文件夹', '宝石'
  ])
  assert.deepEqual(result.projects.map((project) => project.project.name), [
    '宠物玩具', '真实项目名', '宝石'
  ])
  assert.deepEqual(result.projects.map((project) => project.importOrder), [1, 2, 3])
  assert.equal(result.summary.matched, 3)
})

test('keeps unmatched imported rows as non-executable project records', () => {
  const result = matchImportedProjects(
    [imageProject('宝石')],
    [credential('1', '宝石', 'https://www.china-gemstone.com/')],
    {},
    '宝石：https://wrong.example.com/\n没有素材：https://missing.example.com/',
    ['home', 'about-us']
  )

  assert.equal(result.projects.length, 2)
  assert.match(result.projects[0].matchError, /网址不一致/)
  assert.match(result.projects[1].matchError, /KeyHub 中找不到项目/)
  assert.equal(result.projects[1].groups.home.length, 0)
  assert.equal(result.projects[1].selected['about-us'], null)
  assert.equal(result.summary.unmatched, 2)
})

test('preserves ports while normalizing local project URLs', () => {
  assert.equal(normalizeProjectUrl('http://192.168.1.102:8088/'), '192.168.1.102:8088/')
  assert.equal(normalizeProjectUrl('http://192.168.1.102:8089/'), '192.168.1.102:8089/')
  assert.equal(isLocalProjectUrl('http://192.168.1.102:8088/'), true)
  assert.equal(isLocalProjectUrl('http://localhost:8088/'), true)
  assert.equal(isLocalProjectUrl('https://example.com/'), false)
})

test('uses a unique project name when KeyHub projects share a local URL', () => {
  const localUrl = 'http://192.168.1.102:8088/'
  const result = matchImportedProjects(
    [imageProject('fertilizer')],
    [
      credential('1', 'fertilizer', localUrl),
      credential('2', 'hardware', localUrl)
    ],
    {},
    `fertilizer: ${localUrl}`,
    ['home']
  )

  assert.equal(result.summary.matched, 1)
  assert.equal(result.projects[0].matchError, '')
  assert.equal(result.projects[0].project.id, '1')
  assert.equal(result.projects[0].project.url, localUrl)
})

test('uses a unique project name to disambiguate duplicate public URLs', () => {
  const publicUrl = 'https://www.china-t-shirts.com/'
  const result = matchImportedProjects(
    [imageProject('T恤')],
    [
      credential('1', 'tshirt', publicUrl),
      credential('2', 'T恤', 'https://www.china-t-shirts.com')
    ],
    {},
    'T恤：https://www.china-t-shirts.com',
    ['home']
  )

  assert.equal(result.summary.matched, 1)
  assert.equal(result.projects[0].matchError, '')
  assert.equal(result.projects[0].project.id, '2')
  assert.equal(result.projects[0].project.name, 'T恤')
})

test('uses the TXT local URL as the upload target while retaining KeyHub credentials', () => {
  const localUrl = 'http://10.0.0.25:8088/'
  const result = matchImportedProjects(
    [imageProject('fertilizer')],
    [credential('1', 'fertilizer', 'https://fertilizer.example.com/')],
    {},
    `fertilizer: ${localUrl}`,
    ['home']
  )

  assert.equal(result.summary.matched, 1)
  assert.equal(result.projects[0].project.url, localUrl)
  assert.equal(result.projects[0].project.username, 'shop')
  assert.equal(result.projects[0].project.appPassword, 'secret')
})

function imageProject(folderName) {
  return { folderName, groups: { 'hot-products': [] }, selected: { 'hot-products': null }, issues: [] }
}

function credential(id, name, url) {
  return { id, name, url, username: 'shop', appPassword: 'secret' }
}
