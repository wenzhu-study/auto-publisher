import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { DEFAULT_KEYHUB_URL } from '../src/constants.mjs'
import { fetchShopProjects } from '../src/projects.mjs'
import { resolvePublisherTargets } from '../src/wordpress.mjs'

const keyHubUrl = process.env.KEYHUB_URL || DEFAULT_KEYHUB_URL
const outputDir = path.resolve(process.argv[2] || '.')
const emptyPath = path.join(outputDir, 'agentcy-empty-projects.txt')
const errorPath = path.join(outputDir, 'agentcy-check-errors.txt')
const field = { key: 'agentcy', pageSlug: 'agentcy', targetType: 'page-featured' }
const concurrency = 10

const projects = await fetchShopProjects(keyHubUrl, { timeoutMs: 30000 })
const results = new Array(projects.length)
let nextIndex = 0
let finished = 0

console.log(`开始检查 ${projects.length} 个项目的 agentcy/agency 页面特色图片...`)

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (true) {
    const index = nextIndex
    nextIndex += 1
    if (index >= projects.length) return
    const project = projects[index]
    try {
      const resolved = await resolvePublisherTargets(project, [field], {
        timeoutMs: 20000,
        retries: 0
      })
      const value = resolved.agentcy
      if (!value?.target) {
        results[index] = { project, status: 'missing-page', detail: value?.reason || '找不到 agentcy/agency 页面' }
      } else if (Number(value.target.featuredMedia) > 0) {
        results[index] = { project, status: 'filled', target: value.target }
      } else {
        results[index] = { project, status: 'empty', target: value.target }
      }
    } catch (error) {
      results[index] = { project, status: 'error', detail: error.message }
    }
    finished += 1
    if (finished % 25 === 0 || finished === projects.length) {
      console.log(`已检查 ${finished}/${projects.length}`)
    }
  }
}))

const empty = results.filter((item) => item?.status === 'empty')
const errors = results.filter((item) => ['missing-page', 'error'].includes(item?.status))
const filled = results.filter((item) => item?.status === 'filled')

await mkdir(outputDir, { recursive: true })
await writeFile(emptyPath, textLines(empty.map(({ project }) => `${project.name}：${project.url}`)), 'utf8')
await writeFile(errorPath, textLines(errors.map(({ project, status, detail }) =>
  `${project.name}：${project.url} | ${status === 'missing-page' ? '找不到 agentcy/agency 页面' : '检查失败'} | ${detail}`)), 'utf8')

console.log(JSON.stringify({
  total: projects.length,
  filled: filled.length,
  empty: empty.length,
  errors: errors.length,
  emptyPath,
  errorPath
}, null, 2))

function textLines(lines) {
  return lines.length ? `${lines.join('\r\n')}\r\n` : ''
}
