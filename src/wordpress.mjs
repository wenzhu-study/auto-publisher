import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CONTENT_TYPES } from './constants.mjs'

const DEFAULT_TIMEOUT_MS = 120000
const RETRIES = 2

export async function findPage(project, slug, requestOptions = {}) {
  const { expectedFields = [], ...wordpressRequestOptions } = requestOptions
  const params = {
    slug,
    status: 'any',
    context: 'edit',
    acf_format: 'standard',
    per_page: 20,
    _fields: 'id,title,slug,link,status,acf,fields,meta'
  }
  let pages
  try {
    pages = await wpRequest(project, '/wp-json/wp/v2/pages', { ...wordpressRequestOptions, params })
  } catch (error) {
    pages = await wpRequest(project, '/wp-json/wp/v2/pages', {
      ...wordpressRequestOptions,
      params: { ...params, status: 'publish' }
    }).catch(() => {
      throw error
    })
  }

  const matches = Array.isArray(pages) ? pages.filter((page) => Number(page?.id) > 0) : []
  const exact = matches.find((page) => String(page.slug).toLowerCase() === slug.toLowerCase())
  let page = exact || matches[0]

  if (expectedFields.length && pageFieldScore(page, expectedFields) < expectedFields.length) {
    const allPagesParams = { ...params, per_page: 100 }
    delete allPagesParams.slug
    let allPages
    try {
      allPages = await wpRequest(project, '/wp-json/wp/v2/pages', {
        ...wordpressRequestOptions,
        params: allPagesParams
      })
    } catch {
      allPages = await wpRequest(project, '/wp-json/wp/v2/pages', {
        ...wordpressRequestOptions,
        params: { ...allPagesParams, status: 'publish' }
      }).catch(() => [])
    }

    const candidates = Array.isArray(allPages)
      ? allPages.filter((candidate) => Number(candidate?.id) > 0)
      : []
    const best = candidates.sort((left, right) => {
      const coverage = pageFieldScore(right, expectedFields) - pageFieldScore(left, expectedFields)
      if (coverage) return coverage
      return pageSlugScore(right, slug) - pageSlugScore(left, slug)
    })[0]
    if (pageFieldScore(best, expectedFields) > pageFieldScore(page, expectedFields)) page = best
  }
  if (!page?.id) throw new Error(`找不到页面 slug=${slug}`)
  return page
}

export async function uploadMedia(project, filePath, label) {
  const body = await readFile(filePath)
  const extension = path.extname(filePath).toLowerCase()
  const contentType = CONTENT_TYPES[extension]
  if (!contentType) throw new Error(`不支持的图片格式：${path.basename(filePath)}`)

  const filename = sanitizeFilename(path.basename(filePath))
  const media = await wpRequest(project, '/wp-json/wp/v2/media', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  })
  if (!Number(media?.id)) throw new Error(`媒体上传未返回 ID：${path.basename(filePath)}`)

  try {
    await wpRequest(project, `/wp-json/wp/v2/media/${media.id}`, {
      method: 'POST',
      json: { title: `${label} website content image`, alt_text: label }
    })
  } catch {
    // Title and alt text are non-critical; the media ID is enough to update ACF.
  }

  return {
    id: Number(media.id),
    sourceUrl: media.source_url || '',
    filename: path.basename(filePath)
  }
}

