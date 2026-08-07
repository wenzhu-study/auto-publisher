import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildXmlRpcRequest,
  extractMediaIds,
  parseXmlRpcResponse,
  phpSerializeArray,
  extractMediaUrls,
  findPage,
  getMissingImageFields,
  resolvePublisherTargets,
  updateAndVerifyImageFields,
  updateAndVerifyPageFeaturedImage,
  updateAndVerifyTagBanner,
  uploadMedia
} from '../src/wordpress.mjs'

test('extracts WordPress media IDs from common ACF return formats', () => {
  assert.deepEqual(extractMediaIds(123), [123])
  assert.deepEqual(extractMediaIds('123'), [123])
  assert.deepEqual(extractMediaIds({ id: 123, url: 'x' }), [123])
  assert.deepEqual(extractMediaIds({ ID: 123 }), [123])
  assert.deepEqual(extractMediaIds([{ id: 123 }, '456', { ID: 123 }]), [123, 456])
  assert.deepEqual(extractMediaIds('a:2:{i:0;s:3:"123";i:1;s:3:"456";}'), [123, 456])
  assert.deepEqual(extractMediaIds(null), [])
  assert.deepEqual(extractMediaUrls(['https://example.test/a.png', { source_url: 'https://example.test/b.png' }]), [
    'https://example.test/a.png',
    'https://example.test/b.png'
  ])
})

test('builds and parses XML-RPC values used by WordPress', () => {
  const request = buildXmlRpcRequest('wp.editPost', [0, 'shop', 'a&b', { custom_fields: [] }])
  assert.match(request, /<methodName>wp\.editPost<\/methodName>/)
  assert.match(request, /a&amp;b/)
  assert.equal(phpSerializeArray([28801]), 'a:1:{i:0;s:5:"28801";}')
  assert.equal(parseXmlRpcResponse(xmlRpcResponse('<value><boolean>1</boolean></value>')), true)
})

test('detects missing About fields but does not preemptively skip pt_img', () => {
  const about = { acf: { ap_img: false, af_img: false, hp_img: false, mo_banner: [] } }
  assert.deepEqual(getMissingImageFields(about, { acf: { pt_img: false } }), [])
  assert.deepEqual(getMissingImageFields(about, { acf: {} }), [])
  assert.deepEqual(getMissingImageFields({ acf: {} }, { acf: {} }), [
    'ap_img', 'af_img', 'hp_img', 'mo_banner'
  ])
})

