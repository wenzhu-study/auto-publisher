import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { IMAGE_FIELDS, SUPPORTED_EXTENSIONS } from './constants.mjs'
import { chooseDeterministically } from './random.mjs'

export function classifyImageName(filename) {
  const lowerName = String(filename).toLowerCase()
  const extension = path.extname(lowerName)
  const field = IMAGE_FIELDS.find((item) => lowerName.startsWith(item.prefix))
  if (!field) return { kind: 'unknown', filename }
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return { kind: 'unsupported', filename, field, extension }
  }
  return { kind: 'image', filename, field, extension }
}

export async function scanImageProjects(imagesDir, seed) {
  const entries = await readdir(imagesDir, { withFileTypes: true })
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => sortChinese(left.name, right.name))
  const projects = []

  for (const folder of folders) {
    const directory = path.join(imagesDir, folder.name)
    const fileEntries = await readdir(directory, { withFileTypes: true })
    const filenames = fileEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(sortChinese)
    const groups = Object.fromEntries(IMAGE_FIELDS.map((field) => [field.key, []]))
    const issues = []

    for (const filename of filenames) {
      const classified = classifyImageName(filename)
      if (classified.kind === 'image') {
        groups[classified.field.key].push(path.join(directory, filename))
      } else if (classified.kind === 'unsupported') {
        issues.push(`文件格式不支持：${filename}`)
      } else {
        issues.push(`无法识别文件名前缀：${filename}`)
      }
    }

    for (const field of IMAGE_FIELDS) {
      if (groups[field.key].length === 0) {
        issues.push(`缺少 ${field.label}（文件名应以 ${field.prefix} 开头）`)
      }
    }

    const selected = Object.fromEntries(
      IMAGE_FIELDS.map((field) => [
        field.key,
        chooseDeterministically(groups[field.key], seed, `${folder.name}:${field.key}`)
      ])
    )

    projects.push({
      folderName: folder.name,
      directory,
      groups,
      selected,
      issues
    })
  }

  return projects
}

function sortChinese(left, right) {
  return left.localeCompare(right, 'zh-CN')
}
