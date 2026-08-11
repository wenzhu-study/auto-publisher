export function buildResumeState(report, sourceReport = '', options = {}) {
  if (!report || report.mode !== 'upload') return null
  const allowRunning = options.allowRunning !== false
  const interrupted = ['cancelled', 'failed'].includes(report.status) ||
    (report.status === 'running' && allowRunning)
  const finished = ['completed', 'completed-with-errors', 'completed-with-warnings'].includes(report.status)
  if (!interrupted && !finished) return null

  const selectedFolders = unique((report.plan || []).map((item) => item?.folderName).filter(Boolean))
  const selectedFields = unique((report.plan || [])
    .flatMap((item) => Array.isArray(item?.processFields) ? item.processFields : [])
    .filter(Boolean))
  const selected = new Set(selectedFolders)
  const resultByFolder = new Map((report.results || [])
    .filter(Boolean)
    .filter((item) => item.folderName && selected.has(item.folderName))
    .map((item) => [item.folderName, item]))
  const retryFieldsByFolder = {}
  const targetSlugsByFolder = {}
  const notApplicableFieldsByFolder = {}
  const processedFolders = []
  for (const folder of selectedFolders) {
    const result = resultByFolder.get(folder)
    if (!result) {
      if (finished) processedFolders.push(folder)
      continue
    }
    const retryFields = getRetryFields(result)
    const images = Object.values(result.imageResults || {})
    const targetSlugs = Object.fromEntries(images
      .filter((image) => image.status === 'succeeded' && image.field && image.page)
      .map((image) => [image.field, image.page]))
    const notApplicableFields = unique(images.filter(isNotApplicableImage).map((image) => image.field).filter(Boolean))
    if (Object.keys(targetSlugs).length) targetSlugsByFolder[folder] = targetSlugs
    if (notApplicableFields.length) notApplicableFieldsByFolder[folder] = notApplicableFields
    if (retryFields === null) continue
    if (retryFields.length) retryFieldsByFolder[folder] = retryFields
    else processedFolders.push(folder)
  }
  const processed = new Set(processedFolders)
  const remainingFolders = selectedFolders.filter((folder) => !processed.has(folder))
  if (!remainingFolders.length) return null

  return {
    sourceReport,
    sourceStatus: report.status,
    seed: report.seed || '',
    projectText: report.projectText || '',
    projectListName: report.projectListName || '',
    importSummary: report.importSummary || null,
    total: selectedFolders.length,
    processed: processedFolders.length,
    remaining: remainingFolders.length,
    retryProjects: Object.keys(retryFieldsByFolder).length,
    selectedFolders,
    selectedFields,
    processedFolders,
    remainingFolders,
    retryFieldsByFolder,
    targetSlugsByFolder,
    notApplicableFieldsByFolder
  }
}

function getRetryFields(result) {
  const images = Object.values(result.imageResults || {})
  if (!images.length) return (result.status === 'failed' || result.ok === false) ? null : []
  return unique(images
    .filter((image) => image.status !== 'succeeded' && !isNotApplicableImage(image))
    .map((image) => image.field)
    .filter(Boolean))
}

function isNotApplicableImage(image) {
  return image?.status === 'not-applicable' ||
    (image?.status === 'skipped' && /^找不到 (?:页面|产品标签) slug=/.test(String(image.reason || '')))
}

function unique(values) {
  return [...new Set(values)]
}
