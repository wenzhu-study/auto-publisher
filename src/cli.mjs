import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { executeBatch, checkSites } from './batch.mjs'
import { DEFAULT_KEYHUB_URL, IMAGE_FIELDS } from './constants.mjs'
import { scanImageProjects } from './images.mjs'
import { fetchShopProjects, matchImageProjects, readProjectMap } from './projects.mjs'
import { createSeed } from './random.mjs'

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  printHelp()
  process.exit(0)
}

const startedAt = new Date()
const seed = args.seed || createSeed()
const cwd = process.cwd()
const imagesDir = path.resolve(cwd, args.images || '图片')
const mapPath = path.resolve(cwd, args.map || 'project-map.json')
const keyHubUrl = args.keyhub || process.env.KEYHUB_URL || DEFAULT_KEYHUB_URL

console.log('WP 图片自动上传工具')
console.log(`模式：${args.execute ? '正式上传' : args.checkSites ? '站点只读检查' : '素材与项目只读检查'}`)
console.log(`素材目录：${imagesDir}`)
console.log(`随机种子：${seed}`)

try {
  const [imageProjects, keyHubProjects, projectMap] = await Promise.all([
    scanImageProjects(imagesDir, seed),
    fetchShopProjects(keyHubUrl),
    readProjectMap(mapPath)
  ])
  let matched = matchImageProjects(imageProjects, keyHubProjects, projectMap)
  matched = filterProjects(matched, args.projects)

  if (matched.length === 0) throw new Error('没有选中任何素材项目')

  const invalid = matched.filter((item) => item.issues.length || item.matchError)
  printSummary(matched, invalid)
  if (invalid.length) {
    for (const item of invalid) {
      console.error(`\n[无效] ${item.folderName}`)
      if (item.matchError) console.error(`  - ${item.matchError}`)
      for (const issue of item.issues) console.error(`  - ${issue}`)
    }
    throw new Error(`存在 ${invalid.length} 个无效项目，未执行任何上传`)
  }

  const plan = matched.map(toPlanItem)
  if (!args.execute && !args.checkSites) {
    printSelections(plan)
    console.log('\n检查通过。以上操作尚未写入网站。')
    console.log(`正式执行：npm run upload -- --seed ${seed}`)
    process.exit(0)
  }

  if (args.checkSites && !args.execute) {
    const results = await checkSites(matched, printProgress)
    const report = buildReport({ mode: 'check-sites', startedAt, seed, imagesDir, plan, results })
    const reportPath = await writeReport(cwd, report)
    const failures = results.filter((result) => !result.ok)
    console.log(`\n站点检查完成：成功 ${results.length - failures.length}，失败 ${failures.length}`)
    console.log(`报告：${reportPath}`)
    process.exitCode = failures.length ? 1 : 0
  } else {
    console.log(`\n即将依次处理 ${matched.length} 个项目，并按 ${IMAGE_FIELDS.length} 个图片分类记录或上传素材。`)
    const results = await executeBatch(matched, printProgress)
    const report = buildReport({ mode: 'execute', startedAt, seed, imagesDir, plan, results })
    const reportPath = await writeReport(cwd, report)
    const failures = results.filter((result) => result.status === 'failed')
    const warnings = results.filter((result) => result.status === 'completed-with-warnings')
    console.log(`\n批量上传完成：成功 ${results.length - failures.length}，警告 ${warnings.length}，失败 ${failures.length}`)
    if (warnings.length) console.log(`有跳过字段：${warnings.map((item) => item.projectName).join('、')}`)
    if (failures.length) {
      console.log(`失败项目：${failures.map((item) => item.projectName).join('、')}`)
      for (const result of failures) {
        const details = result.summary?.failedFields || []
        console.error(`  ${result.projectName}：${details.length
          ? details.map((image) => `${image.label}/${image.field} ${image.statusLabel}（${image.filename}）：${image.error}`).join('；')
          : result.error}`)
      }
    }
    console.log(`报告：${reportPath}`)
    process.exitCode = failures.length ? 1 : 0
  }
} catch (error) {
  console.error(`\n错误：${error.message}`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const options = { execute: false, checkSites: false, help: false, projects: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--execute') options.execute = true
    else if (arg === '--check-sites') options.checkSites = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--images') options.images = takeValue(argv, ++index, arg)
    else if (arg === '--seed') options.seed = takeValue(argv, ++index, arg)
    else if (arg === '--keyhub') options.keyhub = takeValue(argv, ++index, arg)
    else if (arg === '--map') options.map = takeValue(argv, ++index, arg)
    else if (arg === '--project') options.projects.push(takeValue(argv, ++index, arg))
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function takeValue(argv, index, option) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数值`)
  return value
}

function filterProjects(projects, filters) {
  if (!filters.length) return projects
  const requested = new Set(filters.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean))
  const selected = projects.filter((item) => requested.has(item.folderName) || requested.has(item.project?.name))
  const found = new Set(selected.flatMap((item) => [item.folderName, item.project?.name]))
  const missing = [...requested].filter((name) => !found.has(name))
  if (missing.length) throw new Error(`--project 未找到：${missing.join('、')}`)
  return selected
}

function printSummary(projects, invalid) {
  console.log(`项目：${projects.length} 个；可执行：${projects.length - invalid.length} 个；异常：${invalid.length} 个`)
}

function printSelections(plan) {
  for (const item of plan) {
    const files = IMAGE_FIELDS.map((field) => `${field.key}=${item.selected[field.key]}`).join('；')
    console.log(`[计划] ${item.folderName} -> ${item.projectName}：${files}`)
  }
}

function printProgress(event) {
  const number = `${event.index + 1}/${event.total}`
  const name = event.item.project.name
  if (event.stage === 'checking') console.log(`[${number}] 检查 ${name}`)
  else if (event.stage === 'starting') console.log(`\n[${number}] 开始 ${name}`)
  else if (event.stage === 'uploading') console.log(`  [${event.field.key}] 开始上传：${event.filename}`)
  else if (event.stage === 'upload-succeeded') console.log(`  [${event.field.key}] 上传成功：${event.message}`)
  else if (event.stage === 'writing-image') console.log(`  [${event.field.key}] 写入并校验：${event.message}`)
  else if (event.stage === 'image-succeeded') console.log(`  [${event.field.key}] 完成：${event.message}`)
  else if (event.stage === 'image-skipped') console.warn(`  [${event.field.key}] 跳过：${event.message}`)
  else if (event.stage === 'upload-failed' || event.stage === 'write-failed') console.error(`  [${event.field.key}] 失败：${event.message}`)
  else if (event.stage === 'completed' || event.stage === 'completed-with-warnings') console.log(`  项目完成：${name}：${event.message}`)
  else if (event.stage === 'failed') console.error(`  项目失败：${name}：${event.message}`)
}

function toPlanItem(item) {
  return {
    folderName: item.folderName,
    projectName: item.project?.name || null,
    siteUrl: item.project?.url || null,
    selected: Object.fromEntries(
      Object.entries(item.selected).map(([field, filePath]) => [field, filePath ? path.basename(filePath) : null])
    )
  }
}

function buildReport({ mode, startedAt, seed, imagesDir, plan, results }) {
  const imageResults = results.flatMap((result) => Object.values(result.imageResults || {}))
  return {
    mode,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    seed,
    imagesDir,
    totalProjects: plan.length,
    completed: results.filter((item) => item.ok === true || ['completed', 'completed-with-warnings'].includes(item.status)).length,
    failed: results.filter((item) => item.ok === false || item.status === 'failed').length,
    warnings: results.filter((item) => item.status === 'completed-with-warnings' || item.warnings?.length).length,
    imageSucceeded: imageResults.filter((image) => image.status === 'succeeded').length,
    imageFailed: imageResults.filter((image) => ['upload-failed', 'write-failed'].includes(image.status)).length,
    imageSkipped: imageResults.filter((image) => image.status === 'skipped').length,
    plan,
    results
  }
}

async function writeReport(cwd, report) {
  const logsDir = path.join(cwd, 'logs')
  await mkdir(logsDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = path.join(logsDir, `${report.mode}-${timestamp}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return reportPath
}

function printHelp() {
  console.log(`
用法：node src/cli.mjs [参数]

默认只检查素材、匹配项目并显示随机选择，不写入网站。

参数：
  --execute            正式上传并写入网站
  --check-sites        只读检查每个站点的目标页面
  --project <名称>     只处理指定文件夹/项目；可重复，或用逗号分隔
  --seed <值>          固定随机选择，便于预览后原样执行
  --images <目录>      素材目录，默认 ./图片
  --keyhub <URL>       KeyHub 地址
  --map <JSON文件>     文件夹名到项目名映射，默认 ./project-map.json
  --help, -h           显示帮助
`)
}