export async function updateAndVerifyImageFields(project, pageId, expected) {
  const payload = Object.fromEntries(
    Object.entries(expected).map(([fieldName, value]) => [
      fieldName,
      Array.isArray(value) ? value.map(Number) : Number(value)
    ])
  )
  const attempts = [
    {
      name: 'WordPress 页面 REST ACF',
      request: () => wpRequest(project, `/wp-json/wp/v2/pages/${pageId}`, {
        method: 'POST',
        json: { acf: payload }
      })
    },
    {
      name: 'XML-RPC custom_fields',
      request: () => updateXmlRpcImageFields(project, pageId, payload)
    },
    {
      name: 'WordPress 页面 REST fields',
      request: () => wpRequest(project, `/wp-json/wp/v2/pages/${pageId}`, {
        method: 'POST',
        json: { fields: payload }
      })
    },
    {
      name: 'ACF REST pages',
      request: () => wpRequest(project, `/wp-json/acf/v3/pages/${pageId}`, {
        method: 'POST',
        json: { fields: payload }
      })
    },
    {
      name: 'ACF REST page',
      request: () => wpRequest(project, `/wp-json/acf/v3/page/${pageId}`, {
        method: 'POST',
        json: { fields: payload }
      })
    },
    {
      name: 'ACF REST posts',
      request: () => wpRequest(project, `/wp-json/acf/v3/posts/${pageId}`, {
        method: 'POST',
        json: { fields: payload }
      })
    }
  ]
  const errors = []

  for (const attempt of attempts) {
    try {
      await attempt.request()
      const verification = await verifyImageFields(project, pageId, payload)
      if (verification.ok) return { method: attempt.name, actual: verification.actual }
      errors.push(`${attempt.name}: 写入响应成功但回读不一致（${verification.details}）`)
    } catch (error) {
      errors.push(`${attempt.name}: ${error.message}`)
    }
  }

  throw new Error(`页面 ID ${pageId} 图片字段写入失败：${errors.join('；')}`)
}

export async function verifyImageFields(project, pageId, expected) {
  const sources = []
  try {
    const page = await wpRequest(project, `/wp-json/wp/v2/pages/${pageId}`, {
      params: { context: 'edit', acf_format: 'standard', _fields: 'acf,fields,meta' }
    })
    sources.push(page?.acf, page?.fields, page?.meta)
    const verification = await compareImageFieldSources(project, sources, expected)
    if (verification.ok) return verification
  } catch {
    // ACF endpoints below may still expose the values.
  }

  for (const endpoint of [
    `/wp-json/acf/v3/pages/${pageId}`,
    `/wp-json/acf/v3/page/${pageId}`,
    `/wp-json/acf/v3/posts/${pageId}`
  ]) {
    try {
      const value = await wpRequest(project, endpoint)
      sources.push(value?.acf, value?.fields, value)
      const verification = await compareImageFieldSources(project, sources, expected)
      if (verification.ok) return verification
    } catch {
      // This WordPress installation may not expose this ACF route.
    }
  }

  try {
    const customFields = await fetchXmlRpcCustomFields(project, pageId)
    sources.push(Object.fromEntries(customFields.map((field) => [field.key, field.value])))
  } catch {
    // XML-RPC may be disabled when a REST route already exposes the fields.
  }

  return compareImageFieldSources(project, sources, expected)
}

async function compareImageFieldSources(project, sources, expected) {
  const actual = {}
  const mismatches = []
  const mediaUrlCache = new Map()
  const mediaIdsToFetch = new Set()
  for (const [fieldName, expectedValue] of Object.entries(expected)) {
    const candidate = sources.find((source) => source && Object.hasOwn(source, fieldName))
    const actualValue = candidate?.[fieldName]
    if (!sameIds(extractMediaIds(actualValue), (Array.isArray(expectedValue) ? expectedValue : [expectedValue]).map(Number)) &&
        extractMediaUrls(actualValue).length) {
      for (const id of (Array.isArray(expectedValue) ? expectedValue : [expectedValue])) mediaIdsToFetch.add(Number(id))
    }
  }
  await Promise.all([...mediaIdsToFetch].map(async (id) => {
    mediaUrlCache.set(id, await fetchMediaUrl(project, id))
  }))

  for (const [fieldName, expectedValue] of Object.entries(expected)) {
    const candidate = sources.find((source) => source && Object.hasOwn(source, fieldName))
    const actualValue = candidate?.[fieldName]
    const actualIds = extractMediaIds(actualValue)
    const actualUrls = extractMediaUrls(actualValue)
    const expectedIds = (Array.isArray(expectedValue) ? expectedValue : [expectedValue]).map(Number)
    let matches = sameIds(actualIds, expectedIds)
    if (!matches && actualUrls.length) {
      const expectedUrls = expectedIds.map((id) => mediaUrlCache.get(id) || '')
      matches = sameUrls(actualUrls, expectedUrls)
    }
    actual[fieldName] = actualIds.length ? actualIds : actualUrls
    if (!matches) {
      const actualLabel = actualIds.length ? actualIds.join(',') : actualUrls.join(',') || '未读到'
      mismatches.push(`${fieldName}: 期望媒体 ID ${expectedIds.join(',')}，实际 ${actualLabel}`)
    }
  }
  return { ok: mismatches.length === 0, actual, details: mismatches.join('；') }
}

