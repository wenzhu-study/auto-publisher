import { createServer } from 'node:http'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { executeBatch, checkSites } from './batch.mjs'
import { DEFAULT_KEYHUB_URL, IMAGE_FIELDS } from './constants.mjs'
import { scanImageProjects } from './images.mjs'
import { fetchShopProjects, matchImageProjects, readProjectMap } from './projects.mjs'
import { matchImportedProjects } from './project-list.mjs'
import { createSeed } from './random.mjs'
import { buildResumeState } from './resume.mjs'

const HOST = process.env.UI_HOST || '127.0.0.1'
const PORT = positiveInteger(process.env.UI_PORT) || 3580
const ROOT = process.cwd()
const WEB_DIR = path.join(ROOT, 'web')
const DEFAULT_IMAGES_DIR = path.resolve(ROOT, process.env.IMAGES_DIR || '图片')
const SETTINGS_PATH = path.join(ROOT, 'logs', 'local-settings.json')
const SETTINGS_FILE = path.basename(SETTINGS_PATH)
const MAP_PATH = path.resolve(ROOT, process.env.PROJECT_MAP || 'project-map.json')
const KEYHUB_URL = process.env.KEYHUB_URL || DEFAULT_KEYHUB_URL
const jobs = new Map()
let activeJobId = ''
let imagesDir = await loadImagesDirectory()

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url)
      return
    }
    await serveStatic(response, url.pathname)
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message || String(error) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`WP 图片自动上传控制台：http://${HOST}:${PORT}`)
  console.log('按 Ctrl+C 停止本地服务。')
})

