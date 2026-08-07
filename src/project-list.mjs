import { normalizeProjectName } from './projects.mjs'

const MAX_PROJECTS = 2000

export function parseProjectList(text) {
  const entries = []
  const issues = []
  const names = new Set()
  const urls = new Set()
  let duplicateCount = 0
  let invalidCount = 0
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index].trim()
    if (!value) continue
    if (entries.length >= MAX_PROJECTS) {
      issues.push(`项目数量超过 ${MAX_PROJECTS}，后续内容未导入`)
      break
    }
    const match = value.match(/^(.+?)(?:\s*[:：]\s*|\s+)(https?:\/\/\S+)\s*$/i)
    const name = match?.[1]?.trim() || ''
    const url = match?.[2]?.trim() || ''
    const normalizedName = normalizeProjectName(name).toLocaleLowerCase('zh-CN')
    const normalizedUrl = normalizeProjectUrl(url)
    if (!name || !normalizedUrl) {
      invalidCount += 1
      issues.push(`第 ${index + 1} 行格式无效：${value}`)
      continue
    }
    if (names.has(normalizedName) || urls.has(normalizedUrl)) {
      duplicateCount += 1
      issues.push(`第 ${index + 1} 行重复：${name}`)
      continue
    }
    names.add(normalizedName)
    urls.add(normalizedUrl)
    entries.push({ name, url, normalizedName, normalizedUrl, line: index + 1 })
  }

  return {
    entries,
    issues,
    summary: {
      nonEmptyLines: lines.filter((line) => line.trim()).length,
      parsed: entries.length,
      duplicates: duplicateCount,
      invalidLines: invalidCount
    }
  }
}

export function matchImportedProjects(imageProjects, keyHubProjects, projectMap, text, fieldKeys = []) {
  const parsed = parseProjectList(text)
  const projects = parsed.entries.map((entry, index) => {
    const credential = resolveCredential(entry, keyHubProjects)
    const image = resolveImageProject(entry, credential.project, imageProjects, projectMap)
    const base = image.imageProject || emptyImageProject(entry.name, fieldKeys)
    const errors = [credential.error, image.error].filter(Boolean)
    return {
      ...base,
      folderName: image.imageProject?.folderName || entry.name,
      project: credential.project,
      matchError: errors.join('；'),
      importOrder: index + 1,
      importName: entry.name,
      importUrl: entry.url
    }
  })
  const matched = projects.filter((project) => !project.matchError).length

  return {
    projects,
    summary: {
      ...parsed.summary,
      matched,
      unmatched: projects.length - matched,
      issues: parsed.issues
    }
  }
}

export function normalizeProjectUrl(value) {
  try {
    const url = new URL(String(value).trim())
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    const port = url.port ? `:${url.port}` : ''
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${hostname}${port}${pathname.toLowerCase()}`
  } catch {
    return ''
  }
}

export function isLocalProjectUrl(value) {
  try {
    const hostname = new URL(String(value).trim()).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname === '::1') return true

    const octets = hostname.split('.').map(Number)
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false
    }
    return octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
  } catch {
    return false
  }
}

function resolveCredential(entry, projects) {
  const urlMatches = projects.filter((project) => normalizeProjectUrl(project.url) === entry.normalizedUrl)
  const nameMatches = projects.filter((project) =>
    normalizeProjectName(project.name).toLocaleLowerCase('zh-CN') === entry.normalizedName)
  if (isLocalProjectUrl(entry.url)) {
    if (nameMatches.length > 1) {
      return { project: null, error: `KeyHub 中项目名匹配不唯一：${entry.name}` }
    }
    if (nameMatches.length === 1) {
      return {
        project: { ...nameMatches[0], url: entry.url },
        error: ''
      }
    }
    if (urlMatches.length === 1) {
      return {
        project: { ...urlMatches[0], url: entry.url },
        error: ''
      }
    }
    if (urlMatches.length > 1) {
      return { project: null, error: `KeyHub 中本地网址匹配不唯一，请使用准确的项目名：${entry.url}` }
    }
    return { project: null, error: `KeyHub 中找不到项目：${entry.name} / ${entry.url}` }
  }
  if (urlMatches.length > 1) {
    return { project: null, error: `KeyHub 中网址匹配不唯一：${entry.url}` }
  }
  if (urlMatches.length === 1) {
    if (nameMatches.length === 1 && nameMatches[0].id !== urlMatches[0].id) {
      return { project: null, error: `项目名称与网址指向不同的 KeyHub 项目：${entry.name}` }
    }
    return { project: urlMatches[0], error: '' }
  }
  if (nameMatches.length > 1) {
    return { project: null, error: `KeyHub 中项目名匹配不唯一：${entry.name}` }
  }
  if (nameMatches.length === 1) {
    return {
      project: null,
      error: `项目网址不一致：TXT 为 ${entry.url}，KeyHub 为 ${nameMatches[0].url}`
    }
  }
  return { project: null, error: `KeyHub 中找不到项目：${entry.name} / ${entry.url}` }
}

function resolveImageProject(entry, project, imageProjects, projectMap) {
  const byImportedName = imageProjects.filter((imageProject) => {
    const names = [imageProject.folderName, projectMap?.[imageProject.folderName]].filter(Boolean)
    return names.some((name) => normalizeProjectName(name).toLocaleLowerCase('zh-CN') === entry.normalizedName)
  })
  if (byImportedName.length === 1) return { imageProject: byImportedName[0], error: '' }
  if (byImportedName.length > 1) {
    return { imageProject: null, error: `素材文件夹匹配不唯一：${entry.name}` }
  }
  if (project) {
    const projectName = normalizeProjectName(project.name).toLocaleLowerCase('zh-CN')
    const byProjectName = imageProjects.filter((imageProject) => {
      const mappedName = projectMap?.[imageProject.folderName] || imageProject.folderName
      return normalizeProjectName(mappedName).toLocaleLowerCase('zh-CN') === projectName
    })
    if (byProjectName.length === 1) return { imageProject: byProjectName[0], error: '' }
    if (byProjectName.length > 1) {
      return { imageProject: null, error: `项目 ${project.name} 匹配到多个素材文件夹` }
    }
  }
  return { imageProject: null, error: `找不到素材文件夹：${entry.name}` }
}

function emptyImageProject(folderName, fieldKeys) {
  return {
    folderName,
    directory: '',
    groups: Object.fromEntries(fieldKeys.map((key) => [key, []])),
    selected: Object.fromEntries(fieldKeys.map((key) => [key, null])),
    issues: []
  }
}