export function extractMediaIds(value) {
  if (value == null || value === '') return []
  if (Array.isArray(value)) return value.flatMap(extractMediaIds).filter(uniqueNumber)
  if (typeof value === 'string' && /^a:\d+:\{/.test(value.trim())) {
    const stringIds = [...value.matchAll(/s:\d+:"(\d+)";/g)].map((match) => Number(match[1]))
    if (stringIds.length) return stringIds.filter(uniqueNumber)
    return [...value.matchAll(/i:\d+;i:(\d+);/g)].map((match) => Number(match[1])).filter(uniqueNumber)
  }
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const id = Number(value)
    return id > 0 ? [id] : []
  }
  if (typeof value === 'object') {
    for (const key of ['id', 'ID', 'raw']) {
      const id = Number(value[key])
      if (Number.isFinite(id) && id > 0) return [id]
    }
  }
  return []
}

export function extractMediaUrls(value) {
  if (value == null || value === '') return []
  if (Array.isArray(value)) return value.flatMap(extractMediaUrls).filter(uniqueText)
  if (typeof value === 'string') return /^https?:\/\//i.test(value.trim()) ? [value.trim()] : []
  if (typeof value === 'object') {
    const candidates = [value.url, value.source_url, value.guid?.rendered, value.raw]
    return candidates.flatMap(extractMediaUrls).filter(uniqueText)
  }
  return []
}

export async function fetchXmlRpcCustomFields(project, pageId) {
  const response = await xmlRpcRequest(project, 'wp.getPost', [
    0,
    project.username,
    project.appPassword,
    Number(pageId),
    ['custom_fields', 'post']
  ])
  return Array.isArray(response?.custom_fields) ? response.custom_fields : []
}

export async function updateXmlRpcImageFields(project, pageId, expected) {
  const currentFields = await fetchXmlRpcCustomFields(project, pageId)
  const byKey = new Map(currentFields.filter((field) => field?.key).map((field) => [field.key, field]))
  const customFields = Object.entries(expected).map(([key, value]) => {
    const current = byKey.get(key)
    const normalizedValue = Array.isArray(value)
      ? phpSerializeArray(value.map(Number))
      : String(Number(value) || '')
    return {
      ...(current?.id ? { id: current.id } : {}),
      key,
      value: normalizedValue
    }
  })

  const response = await xmlRpcRequest(project, 'wp.editPost', [
    0,
    project.username,
    project.appPassword,
    Number(pageId),
    { custom_fields: customFields }
  ])
  if (response !== true && response !== 1 && response !== '1') {
    throw new Error('XML-RPC wp.editPost 未返回成功')
  }
  return response
}