test('finds the page that actually exposes the requested image fields', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname !== '/wp-json/wp/v2/pages') return json(response, 404, { message: 'not found' })
    if (url.searchParams.has('slug')) {
      return json(response, 200, [{ id: 28, slug: 'about-us', acf: {} }])
    }
    return json(response, 200, [
      { id: 28, slug: 'about-us', acf: {} },
      {
        id: 32424,
        slug: 'about-us-2',
        acf: { ap_img: false, af_img: false, hp_img: false, mo_banner: [] }
      }
    ])
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const project = {
    url: `http://127.0.0.1:${server.address().port}`,
    username: 'shop',
    appPassword: 'application-password'
  }

  try {
    const page = await findPage(project, 'about-us', {
      expectedFields: ['ap_img', 'af_img', 'hp_img', 'mo_banner']
    })
    assert.equal(page.id, 32424)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('resolves new 3:1 fields to product tags and same-slug pages', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/wp-json/wp/v2/pages') {
      return json(response, 200, [
        { id: 21, slug: 'home', featured_media: 0 },
        { id: 27, slug: 'oem', featured_media: 0 },
        { id: 31, slug: 'contact-us', featured_media: 0 }
      ])
    }
    if (url.pathname === '/wp-json/wc/v3/products/tags') {
      return json(response, 200, [
        { id: 41, slug: 'hot-products', name: 'Hot Products' },
        { id: 42, slug: 'new-products', name: 'New Products' }
      ])
    }
    return json(response, 404, { message: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const project = {
    url: `http://127.0.0.1:${server.address().port}`,
    username: 'shop',
    appPassword: 'application-password'
  }

  try {
    const found = await resolvePublisherTargets(project, [
      { key: 'hot-products', targetType: 'tag-banner' },
      { key: 'home', pageSlug: 'home', targetType: 'page-featured' },
      { key: 'oem', pageSlug: 'oem', targetType: 'page-featured' },
      { key: 'contact-us', pageSlug: 'contact-us', targetType: 'page-featured' },
      { key: 'quality-control', pageSlug: 'quality-control', targetType: 'page-featured' }
    ])
    assert.equal(found['hot-products'].target.id, 41)
    assert.equal(found['hot-products'].target.targetType, 'tag-banner')
    assert.equal(found.home.target.id, 21)
    assert.equal(found.oem.target.id, 27)
    assert.equal(found.oem.target.targetType, 'page-featured')
    assert.equal(found['contact-us'].target.id, 31)
    assert.equal(found['quality-control'].target, null)
    assert.match(found['quality-control'].reason, /页面 slug=quality-control/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('writes and verifies page featured images and product tag category banners', async () => {
  let featuredMedia = 0
  let categoryBanner = 0
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (request.method === 'POST' && url.pathname === '/wp-json/wp/v2/pages/21') {
      const body = JSON.parse((await readBody(request)).toString('utf8'))
      featuredMedia = Number(body.featured_media)
      return json(response, 200, { id: 21, featured_media: featuredMedia })
    }
    if (request.method === 'GET' && url.pathname === '/wp-json/wp/v2/pages/21') {
      return json(response, 200, { id: 21, slug: 'about-us', featured_media: featuredMedia })
    }
    if (request.method === 'POST' && url.pathname === '/wp-json/wp/v2/product_tag/41') {
      const body = JSON.parse((await readBody(request)).toString('utf8'))
      categoryBanner = Number(body.acf?.category_banner)
      return json(response, 200, { id: 41, acf: { category_banner: categoryBanner } })
    }
    if (request.method === 'GET' && url.pathname === '/wp-json/wp/v2/product_tag/41') {
      return json(response, 200, { id: 41, acf: { category_banner: categoryBanner } })
    }
    return json(response, 404, { message: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const project = {
    url: `http://127.0.0.1:${server.address().port}`,
    username: 'shop',
    appPassword: 'application-password'
  }

  try {
    const pageResult = await updateAndVerifyPageFeaturedImage(project, 21, 801)
    const tagResult = await updateAndVerifyTagBanner(project, 41, 802)
    assert.equal(featuredMedia, 801)
    assert.equal(categoryBanner, 802)
    assert.equal(pageResult.method, 'WordPress 页面特色图片')
    assert.equal(tagResult.method, 'WordPress 产品标签 REST ACF')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('uploads binary media and verifies an ACF image-field update', async () => {
  const requests = []
  let fields = {}
  let pagePayload = {}
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    requests.push({ method: request.method, url: request.url, headers: request.headers, body })

    if (request.method === 'POST' && request.url === '/wp-json/wp/v2/media') {
      return json(response, 201, { id: 777, source_url: 'http://example.test/image.png' })
    }
    if (request.method === 'POST' && request.url === '/wp-json/wp/v2/media/777') {
      return json(response, 200, { id: 777 })
    }
    if (request.method === 'GET' && request.url.startsWith('/wp-json/wp/v2/media/777?')) {
      return json(response, 200, { id: 777, source_url: 'http://example.test/image.png' })
    }
    if (request.method === 'POST' && request.url === '/wp-json/wp/v2/pages/21') {
      const data = JSON.parse(body.toString('utf8'))
      pagePayload = data.acf || data.fields || pagePayload
      fields = {
        ap_img: 'http://example.test/image.png',
        mo_banner: ['http://example.test/image.png']
      }
      return json(response, 200, { id: 21, acf: fields })
    }
    if (request.method === 'GET' && request.url.startsWith('/wp-json/wp/v2/pages/21?')) {
      return json(response, 200, { acf: fields })
    }
    return json(response, 404, { message: 'not found' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const root = await mkdtemp(path.join(os.tmpdir(), 'auto-publisher-wp-'))
  const imagePath = path.join(root, 'about-us-test.png')
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const project = {
    url: `http://127.0.0.1:${address.port}`,
    username: 'shop',
    appPassword: 'application-password'
  }

  try {
    const media = await uploadMedia(project, imagePath, '应用场景图')
    assert.equal(media.id, 777)
    const result = await updateAndVerifyImageFields(project, 21, {
      ap_img: 777,
      mo_banner: [777]
    })
    assert.equal(result.method, 'WordPress 页面 REST ACF')
    assert.deepEqual(pagePayload, { ap_img: 777, mo_banner: [777] })

    const uploadRequest = requests.find((request) => request.url === '/wp-json/wp/v2/media')
    assert.equal(uploadRequest.headers['content-type'], 'image/png')
    assert.match(uploadRequest.headers['content-disposition'], /about-us-test\.png/)
    assert.match(uploadRequest.headers.authorization, /^Basic /)
  } finally {
    await rm(root, { recursive: true, force: true })
    await new Promise((resolve) => server.close(resolve))
  }
})

test('falls back to XML-RPC with existing custom-field IDs when REST ignores ACF', async () => {
  let fields = [
    { id: '501', key: 'ap_img', value: '100' },
    { id: '502', key: 'mo_banner', value: phpSerializeArray([101]) }
  ]
  let editBody = ''
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')

    if (request.method === 'POST' && request.url === '/wp-json/wp/v2/pages/21') {
      return json(response, 200, { id: 21, acf: {} })
    }
    if (request.method === 'GET' && request.url.startsWith('/wp-json/wp/v2/pages/21?')) {
      return json(response, 200, { acf: {} })
    }
    if (request.method === 'POST' && request.url === '/xmlrpc.php' && body.includes('<methodName>wp.getPost</methodName>')) {
      return xml(response, customFieldsResponse(fields))
    }
    if (request.method === 'POST' && request.url === '/xmlrpc.php' && body.includes('<methodName>wp.editPost</methodName>')) {
      editBody = body
      fields = [
        { id: '501', key: 'ap_img', value: '901' },
        { id: '502', key: 'mo_banner', value: phpSerializeArray([902]) }
      ]
      return xml(response, xmlRpcResponse('<value><boolean>1</boolean></value>'))
    }
    return json(response, 404, { message: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const project = {
    url: `http://127.0.0.1:${server.address().port}`,
    username: 'shop',
    appPassword: 'application-password'
  }

  try {
    const result = await updateAndVerifyImageFields(project, 21, { ap_img: 901, mo_banner: [902] })
    assert.equal(result.method, 'XML-RPC custom_fields')
    assert.match(editBody, /<name>id<\/name><value><string>501<\/string><\/value>/)
    assert.match(editBody, /<name>id<\/name><value><string>502<\/string><\/value>/)
    assert.match(editBody, /a:1:\{i:0;s:3:&quot;902&quot;;\}/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function xml(response, value) {
  response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
  response.end(value)
}

function xmlRpcResponse(valueXml) {
  return `<?xml version="1.0"?><methodResponse><params><param>${valueXml}</param></params></methodResponse>`
}

function customFieldsResponse(fields) {
  const items = fields.map((field) => `
    <value><struct>
      <member><name>id</name><value><string>${field.id}</string></value></member>
      <member><name>key</name><value><string>${field.key}</string></value></member>
      <member><name>value</name><value><string>${field.value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</string></value></member>
    </struct></value>
  `).join('')
  return xmlRpcResponse(`<value><struct><member><name>custom_fields</name><value><array><data>${items}</data></array></value></member></struct></value>`)
}
