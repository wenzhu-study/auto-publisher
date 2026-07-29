import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { executeBatch } from '../src/batch.mjs'

test('records each image result and continues after one upload fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-batch-'))
  const filenames = {
    ap_img: 'about-us-1.png',
    af_img: 'after-sales-1.png',
    hp_img: 'mobile-hot-products-banner-1.png',
    mo_banner: 'mobile-banner-1.png',
    pt_img: 'price-list-1.png'
  }
  await Promise.all(Object.values(filenames).map((name) =>
    writeFile(path.join(root, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  ))

  const pageFields = {
    21: { ap_img: false, af_img: false, hp_img: false, mo_banner: [] },
    22: {}
  }
  const uploadedFilenames = []
  let nextMediaId = 700
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/wp-json/wp/v2/pages') {
      const slug = url.searchParams.get('slug')
      if (slug === 'about-us') return json(response, 200, [{ id: 21, slug, acf: pageFields[21] }])
      if (slug === 'price-list') return json(response, 200, [{ id: 22, slug, acf: pageFields[22] }])
    }
    if (request.method === 'POST' && url.pathname === '/wp-json/wp/v2/media') {
      const disposition = request.headers['content-disposition'] || ''
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || ''
      uploadedFilenames.push(filename)
      if (filename.startsWith('after-sales-')) return json(response, 500, { message: 'simulated upload failure' })
      nextMediaId += 1
      return json(response, 201, { id: nextMediaId, source_url: `http://example.test/${filename}` })
    }
    if (request.method === 'POST' && /^\/wp-json\/wp\/v2\/media\/\d+$/.test(url.pathname)) {
      return json(response, 200, { id: Number(url.pathname.split('/').at(-1)) })
    }
    const pageMatch = url.pathname.match(/^\/wp-json\/wp\/v2\/pages\/(\d+)$/)
    if (pageMatch && request.method === 'POST') {
      const pageId = Number(pageMatch[1])
      const payload = JSON.parse((await readBody(request)).toString('utf8'))
      Object.assign(pageFields[pageId], payload.acf || {})
      return json(response, 200, { id: pageId, acf: pageFields[pageId] })
    }
    if (pageMatch && request.method === 'GET') {
      return json(response, 200, { acf: pageFields[Number(pageMatch[1])] })
    }
    return json(response, 404, { message: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const selected = Object.fromEntries(Object.entries(filenames).map(([field, name]) => [field, path.join(root, name)]))
  const projects = [{
    folderName: '测试项目',
    selected,
    project: {
      name: '测试项目',
      url: `http://127.0.0.1:${server.address().port}`,
      username: 'shop',
      appPassword: 'application-password'
    }
  }]
  const events = []

  try {
    const [result] = await executeBatch(projects, (event) => events.push(event))
    assert.equal(result.status, 'failed')
    assert.equal(result.summary.succeeded, 4)
    assert.equal(result.summary.failed, 1)
    assert.equal(result.imageResults.af_img.status, 'upload-failed')
    assert.match(result.imageResults.af_img.error, /simulated upload failure/)
    assert.equal(result.imageResults.ap_img.status, 'succeeded')
    assert.equal(result.imageResults.hp_img.status, 'succeeded')
    assert.equal(result.imageResults.mo_banner.status, 'succeeded')
    assert.equal(result.imageResults.pt_img.status, 'succeeded')
    assert.equal(pageFields[22].pt_img > 0, true)
    assert.equal(uploadedFilenames.filter((name) => name.startsWith('after-sales-')).length, 3)
    assert.equal(new Set(uploadedFilenames).size, 5)
    assert.equal(events.filter((event) => event.stage === 'image-succeeded').length, 4)
    assert.equal(events.filter((event) => event.stage === 'upload-failed').length, 1)
    assert.match(events.at(-1).message, /失败 1 张/)

    uploadedFilenames.length = 0
    const [retryResult] = await executeBatch(
      [{ ...projects[0], fieldsToProcess: ['pt_img'] }],
      () => {}
    )
    assert.equal(retryResult.status, 'completed')
    assert.deepEqual(Object.keys(retryResult.imageResults), ['pt_img'])
    assert.deepEqual(uploadedFilenames, ['price-list-1.png'])
  } finally {
    await rm(root, { recursive: true, force: true })
    await new Promise((resolve) => server.close(resolve))
  }
})

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}