export async function preflightSite(project, options = {}) {
  const fields = Array.isArray(options.fields)
    ? [...new Set(options.fields.map(String))]
    : ['ap_img', 'af_img', 'hp_img', 'mo_banner', 'pt_img']
  const aboutFields = fields.filter((field) => ['ap_img', 'af_img', 'hp_img', 'mo_banner'].includes(field))
  const needsPriceList = fields.includes('pt_img')
  const requestOptions = {
    timeoutMs: options.timeoutMs || 20000,
    retries: options.retries ?? 0
  }
  const [aboutPage, priceListPage] = await Promise.all([
    aboutFields.length
      ? findPage(project, 'about-us', { ...requestOptions, expectedFields: aboutFields })
      : Promise.resolve(null),
    needsPriceList
      ? findPage(project, 'price-list', { ...requestOptions, expectedFields: ['pt_img'] })
      : Promise.resolve(null)
  ])
  return {
    aboutPageId: aboutPage ? Number(aboutPage.id) : null,
    priceListPageId: priceListPage ? Number(priceListPage.id) : null,
    missingFields: getMissingImageFields(aboutPage, priceListPage).filter((field) => fields.includes(field))
  }
}

export async function resolvePublisherTargets(project, fields, options = {}) {
  const pageFields = fields.filter((field) => field.targetType === 'page-featured')
  const tagFields = fields.filter((field) => field.targetType === 'tag-banner')
  const requestOptions = {
    timeoutMs: options.timeoutMs || 20000,
    retries: options.retries ?? 0
  }
  const [pageCollection, tagCollection] = await Promise.all([
    pageFields.length ? fetchPublisherPages(project, requestOptions) : Promise.resolve({ items: [], error: '' }),
    tagFields.length ? fetchProductTags(project, requestOptions) : Promise.resolve({ items: [], error: '' })
  ])

  return Object.fromEntries(fields.map((field) => {
    const collection = field.targetType === 'tag-banner' ? tagCollection : pageCollection
    const expectedSlug = String(field.pageSlug || field.key).toLowerCase()
    const target = collection.items.find((item) => String(item?.slug || '').toLowerCase() === expectedSlug)
    if (target) {
      return [field.key, {
        target: {
          id: Number(target.id),
          slug: target.slug,
          name: target.name || target.title?.rendered || target.slug,
          targetType: field.targetType
        },
        reason: ''
      }]
    }
    const typeLabel = field.targetType === 'tag-banner' ? '产品标签' : '页面'
    const suffix = collection.error ? `（${collection.error}）` : ''
    return [field.key, { target: null, reason: `找不到 ${typeLabel} slug=${expectedSlug}${suffix}` }]
  }))
}

export async function updateAndVerifyPageFeaturedImage(project, pageId, mediaId) {
  const expectedId = Number(mediaId)
  await wpRequest(project, `/wp-json/wp/v2/pages/${Number(pageId)}`, {
    method: 'POST',
    json: { featured_media: expectedId }
  })
  const page = await wpRequest(project, `/wp-json/wp/v2/pages/${Number(pageId)}`, {
    params: { context: 'edit', _fields: 'id,slug,featured_media' }
  })
  const actualId = Number(page?.featured_media)
  if (actualId !== expectedId) {
    throw new Error(`页面 ID ${pageId} 特色图片回读不一致：期望 ${expectedId}，实际 ${actualId || '未读到'}`)
  }
  return { method: 'WordPress 页面特色图片', actual: { featured_media: actualId } }
}

export async function updateAndVerifyTagBanner(project, tagId, mediaId) {
  const expectedId = Number(mediaId)
  const attempts = [
    {
      name: 'WordPress 产品标签 REST ACF',
      request: () => wpRequest(project, `/wp-json/wp/v2/product_tag/${Number(tagId)}`, {
        method: 'POST',
        json: { acf: { category_banner: expectedId } }
      })
    },
    {
      name: 'ACF REST product_tag',
      request: () => wpRequest(project, `/wp-json/acf/v3/product_tag/${Number(tagId)}`, {
        method: 'POST',
        json: { fields: { category_banner: expectedId } }
      })
    },
    {
      name: 'WooCommerce 产品标签 meta_data',
      request: () => wpRequest(project, `/wp-json/wc/v3/products/tags/${Number(tagId)}`, {
        method: 'PUT',
        json: { meta_data: [{ key: 'category_banner', value: expectedId }] }
      })
    }
  ]
  const errors = []

  for (const attempt of attempts) {
    try {
      const response = await attempt.request()
      const actualId = await readTagBannerMediaId(project, tagId, response)
      if (actualId === expectedId) {
        return { method: attempt.name, actual: { category_banner: actualId } }
      }
      errors.push(`${attempt.name}: 写入响应成功但回读不一致（实际 ${actualId || '未读到'}）`)
    } catch (error) {
      errors.push(`${attempt.name}: ${error.message}`)
    }
  }
  throw new Error(`产品标签 ID ${tagId} category_banner 写入失败：${errors.join('；')}`)
}

