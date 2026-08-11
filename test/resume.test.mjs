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
  assert.equal(resume.sourceStatus, 'cancelled')
  assert.deepEqual(resume.processedFolders, ['项目一'])
  assert.deepEqual(resume.remainingFolders, ['项目二', '项目三'])
  assert.deepEqual(resume.retryFieldsByFolder, { 项目二: ['pt_img'] })
  assert.deepEqual(resume.selectedFields, ['ap_img', 'pt_img'])
  assert.equal(resume.retryProjects, 1)
})

test('offers completed runs only when image fields still need repair', () => {
  const report = {
    mode: 'upload',
    status: 'completed',
    plan: [
      { folderName: '项目一', processFields: ['ap_img', 'pt_img'] },
      { folderName: '项目二', processFields: ['ap_img', 'pt_img'] }
    ],
    results: [
      {
        folderName: '项目一',
        status: 'completed-with-warnings',
        imageResults: {
          ap_img: { field: 'ap_img', status: 'succeeded' },
          pt_img: { field: 'pt_img', status: 'skipped' }
        }
      },
      {
        folderName: '项目二',
        status: 'completed',
        imageResults: {
          ap_img: { field: 'ap_img', status: 'succeeded' },
          pt_img: { field: 'pt_img', status: 'succeeded' }
        }
      }
    ]
  }
  const repair = buildResumeState(report, 'completed.json')
  assert.equal(repair.sourceStatus, 'completed')
  assert.deepEqual(repair.remainingFolders, ['项目一'])
  assert.deepEqual(repair.retryFieldsByFolder, { 项目一: ['pt_img'] })
  assert.deepEqual(repair.processedFolders, ['项目二'])

  const successful = structuredClone(report)
  successful.results[0].status = 'completed'
  successful.results[0].imageResults.pt_img.status = 'succeeded'
  assert.equal(buildResumeState(successful), null)
})

test('does not offer active running checkpoints while the task is still active', () => {
  const report = {
    mode: 'upload',
    status: 'running',
    plan: [{ folderName: '项目一' }],
    results: []
  }
  assert.equal(buildResumeState({ ...report, status: 'running' }, '', { allowRunning: false }), null)
  assert.deepEqual(
    buildResumeState({ ...report, status: 'running' }, '', { allowRunning: true }).remainingFolders,
    ['项目一']
  )
})

test('does not retry missing site targets and keeps successful target slugs', () => {
  const resume = buildResumeState({
    mode: 'upload',
    status: 'completed-with-errors',
    plan: [{ folderName: '项目一', processFields: ['oem', 'order-terms', 'quality-control'] }],
    results: [{
      folderName: '项目一',
      status: 'failed',
      imageResults: {
        oem: { field: 'oem', status: 'skipped', reason: '找不到 页面 slug=oem' },
        'order-terms': { field: 'order-terms', status: 'succeeded', page: 'order-terms' },
        'quality-control': { field: 'quality-control', status: 'write-failed', page: 'quality-control' }
      }
    }]
  })

  assert.deepEqual(resume.retryFieldsByFolder, { 项目一: ['quality-control'] })
  assert.deepEqual(resume.notApplicableFieldsByFolder, { 项目一: ['oem'] })
  assert.deepEqual(resume.targetSlugsByFolder, { 项目一: { 'order-terms': 'order-terms' } })
})
