import assert from 'node:assert/strict'
import test from 'node:test'
import { matchImageProjects, normalizeProjectName } from '../src/projects.mjs'

const credential = { id: '1', url: 'https://example.com', username: 'shop', appPassword: 'secret' }

test('normalizes copy suffixes without altering the base name', () => {
  assert.equal(normalizeProjectName('酱油(copy)'), '酱油')
  assert.equal(normalizeProjectName('酱油（副本）'), '酱油')
  assert.equal(normalizeProjectName('宠物玩具'), '宠物玩具')
})

test('prefers exact project match and supports normalized copy folder', () => {
  const images = [
    { folderName: '宠物玩具', issues: [] },
    { folderName: '酱油(copy)', issues: [] }
  ]
  const projects = [
    { ...credential, name: '宠物玩具' },
    { ...credential, id: '2', name: '酱油' }
  ]
  const matched = matchImageProjects(images, projects)
  assert.equal(matched[0].project.name, '宠物玩具')
  assert.equal(matched[1].project.name, '酱油')
  assert.equal(matched[1].matchError, '')
})

test('reports missing and ambiguous matches', () => {
  const images = [{ folderName: '不存在', issues: [] }]
  const missing = matchImageProjects(images, [{ ...credential, name: '项目 A' }])
  assert.match(missing[0].matchError, /找不到/)

  const ambiguous = matchImageProjects(
    [{ folderName: '酱油(copy)', issues: [] }],
    [{ ...credential, name: '酱油' }, { ...credential, id: '2', name: '酱油(copy)' }]
  )
  assert.equal(ambiguous[0].project.name, '酱油(copy)')
})