async function fetchPublisherPages(project, requestOptions) {
  const params = {
    status: 'any',
    context: 'edit',
    per_page: 100,
    _fields: 'id,title,slug,status,featured_media'
  }
  try {
    const pages = await wpRequest(project, '/wp-json/wp/v2/pages', { ...requestOptions, params })
    return { items: validTargets(pages), error: '' }
  } catch (error) {
    try {
      const pages = await wpRequest(project, '/wp-json/wp/v2/pages', {
        ...requestOptions,
        params: { ...params, status: 'publish' }
      })
      return { items: validTargets(pages), error: '' }
    } catch (fallbackError) {
      return { items: [], error: fallbackError.message || error.message }
    }
  }
}

async function fetchProductTags(project, requestOptions) {
  try {
    const tags = await wpRequest(project, '/wp-json/wc/v3/products/tags', {
      ...requestOptions,
      params: { per_page: 100, hide_empty: false }
    })
    return { items: validTargets(tags), error: '' }
  } catch (wooError) {
    try {
      const tags = await wpRequest(project, '/wp-json/wp/v2/product_tag', {
        ...requestOptions,
        params: { per_page: 100, hide_empty: false, context: 'edit' }
      })
      return { items: validTargets(tags), error: '' }
    } catch (wpError) {
      return { items: [], error: wpError.message || wooError.message }
    }
  }
}

async function readTagBannerMediaId(project, tagId, initialResponse) {
  const sources = [initialResponse]
  for (const endpoint of [
    `/wp-json/wp/v2/product_tag/${Number(tagId)}`,
    `/wp-json/acf/v3/product_tag/${Number(tagId)}`,
    `/wp-json/wc/v3/products/tags/${Number(tagId)}`
  ]) {
    try {
      sources.push(await wpRequest(project, endpoint, {
        params: endpoint.includes('/wp/v2/') ? { context: 'edit' } : undefined
      }))
    } catch {
      // Installations expose different combinations of tag and ACF routes.
    }
  }
  return sources.flatMap(categoryBannerMediaIds)[0] || null
}

function categoryBannerMediaIds(source) {
  if (!source || typeof source !== 'object') return []
  const metaData = Array.isArray(source.meta_data)
    ? source.meta_data.filter((item) => item?.key === 'category_banner').map((item) => item.value)
    : []
  return [
    source.category_banner,
    source.acf?.category_banner,
    source.fields?.category_banner,
    source.meta?.category_banner,
    ...metaData
  ].flatMap(extractMediaIds)
}

function validTargets(value) {
  return Array.isArray(value) ? value.filter((item) => Number(item?.id) > 0) : []
}

export function getMissingImageFields(aboutPage) {
  // The publisher UI allows pt_img to be created on a Price List page even when
  // WordPress omits the field from its REST response, so its absence is not a
  // reliable reason to skip the upload.
  return ['ap_img', 'af_img', 'hp_img', 'mo_banner']
    .filter((field) => !pageHasField(aboutPage, field))
}

function pageFieldScore(page, expectedFields) {
  return expectedFields.filter((field) => pageHasField(page, field)).length
}