async function handleApi(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/api/images-directory/browser-select') {
    const runningJob = activeJobId ? jobs.get(activeJobId) : null
    if (runningJob?.status === 'running') {
      return sendJson(response, 409, { ok: false, error: '任务运行期间不能切换图片文件夹' })
    }
    const body = await readJsonBody(request)
    const selectedPath = await resolveBrowserSelectedDirectory(body.rootName, body.relativePaths)
    imagesDir = await validateImagesDirectory(selectedPath)
    await saveImagesDirectory(imagesDir)
    await dismissResumeHistory()
    return sendJson(response, 200, { ok: true, imagesDir, imagesDirAvailable: true })
  }

  if (request.method === 'POST' && url.pathname === '/api/images-directory/select') {
    return sendJson(response, 410, { ok: false, error: '文件夹选择方式已更新，请刷新页面后重试' })
  }

  if (request.method === 'POST' && url.pathname === '/api/resume/dismiss') {
    await dismissResumeHistory()
    return sendJson(response, 200, { ok: true })
  }

  if (request.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(response, 200, {
      ok: true,
      imagesDir,
      keyHubUrl: KEYHUB_URL,
      features: {
        fieldSelection: true,
        projectListImport: true,
        projectListLocalUrls: true,
        directoryPicker: true,
        browserDirectoryPicker: true,
        imageFieldSchema: 8
      },
      fields: IMAGE_FIELDS.map(({ key, label, prefix, pageSlug, ratio, optional, targetType }) => ({
        key,
        label,
        prefix,
        pageSlug,
        ratio,
        optional: Boolean(optional),
        targetType: targetType || 'acf-field'
      })),
      imagesDirAvailable: await isDirectory(imagesDir),
      seed: createSeed()
    })
  }

  if (['GET', 'POST'].includes(request.method) && url.pathname === '/api/plan') {
    const body = request.method === 'POST' ? await readJsonBody(request) : {}
    const seed = String(body.seed || url.searchParams.get('seed') || '').trim() || createSeed()
    const fieldKeys = request.method === 'POST'
      ? normalizeFieldKeys(body.fields)
      : url.searchParams.has('fields')
        ? normalizeFieldKeys(url.searchParams.get('fields')?.split(',') || [])
        : IMAGE_FIELDS.map((field) => field.key)
    const projectText = normalizeProjectText(body.projectText)
    const plan = await buildPlan(seed, fieldKeys, projectText)
    return sendJson(response, 200, {
      ok: true,
      seed: plan.seed,
      summary: plan.summary,
      importSummary: plan.importSummary,
      projects: plan.projects
    })
  }

  if (request.method === 'GET' && url.pathname === '/api/job/active') {
    const job = activeJobId ? jobs.get(activeJobId) : null
    return sendJson(response, 200, { ok: true, job: job ? publicJob(job) : null })
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/)
  if (request.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1])
    if (!job) return sendJson(response, 404, { ok: false, error: '任务不存在' })
    return sendJson(response, 200, { ok: true, job: publicJob(job) })
  }

  const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/)
  if (request.method === 'POST' && cancelMatch) {
    const job = jobs.get(cancelMatch[1])
    if (!job) return sendJson(response, 404, { ok: false, error: '任务不存在' })
    if (job.status === 'running') {
      job.cancelRequested = true
      addEvent(job, { stage: 'cancel-requested', message: '已请求停止，将在当前项目结束后停止' })
    }
    return sendJson(response, 200, { ok: true, job: publicJob(job) })
  }

  if (request.method === 'GET' && url.pathname === '/api/reports') {
    return sendJson(response, 200, { ok: true, reports: await listReports() })
  }

  if (request.method === 'GET' && url.pathname === '/api/resume') {
    return sendJson(response, 200, { ok: true, resume: await findLatestResume() })
  }

  const reportMatch = url.pathname.match(/^\/api\/reports\/([^/]+)$/)
  if (request.method === 'GET' && reportMatch) {
    const name = decodeURIComponent(reportMatch[1])
    return sendJson(response, 200, { ok: true, report: await readReport(name) })
  }

  if (request.method === 'POST' && (url.pathname === '/api/check' || url.pathname === '/api/upload')) {
    const mode = url.pathname === '/api/upload' ? 'upload' : 'check'
    const body = await readJsonBody(request)
    if (mode === 'upload' && body.confirmation !== 'UPLOAD') {
      return sendJson(response, 400, { ok: false, error: '正式上传需要确认' })
    }
    const runningJob = activeJobId ? jobs.get(activeJobId) : null
    if (runningJob?.status === 'running') {
      return sendJson(response, 409, { ok: false, error: '已有任务正在运行，请等待或先停止当前任务' })
    }

    const seed = String(body.seed || '').trim() || createSeed()
    const fieldKeys = normalizeFieldKeys(body.fields)
    if (!fieldKeys.length) {
      return sendJson(response, 400, { ok: false, error: '请至少选择一个图片分类' })
    }
    const projectText = normalizeProjectText(body.projectText)
    const plan = await buildPlan(seed, fieldKeys, projectText)
    const requested = new Set(Array.isArray(body.projects) ? body.projects.map(String) : [])
    const selected = requested.size
      ? plan.internal.filter((item) => requested.has(item.folderName))
      : plan.internal
    if (!selected.length) return sendJson(response, 400, { ok: false, error: '没有选择任何项目' })
    const invalid = selected.filter((item) => item.matchError || item.issues.length)
    if (invalid.length) {
      return sendJson(response, 400, { ok: false, error: `有 ${invalid.length} 个项目未通过素材或项目匹配检查` })
    }
    const resumeFields = body.resumeFields && typeof body.resumeFields === 'object' && !Array.isArray(body.resumeFields)
      ? body.resumeFields
      : {}
    const allowedFields = new Set(fieldKeys)
    const executionSelected = selected.map((item) => {
      const requestedFields = Array.isArray(resumeFields[item.folderName])
        ? [...new Set(resumeFields[item.folderName].map(String).filter((field) => allowedFields.has(field)))]
        : []
      return { ...item, fieldsToProcess: requestedFields.length ? requestedFields : fieldKeys }
    })

    const job = {
      id: randomUUID(),
      mode,
      seed,
      projectText,
      projectListName: String(body.projectListName || '').slice(0, 200),
      importSummary: plan.importSummary,
      status: 'running',
      cancelRequested: false,
      total: executionSelected.length,
      completed: 0,
      failed: 0,
      warnings: 0,
      imageSucceeded: 0,
      imageFailed: 0,
      imageSkipped: 0,
      startedAt: new Date().toISOString(),
      finishedAt: '',
      selectedFolders: executionSelected.map((item) => item.folderName),
      plan: executionSelected.map(toPublicPlanItem),
      events: [],
      results: [],
      reportPath: '',
      reportWrite: Promise.resolve()
    }
    jobs.set(job.id, job)
    activeJobId = job.id
    addEvent(job, { stage: 'started', message: mode === 'upload' ? '正式上传任务已开始' : '站点检查任务已开始' })
    runJob(job, executionSelected).catch((error) => {
      job.status = 'failed'
      job.finishedAt = new Date().toISOString()
      addEvent(job, { stage: 'fatal', message: error.message })
    })
    return sendJson(response, 202, { ok: true, job: publicJob(job) })
  }

  sendJson(response, 404, { ok: false, error: '接口不存在' })
}

