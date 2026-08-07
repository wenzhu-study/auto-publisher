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

export async function scanImageProjects(
  imagesDir,
  seed,
  fieldKeys = IMAGE_FIELDS.map((field) => field.key),
  options = {}
) {
  const requiredFields = new Set(fieldKeys)
  let entries
  try {
    entries = await readdir(imagesDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' && options.allowMissingRoot) return []
    if (error.code === 'ENOENT') throw new Error(`图片文件夹不存在：${imagesDir}，请重新选择图片文件夹`)
    throw error
  }
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
        if (requiredFields.has(classified.field.key)) issues.push(`文件格式不支持：${filename}`)
      }
    }

    for (const field of IMAGE_FIELDS.filter((item) => requiredFields.has(item.key) && !item.optional)) {
      if (groups[field.key].length === 0) {
        issues.push(`缺少 ${field.label}（文件名应以 ${field.prefix} 开头）`)
      }
    }

    const selected = Object.fromEntries(
      IMAGE_FIELDS.map((field) => [
        field.key,
        requiredFields.has(field.key)
          ? chooseDeterministically(groups[field.key], seed, `${folder.name}:${field.key}`)
          : null
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