function pageHasField(page, field) {
  return [page?.acf, page?.fields, page?.meta]
    .some((container) => container && typeof container === 'object' && Object.hasOwn(container, field))
}

function pageSlugScore(page, slug) {
  const candidate = String(page?.slug || '').toLowerCase()
  const expected = String(slug).toLowerCase()
  if (candidate === expected) return 2
  if (candidate.startsWith(`${expected}-`)) return 1
  return 0
}

async function wpRequest(project, pathname, options = {}) {
  const url = new URL(pathname, ensureTrailingSlash(project.url))
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value != null) url.searchParams.set(key, String(value))
  }

  const auth = Buffer.from(`${project.username}:${project.appPassword}`, 'utf8').toString('base64')
  const headers = {
    Accept: 'application/json',
    Authorization: `Basic ${auth}`,
    ...(options.headers || {})
  }
  let body = options.body
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  }

  let lastError
  const retries = options.retries ?? RETRIES
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
      })
      const text = await response.text()
      const data = text ? parseJson(text) : null
      if (!response.ok) {
        const message = data?.message || data?.error || text.slice(0, 300) || response.statusText
        const error = new Error(`HTTP ${response.status}: ${message}`)
        error.status = response.status
        throw error
      }
      return data
    } catch (error) {
      lastError = normalizeFetchError(error, options.timeoutMs || DEFAULT_TIMEOUT_MS)
      if (attempt >= retries || !isRetryable(error)) break
      await delay(800 * (attempt + 1))
    }
  }
  throw lastError
}

async function xmlRpcRequest(project, methodName, params) {
  const response = await wpRequest(project, '/xmlrpc.php', {
    method: 'POST',
    body: buildXmlRpcRequest(methodName, params),
    timeoutMs: 60000,
    headers: {
      Accept: 'text/xml',
      'Content-Type': 'text/xml; charset=UTF-8'
    }
  })
  return parseXmlRpcResponse(response)
}

export function buildXmlRpcRequest(methodName, params = []) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<methodCall><methodName>${escapeXml(methodName)}</methodName><params>` +
    params.map((param) => `<param>${buildXmlRpcValue(param)}</param>`).join('') +
    '</params></methodCall>'
}

function buildXmlRpcValue(value) {
  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(buildXmlRpcValue).join('')}</data></array></value>`
  }
  if (value && typeof value === 'object') {
    return `<value><struct>${Object.entries(value).map(([key, item]) =>
      `<member><name>${escapeXml(key)}</name>${buildXmlRpcValue(item)}</member>`
    ).join('')}</struct></value>`
  }
  if (typeof value === 'number') return `<value><int>${value}</int></value>`
  if (typeof value === 'boolean') return `<value><boolean>${value ? 1 : 0}</boolean></value>`
  return `<value><string>${escapeXml(value ?? '')}</string></value>`
}

export function parseXmlRpcResponse(xmlText) {
  const documentNode = parseXml(String(xmlText || ''))
  const methodResponse = findDescendant(documentNode, 'methodResponse')
  const fault = directChild(methodResponse, 'fault')
  if (fault) {
    const value = findDescendant(fault, 'value')
    const parsed = parseXmlRpcValue(value)
    throw new Error(parsed?.faultString || 'XML-RPC 请求失败')
  }
  const params = directChild(methodResponse, 'params')
  const param = directChild(params, 'param')
  const value = directChild(param, 'value')
  if (!value) throw new Error('XML-RPC 没有返回有效数据')
  return parseXmlRpcValue(value)
}