async function buildPlan(seed, fieldKeys = IMAGE_FIELDS.map((field) => field.key), projectText = '') {
  const [imageProjects, keyHubProjects, projectMap] = await Promise.all([
    scanImageProjects(imagesDir, seed, fieldKeys, { allowMissingRoot: Boolean(projectText) }),
    fetchShopProjects(KEYHUB_URL),
    readProjectMap(MAP_PATH)
  ])
  const imported = projectText
    ? matchImportedProjects(
        imageProjects,
        keyHubProjects,
        projectMap,
        projectText,
        IMAGE_FIELDS.map((field) => field.key)
      )
    : null
  const internal = (imported?.projects || matchImageProjects(imageProjects, keyHubProjects, projectMap))
    .map((item) => ({ ...item, fieldsToProcess: fieldKeys }))
  const projects = internal.map(toPublicPlanItem)
  const valid = projects.filter((item) => item.valid).length
  return {
    seed,
    summary: { total: projects.length, valid, invalid: projects.length - valid },
    importSummary: imported?.summary || null,
    projects,
    internal
  }
}

async function runJob(job, selected) {
  const onProgress = (event) => {
    const terminalStages = ['completed', 'completed-with-warnings', 'failed', 'checked', 'checked-with-warnings', 'check-failed']
    if (event.result) job.results[event.index] = event.result
    if (terminalStages.includes(event.stage)) {
      job.completed += 1
      if (event.stage === 'failed' || event.stage === 'check-failed') job.failed += 1
      if (event.stage === 'completed-with-warnings' || event.stage === 'checked-with-warnings') job.warnings += 1
      queueJobReport(job)
    }
    if (event.stage === 'image-succeeded') job.imageSucceeded += 1
    if (event.stage === 'upload-failed' || event.stage === 'write-failed') job.imageFailed += 1
    if (event.stage === 'image-skipped') job.imageSkipped += 1
    addEvent(job, {
      stage: event.stage,
      index: event.index,
      projectName: event.item?.project?.name || '',
      fieldKey: event.field?.key || '',
      fieldLabel: event.field?.label || '',
      filename: event.filename || '',
      message: event.message || event.result?.error || event.result?.warnings?.join('；') || ''
    })
  }
  const shouldContinue = () => !job.cancelRequested
  job.results = job.mode === 'upload'
    ? await executeBatch(selected, onProgress, shouldContinue)
    : await checkSites(selected, onProgress, job.projectText ? 1 : 5, shouldContinue)
  job.finishedAt = new Date().toISOString()
  job.status = job.cancelRequested ? 'cancelled' : job.failed ? 'completed-with-errors' : 'completed'
  await queueJobReport(job)
  addEvent(job, {
    stage: job.status,
    message: job.cancelRequested ? '任务已停止' : job.failed ? `任务结束，失败 ${job.failed} 个` : '任务全部完成'
  })
}

function addEvent(job, value) {
  job.events.push({ id: job.events.length + 1, at: new Date().toISOString(), ...value })
  if (job.events.length > 3000) job.events.splice(0, job.events.length - 3000)
}

function publicJob(job) {
  return {
    id: job.id,
    mode: job.mode,
    seed: job.seed,
    projectText: job.projectText,
    projectListName: job.projectListName,
    importSummary: job.importSummary,
    status: job.status,
    cancelRequested: job.cancelRequested,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    warnings: job.warnings,
    imageSucceeded: job.imageSucceeded,
    imageFailed: job.imageFailed,
    imageSkipped: job.imageSkipped,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    selectedFolders: job.selectedFolders,
    plan: job.plan,
    events: job.events,
    results: job.results,
    reportPath: job.reportPath ? path.relative(ROOT, job.reportPath) : ''
  }
}

function toPublicPlanItem(item) {
  return {
    folderName: item.folderName,
    projectName: item.project?.name || '',
    siteUrl: item.project?.url || item.importUrl || '',
    importOrder: item.importOrder || null,
    importName: item.importName || '',
    importUrl: item.importUrl || '',
    valid: !item.matchError && item.issues.length === 0,
    issues: [item.matchError, ...item.issues].filter(Boolean),
    processFields: Array.isArray(item.fieldsToProcess)
      ? item.fieldsToProcess
      : IMAGE_FIELDS.map((field) => field.key),
    counts: Object.fromEntries(IMAGE_FIELDS.map((field) => [field.key, item.groups[field.key].length])),
    selected: Object.fromEntries(
      Object.entries(item.selected).map(([field, filePath]) => [field, filePath ? path.basename(filePath) : null])
    )
  }
}

