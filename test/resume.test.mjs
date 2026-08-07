import assert from 'node:assert/strict'
import test from 'node:test'
import { buildResumeState } from '../src/resume.mjs'

test('resumes unfinished projects and retries only their unsuccessful image fields', () => {
  const resume = buildResumeState({
    mode: 'upload',
    status: 'cancelled',
    seed: 'fixed-seed',
    projectText: '项目一：https://example.test/',
    projectListName: 'projects.txt',
    plan: [
      { folderName: '项目一', processFields: ['ap_img', 'pt_img'] },
      { folderName: '项目二', processFields: ['ap_img', 'pt_img'] },
      { folderName: '项目三', processFields: ['ap_img', 'pt_img'] }
    ],
    results: [
      { folderName: '项目一', status: 'completed' },
      {
        folderName: '项目二',
        status: 'failed',
        imageResults: {
          ap_img: { field: 'ap_img', status: 'succeeded' },
          pt_img: { field: 'pt_img', status: 'write-failed' }
        }
      }
    ]
  }, 'cancelled.json')

  assert.equal(resume.seed, 'fixed-seed')
  assert.equal(resume.projectText, '项目一：https://example.test/')
  assert.equal(resume.projectListName, 'projects.txt')
  assert.deepEqual(resume.processedFolders, ['项目一'])
  assert.deepEqual(resume.remainingFolders, ['项目二', '项目三'])
  assert.deepEqual(resume.retryFieldsByFolder, { 项目二: ['pt_img'] })
  assert.deepEqual(resume.selectedFields, ['ap_img', 'pt_img'])
  assert.equal(resume.retryProjects, 1)
})

test('does not offer completed runs or active running checkpoints for resume', () => {
  const report = {
    mode: 'upload',
    status: 'completed',
    plan: [{ folderName: '项目一' }],
    results: []
  }
  assert.equal(buildResumeState(report), null)
  assert.equal(buildResumeState({ ...report, status: 'running' }, '', { allowRunning: false }), null)
  assert.deepEqual(
    buildResumeState({ ...report, status: 'running' }, '', { allowRunning: true }).remainingFolders,
    ['项目一']
  )
})