function parseXmlRpcValue(valueNode) {
  const child = valueNode?.children?.[0]
  if (!child) return nodeText(valueNode)
  if (['string', 'dateTime.iso8601', 'base64'].includes(child.name)) return nodeText(child)
  if (child.name === 'int' || child.name === 'i4') return Number(nodeText(child) || 0)
  if (child.name === 'boolean') return nodeText(child) === '1'
  if (child.name === 'array') {
    const data = directChild(child, 'data')
    return (data?.children || []).filter((node) => node.name === 'value').map(parseXmlRpcValue)
  }
  if (child.name === 'struct') {
    return Object.fromEntries((child.children || []).filter((node) => node.name === 'member').map((member) => {
      const key = nodeText(directChild(member, 'name'))
      return [key, parseXmlRpcValue(directChild(member, 'value'))]
    }))
  }
  return nodeText(child)
}

function parseXml(xml) {
  const root = { name: '#document', children: [], text: '' }
  const stack = [root]
  const tokens = xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g) || []
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!DOCTYPE') || token.startsWith('<!--')) continue
    if (token.startsWith('<![CDATA[')) {
      stack.at(-1).text += token.slice(9, -3)
      continue
    }
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop()
      continue
    }
    if (token.startsWith('<')) {
      const match = token.match(/^<\s*([^\s/>]+)/)
      if (!match) continue
      const node = { name: match[1], children: [], text: '' }
      stack.at(-1).children.push(node)
      if (!token.endsWith('/>')) stack.push(node)
      continue
    }
    stack.at(-1).text += decodeXml(token)
  }
  return root
}

function directChild(node, name) {
  return node?.children?.find((child) => child.name === name) || null
}

function findDescendant(node, name) {
  if (!node) return null
  if (node.name === name) return node
  for (const child of node.children || []) {
    const found = findDescendant(child, name)
    if (found) return found
  }
  return null
}

function nodeText(node) {
  if (!node) return ''
  return `${node.text || ''}${(node.children || []).map(nodeText).join('')}`
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function decodeXml(value) {
  return String(value).replace(/&(quot|apos|lt|gt|amp|#\d+|#x[\da-f]+);/gi, (entity, code) => {
    const named = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }
    const normalizedCode = code.toLowerCase()
    if (named[normalizedCode]) return named[normalizedCode]
    if (normalizedCode.startsWith('#x')) return String.fromCodePoint(Number.parseInt(normalizedCode.slice(2), 16))
    if (normalizedCode.startsWith('#')) return String.fromCodePoint(Number(normalizedCode.slice(1)))
    return entity
  })
}

export function phpSerializeArray(values = []) {
  return `a:${values.length}:{${values.map((value, index) => {
    const text = String(value)
    return `i:${index};s:${Buffer.byteLength(text, 'utf8')}:"${text.replace(/"/g, '\\"')}";`
  }).join('')}}`
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function fetchMediaUrl(project, mediaId) {
  try {
    const media = await wpRequest(project, `/wp-json/wp/v2/media/${Number(mediaId)}`, {
      params: { context: 'edit', _fields: 'id,source_url,guid' }
    })
    return extractMediaUrls(media)[0] || ''
  } catch {
    return ''
  }
}

function sameUrls(left, right) {
  const normalizedLeft = left.map(normalizeMediaUrl)
  const normalizedRight = right.map(normalizeMediaUrl)
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value && value === normalizedRight[index])
}

function normalizeMediaUrl(value) {
  try {
    const url = new URL(String(value))
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return String(value || '').trim().replace(/\/$/, '')
  }
}

function uniqueNumber(value, index, values) {
  return Number(value) > 0 && values.indexOf(value) === index
}

function uniqueText(value, index, values) {
  return Boolean(value) && values.indexOf(value) === index
}

function sanitizeFilename(filename) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '-')
  return safe || `website-image-${Date.now()}.bin`
}

function ensureTrailingSlash(value) {
  return String(value).endsWith('/') ? String(value) : `${value}/`
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function normalizeFetchError(error, timeoutMs) {
  if (error?.name === 'TimeoutError') return new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
  return error instanceof Error ? error : new Error(String(error))
}

function isRetryable(error) {
  return error?.name === 'TimeoutError' || error?.status === 429 || Number(error?.status) >= 500 || !error?.status
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