async function writeJobReport(job) {
  const logsDir = path.join(ROOT, 'logs')
  await mkdir(logsDir, { recursive: true })
  if (!job.reportPath) {
    const timestamp = job.startedAt.replace(/[:.]/g, '-')
    job.reportPath = path.join(logsDir, `ui-${job.mode}-${timestamp}-${job.id.slice(0, 8)}.json`)
  }
  const report = {
    mode: job.mode,
    projectListName: job.projectListName,
    importSummary: job.importSummary,
    projectText: job.projectText,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    seed: job.seed,
    totalProjects: job.total,
    completed: job.completed,
    succeeded: Math.max(0, job.completed - job.failed),
    failed: job.failed,
    warnings: job.warnings,
    imageSucceeded: job.imageSucceeded,
    imageFailed: job.imageFailed,
    imageSkipped: job.imageSkipped,
    status: job.status,
    plan: job.plan,
    results: job.results
  }
  await writeFile(job.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return job.reportPath
}

function queueJobReport(job) {
  job.reportWrite = (job.reportWrite || Promise.resolve())
    .catch(() => {})
    .then(() => writeJobReport(job))
  return job.reportWrite
}

async function listReports() {
  const logsDir = path.join(ROOT, 'logs')
  try {
    const names = (await readdir(logsDir)).filter(isReportFile).sort().reverse().slice(0, 30)
    return Promise.all(names.map(async (name) => {
      const filePath = path.join(logsDir, name)
      try {
        const [content, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
        const report = JSON.parse(content)
        return {
          name,
          modifiedAt: info.mtime.toISOString(),
          mode: report.mode || '',
          total: report.totalProjects ?? report.totalTasks ?? 0,
          completed: report.completed ?? 0,
          succeeded: report.succeeded ?? countSuccessfulProjects(report),
          failed: report.failed ?? 0,
          warnings: report.warnings ?? 0,
          imageSucceeded: report.imageSucceeded ?? countReportImages(report, 'succeeded'),
          imageFailed: report.imageFailed ?? countReportImages(report, ['upload-failed', 'write-failed']),
          imageSkipped: report.imageSkipped ?? countReportImages(report, 'skipped'),
          issues: countReportProblems(report),
          status: report.status || ''
        }
      } catch {
        return { name, invalid: true }
      }
    }))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readReport(name) {
  if (name !== path.basename(name) || !/^[-\w.]+\.json$/i.test(name)) {
    throw new Error('报告文件名无效')
  }
  const filePath = path.join(ROOT, 'logs', name)
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('报告不存在')
    throw new Error(`报告读取失败：${error.message}`)
  }
}

async function findLatestResume() {
  const logsDir = path.join(ROOT, 'logs')
  let names
  try {
    names = await readdir(logsDir)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }

  const candidates = await Promise.all(names.filter(isReportFile).map(async (name) => {
    const filePath = path.join(logsDir, name)
    try {
      const [content, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
      return { name, report: JSON.parse(content), modifiedAt: info.mtimeMs }
    } catch {
      return null
    }
  }))
  const latestUpload = candidates
    .filter((candidate) => candidate?.report?.mode === 'upload')
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
  if (!latestUpload) return null

  const settings = await readLocalSettings()
  if (latestUpload.modifiedAt <= Number(settings.resumeDismissedBefore || 0)) return null

  const activeJob = activeJobId ? jobs.get(activeJobId) : null
  return buildResumeState(latestUpload.report, latestUpload.name, {
    allowRunning: activeJob?.status !== 'running'
  })
}

function countReportImages(report, statuses) {
  const accepted = new Set(Array.isArray(statuses) ? statuses : [statuses])
  return (report.results || []).reduce((count, result) => count +
    Object.values(result.imageResults || {}).filter((image) => accepted.has(image.status)).length, 0)
}

function countReportProblems(report) {
  const problemStatuses = new Set(['upload-failed', 'write-failed', 'skipped', 'not-processed'])
  return (report.results || []).reduce((count, result) => {
    if (!result) return count
    const images = Object.values(result.imageResults || {})
      .filter((image) => problemStatuses.has(image.status)).length
    if (images) return count + images
    return count + ((result.status === 'failed' || result.ok === false) ? 1 : 0)
  }, 0)
}

function countSuccessfulProjects(report) {
  return (report.results || []).filter((result) =>
    result.ok === true || ['completed', 'completed-with-warnings'].includes(result.status)).length
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const filePath = path.resolve(WEB_DIR, requested)
  if (filePath !== WEB_DIR && !filePath.startsWith(`${WEB_DIR}${path.sep}`)) {
    return sendJson(response, 403, { ok: false, error: '禁止访问' })
  }
  try {
    const content = await readFile(filePath)
    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    })
    response.end(content)
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(response, 404, { ok: false, error: '页面不存在' })
    throw error
  }
}

async function loadImagesDirectory() {
  if (process.env.IMAGES_DIR) return DEFAULT_IMAGES_DIR
  try {
    const settings = await readLocalSettings()
    return await validateImagesDirectory(settings.imagesDir)
  } catch {
    return DEFAULT_IMAGES_DIR
  }
}

async function saveImagesDirectory(directory) {
  await updateLocalSettings({ imagesDir: directory })
}

async function dismissResumeHistory() {
  await updateLocalSettings({ resumeDismissedBefore: Date.now() })
  const activeJob = activeJobId ? jobs.get(activeJobId) : null
  if (activeJob?.status !== 'running') activeJobId = ''
}

async function readLocalSettings() {
  try {
    const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    return {}
  }
}

async function updateLocalSettings(patch) {
  const settings = { ...(await readLocalSettings()), ...patch }
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true })
  await writeFile(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

async function validateImagesDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('图片文件夹路径为空')
  const directory = path.resolve(value.trim())
  const info = await stat(directory).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`图片文件夹不存在：${directory}`)
  return directory
}

