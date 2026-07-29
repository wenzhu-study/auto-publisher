export function buildResumeState(report, sourceReport = '', options = {}) {
  if (!report || report.mode !== 'upload') return null
  const allowRunning = options.allowRunning !== false
  if (report.status !== 'cancelled' && !(report.status === 'running' && allowRunning)) return null

  const selectedFolders = unique((report.plan || []).map((item) => item?.folderName).filter(Boolean))
  const selected = new Set(selectedFolders)
  const resultByFolder = new Map((report.results || [])
    .filter(Boolean)
    .filter((item) => item.folderName && selected.has(item.folderName))
    .map((item) => [item.folderName, item]))
  const retryFieldsByFolder = {}
  const processedFolders = []
  for (const folder of selectedFolders) {
    const result = resultByFolder.get(folder)
    if (!result) continue
    const retryFields = getRetryFields(result)
    if (retryFields === null) continue
    if (retryFields.length) retryFieldsByFolder[folder] = retryFields
    else processedFolders.push(folder)
  }
  const processed = new Set(processedFolders)
  const remainingFolders = selectedFolders.filter((folder) => !processed.has(folder))
  if (!remainingFolders.length) return null

  return {
    sourceReport,
    seed: report.seed || '',
    total: selectedFolders.length,
    processed: processedFolders.length,
    remaining: remainingFolders.length,
    retryProjects: Object.keys(retryFieldsByFolder).length,
    selectedFolders,
    processedFolders,
    remainingFolders,
    retryFieldsByFolder
  }
}

function getRetryFields(result) {
  const images = Object.values(result.imageResults || {})
  if (!images.length) return (result.status === 'failed' || result.ok === false) ? null : []
  return unique(images
    .filter((image) => image.status !== 'succeeded')
    .map((image) => image.field)
    .filter(Boolean))
}

function unique(values) {
  return [...new Set(values)]
}
