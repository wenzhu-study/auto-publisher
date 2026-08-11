import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkSites, executeBatch } from '../src/batch.mjs'

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
  const newImagePath = path.join(root, 'hot-products-3-1-1.png')
  await writeFile(newImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const featuredImagePath = path.join(root, 'about-us-3-1-1.png')
  await writeFile(featuredImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const pageFields = {
    21: { ap_img: false, af_img: false, hp_img: false, mo_banner: [] },
    22: {},
    24: { 'hot-products': false }
  }
  const uploadedFilenames = []
  const requestedPageSlugs = []
  let tagBanner = 0
  let featuredMedia = 0
  let nextMediaId = 700
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/wp-json/wp/v2/pages') {
      const slug = url.searchParams.get('slug')
      requestedPageSlugs.push(slug || '*')
      if (slug === 'about-us') return json(response, 200, [{ id: 21, slug, acf: pageFields[21] }])
      if (slug === 'price-list') return json(response, 200, [{ id: 22, slug, acf: pageFields[22] }])
      if (!slug) return json(response, 200, [
        { id: 21, slug: 'about-us', acf: pageFields[21], featured_media: featuredMedia },
        { id: 22, slug: 'price-list', acf: pageFields[22] },
        { id: 24, slug: 'home', acf: pageFields[24] }
      ])
    }
    if (request.method === 'GET' && url.pathname === '/wp-json/wc/v3/products/tags') {
      return json(response, 200, [{ id: 41, slug: 'hot-products', name: 'Hot Products' }])
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
      if (payload.featured_media != null) featuredMedia = Number(payload.featured_media)
      Object.assign(pageFields[pageId], payload.acf || {})
      return json(response, 200, { id: pageId, acf: pageFields[pageId], featured_media: featuredMedia })
    }
    if (pageMatch && request.method === 'GET') {
      return json(response, 200, { acf: pageFields[Number(pageMatch[1])], featured_media: featuredMedia })
    }
    if (request.method === 'POST' && url.pathname === '/wp-json/wp/v2/product_tag/41') {
      const payload = JSON.parse((await readBody(request)).toString('utf8'))
      tagBanner = Number(payload.acf?.category_banner)
      return json(response, 200, { id: 41, acf: { category_banner: tagBanner } })
    }
    if (request.method === 'GET' && url.pathname === '/wp-json/wp/v2/product_tag/41') {
      return json(response, 200, { id: 41, acf: { category_banner: tagBanner } })
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
    assert.deepEqual(retryResult.processFields, ['pt_img'])
    assert.deepEqual(Object.keys(retryResult.imageResults), ['pt_img'])
    assert.deepEqual(uploadedFilenames, ['price-list-1.png'])

    requestedPageSlugs.length = 0
    const [checkResult] = await checkSites(
      [{ ...projects[0], fieldsToProcess: ['pt_img'] }],
      () => {}
    )
    assert.equal(checkResult.ok, true)
    assert.deepEqual(checkResult.processFields, ['pt_img'])
    assert.equal(requestedPageSlugs.includes('about-us'), false)
    assert.equal(requestedPageSlugs.includes('price-list'), true)

    uploadedFilenames.length = 0
    const [newFieldResult] = await executeBatch(
      [{ ...projects[0], selected: { 'hot-products': newImagePath }, fieldsToProcess: ['hot-products'] }],
      () => {}
    )
    assert.equal(newFieldResult.status, 'completed')
    assert.equal(newFieldResult.imageResults['hot-products'].status, 'succeeded')
    assert.equal(newFieldResult.imageResults['hot-products'].targetId, 41)
    assert.equal(newFieldResult.imageResults['hot-products'].targetType, 'tag-banner')
    assert.equal(tagBanner > 0, true)
    assert.deepEqual(uploadedFilenames, ['hot-products-3-1-1.png'])

    uploadedFilenames.length = 0
    const [featuredResult] = await executeBatch(
      [{ ...projects[0], selected: { 'about-us': featuredImagePath }, fieldsToProcess: ['about-us'] }],
      () => {}
    )
    assert.equal(featuredResult.status, 'completed')
    assert.equal(featuredResult.imageResults['about-us'].targetId, 21)
    assert.equal(featuredResult.imageResults['about-us'].targetType, 'page-featured')
    assert.equal(featuredMedia > 0, true)
    assert.deepEqual(uploadedFilenames, ['about-us-3-1-1.png'])

    const [missingImageResult] = await executeBatch(
      [{ ...projects[0], selected: { 'quality-control': null }, fieldsToProcess: ['quality-control'] }],
      () => {}
    )
    assert.equal(missingImageResult.status, 'completed-with-warnings')
    assert.equal(missingImageResult.imageResults['quality-control'].status, 'skipped')
    assert.match(missingImageResult.imageResults['quality-control'].reason, /素材目录没有/)

    uploadedFilenames.length = 0
    const continuedResults = await executeBatch([
      {
        ...projects[0],
        folderName: '缺少写入目标的项目',
        selected: { 'quality-control': featuredImagePath },
        fieldsToProcess: ['quality-control']
      },
      {
        ...projects[0],
        folderName: '后续正常项目',
        selected: { 'about-us': featuredImagePath },
        fieldsToProcess: ['about-us']
      }
    ], () => {})
    assert.equal(continuedResults.length, 2)
    assert.equal(continuedResults[0].status, 'completed-with-warnings')
    assert.equal(continuedResults[0].imageResults['quality-control'].status, 'not-applicable')
    assert.equal(continuedResults[1].status, 'completed')
    assert.deepEqual(uploadedFilenames, ['about-us-3-1-1.png'])
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