async function isDirectory(value) {
  const info = await stat(value).catch(() => null)
  return Boolean(info?.isDirectory())
}

async function resolveBrowserSelectedDirectory(rootNameValue, relativePathValues) {
  const rootName = String(rootNameValue || '').trim()
  if (!rootName || path.basename(rootName) !== rootName || ['.', '..'].includes(rootName)) {
    throw new Error('浏览器返回的图片文件夹名称无效')
  }

  const relativePaths = [...new Set(Array.isArray(relativePathValues) ? relativePathValues : [])]
    .map(normalizeBrowserRelativePath)
    .filter(Boolean)
    .slice(0, 80)
  if (!relativePaths.length) throw new Error('选择的文件夹中没有可读取的文件')

  const candidateBases = directoryCandidateBases()
  const candidates = new Set()
  for (const base of candidateBases) {
    if (path.basename(base).toLocaleLowerCase('zh-CN') === rootName.toLocaleLowerCase('zh-CN')) {
      candidates.add(path.resolve(base))
    }
    candidates.add(path.resolve(base, rootName))
  }

  const matches = []
  for (const candidate of candidates) {
    if (!await isDirectory(candidate)) continue
    const probesMatch = await Promise.all(relativePaths.map((relativePath) =>
      stat(path.join(candidate, relativePath)).then((info) => info.isFile()).catch(() => false)))
    if (probesMatch.every(Boolean)) matches.push(candidate)
  }

  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`找到多个同名图片文件夹：${rootName}，请保留唯一目录后重试`)
  throw new Error(`本地服务无法定位所选文件夹“${rootName}”，请将它放在项目同级目录或桌面后重试`)
}

function normalizeBrowserRelativePath(value) {
  const segments = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean)
  if (segments.length < 2 || segments.some((segment) => segment === '.' || segment === '..')) return ''
  return path.join(...segments.slice(1))
}

function directoryCandidateBases() {
  const values = [ROOT, imagesDir, os.homedir()]
  let current = ROOT
  while (true) {
    values.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const base of [os.homedir(), process.env.USERPROFILE, process.env.OneDrive]) {
    if (!base) continue
    values.push(base, path.join(base, 'Desktop'), path.join(base, 'Downloads'), path.join(base, 'Documents'), path.join(base, 'Pictures'))
  }
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))]
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new Error('请求 JSON 格式无效')
  }
}

function sendJson(response, status, value) {
  if (response.headersSent) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  })
  response.end(JSON.stringify(value))
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  }[extension] || 'application/octet-stream'
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : 0
}

function normalizeFieldKeys(values) {
  const requested = new Set(Array.isArray(values) ? values.map(String) : [])
  return IMAGE_FIELDS.map((field) => field.key).filter((key) => requested.has(key))
}

function normalizeProjectText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isReportFile(name) {
  return name !== SETTINGS_FILE && name.endsWith('.json')
}
