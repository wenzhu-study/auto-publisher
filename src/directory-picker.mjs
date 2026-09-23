import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export async function resolveBrowserSelectedDirectory(
  rootNameValue,
  relativePathValues,
  options = {}
) {
  const rootName = String(rootNameValue || '').trim()
  if (!rootName || path.basename(rootName) !== rootName || ['.', '..'].includes(rootName)) {
    throw new Error('浏览器返回的图片文件夹名称无效')
  }

  const relativePaths = [...new Set(Array.isArray(relativePathValues) ? relativePathValues : [])]
    .map(normalizeBrowserRelativePath)
    .filter(Boolean)
    .slice(0, 80)
  if (!relativePaths.length) throw new Error('选择的文件夹中没有可读取的文件')

  const candidateBases = uniquePaths(options.candidateBases || [])
  const directCandidates = new Set()
  for (const base of candidateBases) {
    if (sameName(path.basename(base), rootName)) directCandidates.add(base)
    directCandidates.add(path.resolve(base, rootName))
  }

  const directMatches = await matchingDirectories(directCandidates, relativePaths)
  if (directMatches.length === 1) return directMatches[0]
  if (directMatches.length > 1) throw multipleMatchesError(rootName)

  const nestedCandidates = await findNamedDirectories(
    options.searchBases || candidateBases,
    rootName,
    options.maxDepth ?? 3,
    options.maxDirectories ?? 5000
  )
  const nestedMatches = await matchingDirectories(nestedCandidates, relativePaths)
  if (nestedMatches.length === 1) return nestedMatches[0]
  if (nestedMatches.length > 1) throw multipleMatchesError(rootName)
  throw new Error(`本地服务无法定位所选文件夹“${rootName}”，请确认文件夹位于项目目录或桌面附近后重试`)
}

export function normalizeBrowserRelativePath(value) {
  const segments = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean)
  if (segments.length < 2 || segments.some((segment) => segment === '.' || segment === '..')) return ''
  return path.join(...segments.slice(1))
}

async function matchingDirectories(candidates, relativePaths) {
  const matches = []
  for (const candidate of candidates) {
    if (!await isDirectory(candidate)) continue
    const probesMatch = await Promise.all(relativePaths.map((relativePath) =>
      stat(path.join(candidate, relativePath)).then((info) => info.isFile()).catch(() => false)))
    if (probesMatch.every(Boolean)) matches.push(path.resolve(candidate))
  }
  return [...new Set(matches)]
}

async function findNamedDirectories(baseValues, rootName, maxDepth, maxDirectories) {
  const queue = uniquePaths(baseValues).map((directory) => ({ directory, depth: 0 }))
  const visited = new Set()
  const matches = new Set()
  let scanned = 0

  while (queue.length && scanned < maxDirectories) {
    const current = queue.shift()
    const key = pathKey(current.directory)
    if (visited.has(key)) continue
    visited.add(key)

    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const directory = path.join(current.directory, entry.name)
      scanned += 1
      if (sameName(entry.name, rootName)) matches.add(path.resolve(directory))
      if (current.depth + 1 < maxDepth && scanned < maxDirectories) {
        queue.push({ directory, depth: current.depth + 1 })
      }
    }
  }

  return matches
}

async function isDirectory(value) {
  const info = await stat(value).catch(() => null)
  return Boolean(info?.isDirectory())
}

function uniquePaths(values) {
  return [...new Map(values
    .filter(Boolean)
    .map((value) => {
      const resolved = path.resolve(value)
      return [pathKey(resolved), resolved]
    })).values()]
}

function pathKey(value) {
  return path.resolve(value).toLocaleLowerCase('zh-CN')
}

function sameName(left, right) {
  return String(left).toLocaleLowerCase('zh-CN') === String(right).toLocaleLowerCase('zh-CN')
}

function multipleMatchesError(rootName) {
  return new Error(`找到多个内容相同的图片文件夹：${rootName}，请将目标文件夹改为唯一名称后重试`)
}
