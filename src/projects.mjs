import { readFile } from 'node:fs/promises'

export async function fetchShopProjects(keyHubUrl, options = {}) {
  const baseUrl = String(keyHubUrl).replace(/\/+$/, '')
  const response = await fetchWithTimeout(`${baseUrl}/api/keys`, {
    headers: { Accept: 'application/json' }
  }, options.timeoutMs)

  if (!response.ok) {
    throw new Error(`KeyHub 项目读取失败：HTTP ${response.status}`)
  }

  const payload = await response.json()
  if (payload?.ok === false) {
    throw new Error(payload.message || payload.error || 'KeyHub 返回失败')
  }

  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return rows
    .map(normalizeProject)
    .filter((project) => project.id && project.name && project.url && project.username && project.appPassword)
}

export async function readProjectMap(mapPath) {
  if (!mapPath) return {}
  try {
    const content = await readFile(mapPath, 'utf8')
    const value = JSON.parse(content)
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('内容必须是 JSON 对象')
    }
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`项目映射文件读取失败（${mapPath}）：${error.message}`)
  }
}

export function matchImageProjects(imageProjects, keyHubProjects, projectMap = {}) {
  const exact = indexProjects(keyHubProjects, (project) => project.name)
  const normalized = indexProjects(keyHubProjects, (project) => normalizeProjectName(project.name))

  return imageProjects.map((imageProject) => {
    const mappedName = projectMap[imageProject.folderName]
    const requestedName = mappedName || imageProject.folderName
    const exactMatches = exact.get(requestedName) || []
    const normalizedMatches = normalized.get(normalizeProjectName(requestedName)) || []
    const matches = exactMatches.length ? exactMatches : normalizedMatches

    if (matches.length === 1) return { ...imageProject, project: matches[0], matchError: '' }
    if (matches.length > 1) {
      return {
        ...imageProject,
        project: null,
        matchError: `项目名匹配不唯一：${requestedName}（命中 ${matches.length} 个项目）`
      }
    }
    return {
      ...imageProject,
      project: null,
      matchError: `KeyHub 中找不到项目：${requestedName}`
    }
  })
}

export function normalizeProjectName(name) {
  return String(name)
    .trim()
    .replace(/\s*(?:\(copy\)|（copy）|\(副本\)|（副本）)\s*$/i, '')
    .trim()
}

function normalizeProject(item = {}) {
  const accounts = Array.isArray(item.accounts) ? item.accounts : []
  const account = accounts.find((candidate) => String(candidate?.role).toLowerCase() === 'shop')
  return {
    id: item.kid || item.id || '',
    name: item.name || '',
    url: item.siteUrl || item.url || '',
    username: account?.username || '',
    appPassword: account?.key || account?.appPassword || ''
  }
}

function indexProjects(projects, keyOf) {
  const index = new Map()
  for (const project of projects) {
    const key = keyOf(project)
    const values = index.get(key) || []
    values.push(project)
    index.set(key, values)
  }
  return index
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`KeyHub 请求超时（${timeoutMs}ms）`)
    throw new Error(`KeyHub 无法连接：${error.message}`)
  }
}
