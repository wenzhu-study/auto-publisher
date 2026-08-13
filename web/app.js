const FIELD_LABELS = {
  ap_img: '应用场景 · 16:9',
  af_img: '售后服务 · 1:1',
  hp_img: '手机 HotProducts · 3:1',
  mo_banner: '手机 Banner · 16:9',
  pt_img: 'Price List · 9:16'
}

const state = {
  seed: '',
  fields: [],
  selectedFields: new Set(),
  projectText: '',
  projectListName: '',
  importSummary: null,
  imagesDirAvailable: false,
  projects: [],
  selected: new Set(),
  activeJob: null,
  resume: null,
  issueReport: null,
  issueReportName: '',
  reportDetail: null,
  reportDetailFilter: 'all',
  pollingTimer: 0,
  loading: false,
  selectingDirectory: false,
  projectListLoading: false
}

const elements = Object.fromEntries(
  [
    'images-path', 'connection-state', 'refresh-button', 'seed-input', 'random-seed-button',
    'project-list-state', 'project-file-input', 'image-directory-input', 'import-projects-button', 'clear-projects-button', 'select-images-button',
    'field-options', 'select-all-fields', 'selected-field-count', 'field-count-total',
    'summary-total', 'summary-selected', 'summary-valid', 'summary-invalid', 'search-input',
    'status-filter', 'selected-filter', 'visible-count', 'select-all', 'project-body', 'empty-state',
    'progress-tab', 'issues-tab', 'reports-tab', 'progress-panel', 'issues-panel', 'reports-panel',
    'issue-count', 'issue-callout', 'issue-callout-count', 'issues-source', 'issue-list', 'job-badge', 'job-fraction',
    'progress-bar', 'job-completed', 'job-failed', 'event-list', 'report-list', 'action-selection',
    'image-succeeded', 'image-failed', 'image-skipped', 'report-dialog', 'report-detail-title',
    'report-detail-meta', 'report-detail-summary', 'report-detail-body',
    'action-seed', 'stop-button', 'check-button', 'upload-button', 'upload-dialog',
    'resume-button', 'restart-batch-button',
    'dialog-project-count', 'dialog-image-count', 'dialog-missing-count', 'dialog-seed', 'dialog-fields',
    'confirm-checkbox', 'confirm-upload-button', 'toast-region'
  ].map((id) => [id, document.getElementById(id)])
)

boot()

async function boot() {
  bindEvents()
  refreshIcons()
  try {
    const [config, resumeResult] = await Promise.all([
      api('/api/config'),
      api('/api/resume').catch(() => ({ resume: null }))
    ])
    if (!config.features?.fieldSelection || !config.features?.projectListImport ||
        !config.features?.projectListLocalUrls ||
        !config.features?.retryProblemsAfterCompletion ||
        !config.features?.publisherTargetPagination ||
        !config.features?.targetAwareImageStatuses ||
        !config.features?.duplicateUrlNameDisambiguation ||
        !config.features?.directoryPicker || !config.features?.browserDirectoryPicker ||
        config.features?.imageFieldSchema !== 8) {
      throw new Error('本地服务需要重启后才能使用最新图片分类')
    }
    state.imagesDirAvailable = Boolean(config.imagesDirAvailable)
    state.resume = state.imagesDirAvailable ? resumeResult.resume : null
    state.projectText = state.resume?.projectText || ''
    state.projectListName = state.resume?.projectListName || ''
    state.importSummary = state.resume?.importSummary || null
    state.fields = config.fields
    const resumeFields = new Set(state.resume?.selectedFields || [])
    state.selectedFields = new Set(state.fields
      .map((field) => field.key)
      .filter((key) => !state.resume || resumeFields.size === 0 || resumeFields.has(key)))
    state.seed = state.resume?.seed || config.seed
    elements['seed-input'].value = state.seed
    elements['images-path'].textContent = config.imagesDir
    renderFieldOptions()
    renderProjectListState()
    setConnection(true)
    if (state.imagesDirAvailable) {
      const loaded = await loadPlan()
      if (!loaded) return
    } else {
      renderProjects()
      toast('当前图片文件夹不存在，请点击“选择图片文件夹”重新选择', 'error')
    }
    await Promise.all([loadReports(), restoreActiveJob()])
  } catch (error) {
    setConnection(!error.connectionFailed)
    toast(error.message, 'error')
  }
}

function bindEvents() {
  elements['refresh-button'].addEventListener('click', () => loadPlan(true))
  elements['import-projects-button'].addEventListener('click', () => elements['project-file-input'].click())
  elements['project-file-input'].addEventListener('change', importProjectList)
  elements['clear-projects-button'].addEventListener('click', clearProjectList)
  elements['select-images-button'].addEventListener('click', openImagesDirectoryPicker)
  elements['image-directory-input'].addEventListener('change', selectImagesDirectory)
  elements['random-seed-button'].addEventListener('click', async () => {
    const wasResuming = Boolean(state.resume)
    state.resume = null
    if (wasResuming) state.selected = new Set()
    state.seed = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
    elements['seed-input'].value = state.seed
    await loadPlan()
  })
  elements['seed-input'].addEventListener('change', async () => {
    const wasResuming = Boolean(state.resume)
    state.resume = null
    if (wasResuming) state.selected = new Set()
    state.seed = elements['seed-input'].value.trim() || crypto.randomUUID().slice(0, 12)
    elements['seed-input'].value = state.seed
    await loadPlan()
  })
  elements['field-options'].addEventListener('change', onFieldSelection)
  elements['select-all-fields'].addEventListener('change', onAllFieldSelection)
  elements['search-input'].addEventListener('input', renderProjects)
  elements['status-filter'].addEventListener('change', renderProjects)
  elements['selected-filter'].addEventListener('change', renderProjects)
  elements['select-all'].addEventListener('change', selectVisible)
  elements['project-body'].addEventListener('change', onProjectSelection)
  elements['progress-tab'].addEventListener('click', () => switchPanel('progress'))
  elements['issues-tab'].addEventListener('click', () => switchPanel('issues'))
  elements['reports-tab'].addEventListener('click', () => switchPanel('reports'))
  elements['issue-callout'].addEventListener('click', () => switchPanel('issues'))
  elements['report-list'].addEventListener('click', onReportClick)
  elements['report-detail-summary'].addEventListener('click', onReportSummaryClick)
  elements['check-button'].addEventListener('click', () => startJob('check'))
  elements['upload-button'].addEventListener('click', openUploadDialog)
  elements['resume-button'].addEventListener('click', openUploadDialog)
  elements['restart-batch-button'].addEventListener('click', restartBatch)
  elements['stop-button'].addEventListener('click', stopJob)
  elements['confirm-checkbox'].addEventListener('change', () => {
    elements['confirm-upload-button'].disabled = !elements['confirm-checkbox'].checked
  })
  elements['upload-dialog'].addEventListener('close', () => {
    if (elements['upload-dialog'].returnValue === 'default') startJob('upload')
    elements['confirm-checkbox'].checked = false
    elements['confirm-upload-button'].disabled = true
  })
}

async function importProjectList() {
  const file = elements['project-file-input'].files?.[0]
  elements['project-file-input'].value = ''
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.txt')) {
    toast('请选择 TXT 项目清单', 'error')
    return
  }
  if (file.size > 1024 * 1024) {
    toast('TXT 文件不能超过 1 MB', 'error')
    return
  }
  try {
    const bytes = await file.arrayBuffer()
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      text = new TextDecoder('gb18030').decode(bytes)
    }
    if (!text.trim()) throw new Error('TXT 项目清单为空')
    if (state.resume) {
      await api('/api/resume/dismiss', { method: 'POST', body: '{}' })
    }
    state.resume = null
    state.selected = new Set()
    state.projectText = text
    state.projectListName = file.name
    state.importSummary = null
    state.projectListLoading = true
    renderProjectListState()
    const loaded = await loadPlan()
    state.projectListLoading = false
    renderProjectListState()
    if (!loaded) return
    const summary = state.importSummary
    toast(
      summary
        ? `已导入 ${summary.parsed} 个项目，匹配 ${summary.matched} 个${summary.unmatched ? `，异常 ${summary.unmatched} 个` : ''}`
        : '项目清单已导入',
      summary?.unmatched || summary?.invalidLines || summary?.duplicates ? 'error' : 'success'
    )
  } catch (error) {
    state.projectListLoading = false
    renderProjectListState()
    toast(error.message, 'error')
  }
}

async function clearProjectList() {
  if (isRunning()) return
  try {
    if (state.resume) {
      await api('/api/resume/dismiss', { method: 'POST', body: '{}' })
    }
    state.resume = null
    state.projectText = ''
    state.projectListName = ''
    state.importSummary = null
    state.projectListLoading = false
    state.selected = new Set()
    renderProjectListState()
    const loaded = await loadPlan()
    if (!loaded) return
    toast('已清除项目清单，恢复显示全部项目', 'success')
  } catch (error) {
    toast(error.message, 'error')
  }
}

function openImagesDirectoryPicker() {
  if (state.selectingDirectory || isRunning()) return
  elements['image-directory-input'].value = ''
  elements['image-directory-input'].click()
}

async function selectImagesDirectory() {
  const files = [...(elements['image-directory-input'].files || [])]
  if (!files.length || isRunning()) return
  const relativePaths = files.map((file) => file.webkitRelativePath).filter(Boolean)
  const rootName = relativePaths[0]?.split('/')[0] || ''
  state.selectingDirectory = true
  setControls()
  try {
    toast(`正在读取图片文件夹：${rootName}`)
    const result = await api('/api/images-directory/browser-select', {
      method: 'POST',
      body: JSON.stringify({
        rootName,
        relativePaths: sampleRelativePaths(relativePaths, 80)
      })
    })
    elements['images-path'].textContent = result.imagesDir
    state.imagesDirAvailable = true
    state.resume = null
    state.selected = new Set()
    state.selectingDirectory = false
    const loaded = await loadPlan()
    if (loaded) toast(`已切换图片文件夹：${result.imagesDir}`, 'success')
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    state.selectingDirectory = false
    setControls()
  }
}

function sampleRelativePaths(paths, limit) {
  if (paths.length <= limit) return paths
  const sampled = []
  const step = (paths.length - 1) / (limit - 1)
  for (let index = 0; index < limit; index += 1) sampled.push(paths[Math.round(index * step)])
  return [...new Set(sampled)]
}

function renderProjectListState() {
  const summary = state.importSummary
  const imported = Boolean(state.projectText)
  elements['project-list-state'].textContent = imported
    ? `${state.projectListName || 'TXT 清单'} · ${summary
        ? `${summary.matched}/${summary.parsed}`
        : state.projectListLoading ? '读取中' : '读取失败'}`
    : '全部项目'
  const issueCount = summary
    ? summary.unmatched + summary.duplicates + summary.invalidLines
    : 0
  elements['project-list-state'].classList.toggle('has-issues', issueCount > 0)
  elements['project-list-state'].title = summary?.issues?.join('；') || ''
  elements['import-projects-button'].querySelector('span').textContent = imported ? '更换项目清单' : '导入项目清单'
  elements['clear-projects-button'].hidden = !imported
  refreshIcons()
}

function restoreProjectListFromJob(job) {
  if (!job?.projectText) return
  state.projectText = job.projectText
  state.projectListName = job.projectListName || '任务项目清单.txt'
  state.importSummary = job.importSummary || null
  renderProjectListState()
}

async function loadPlan(showSuccess = false) {
  if (state.loading || isRunning()) return
  state.loading = true
  setControls()
  try {
    state.seed = elements['seed-input'].value.trim() || state.seed
    const fields = [...state.selectedFields].join(',')
    const result = state.projectText
      ? await api('/api/plan', {
          method: 'POST',
          body: JSON.stringify({
            seed: state.seed,
            fields: [...state.selectedFields],
            projectText: state.projectText
          })
        })
      : await api(`/api/plan?seed=${encodeURIComponent(state.seed)}&fields=${encodeURIComponent(fields)}`)
    const previous = new Set(state.selected)
    state.projects = result.projects
    state.importSummary = result.importSummary
    const resumable = new Set(state.resume?.remainingFolders || [])
    state.selected = new Set(state.projects
      .filter((project) => project.valid && (state.resume
        ? resumable.has(project.folderName)
        : previous.size === 0 || previous.has(project.folderName)))
      .map((project) => project.folderName))
    elements['summary-total'].textContent = result.summary.total
    elements['summary-valid'].textContent = result.summary.valid
    elements['summary-invalid'].textContent = result.summary.invalid
    renderProjects()
    renderProjectListState()
    setConnection(true)
    if (showSuccess) toast('项目和素材已刷新', 'success')
    return true
  } catch (error) {
    setConnection(!error.connectionFailed)
    toast(error.message, 'error')
    return false
  } finally {
    state.loading = false
    setControls()
  }
}

function renderProjects() {
  const projects = filteredProjects()
  elements['project-body'].innerHTML = projects.map((project) => {
    const checked = state.selected.has(project.folderName)
    const resumeState = projectResumeState(project)
    const retryFields = new Set(state.resume?.retryFieldsByFolder?.[project.folderName] || [])
    const alias = project.projectName && project.folderName !== project.projectName
      ? `<span class="project-site folder-alias">素材目录：${escapeHtml(project.folderName)}</span>`
      : ''
    const files = state.fields.map(({ key, label: fullLabel, ratio, targetType }) => {
      const targetSlug = targetType !== 'acf-field' ? successfulTargetSlug(project.folderName, key) : ''
      const label = targetSlug && targetSlug !== key ? `${targetSlug} · ${ratio}` : FIELD_LABELS[key] || fullLabel
      const isSelected = state.selectedFields.has(key)
      const notApplicable = isFieldNotApplicable(project.folderName, key)
      const fieldState = !isSelected
        ? 'excluded'
        : notApplicable
        ? 'not-applicable'
        : retryFields.size
        ? retryFields.has(key) ? 'retry' : 'already-complete'
        : ''
      const count = project.counts[key] || 0
      const fieldNote = fieldState === 'excluded'
        ? '未选择'
        : fieldState === 'not-applicable'
        ? '目标不存在，已跳过'
        : fieldState === 'retry'
        ? '待修复'
        : fieldState ? '已成功，不重传' : count ? `${count} 选 1` : '0 张'
      return `
      <div class="file-item ${fieldState}" title="${escapeHtml(project.selected[key] || '')}">
        <b>${escapeHtml(label)} · ${fieldNote}</b>
        <span>${escapeHtml(fieldState === 'excluded' ? '本次不处理' : project.selected[key] || '缺失')}</span>
      </div>
    `}).join('')
    const issues = project.issues.join('；')
    const order = project.importOrder
      ? `<span class="project-order">${String(project.importOrder).padStart(2, '0')}</span>`
      : ''
    const issueNote = !project.valid && issues
      ? `<span class="project-site project-error">${escapeHtml(issues)}</span>`
      : ''
    return `
      <tr class="${checked ? 'selected' : ''}" data-folder="${escapeHtml(project.folderName)}">
        <td class="select-cell">
          <input class="project-checkbox" type="checkbox" aria-label="选择 ${escapeHtml(project.folderName)}"
            ${checked ? 'checked' : ''} ${isProjectSelectable(project) && !isRunning() ? '' : 'disabled'} />
        </td>
        <td>
          <span class="project-title-line">${order}<span class="project-name">${escapeHtml(project.projectName || project.importName || project.folderName)}</span></span>
          <span class="project-site">${escapeHtml(project.siteUrl || '未匹配站点')}</span>
          ${alias}
          ${issueNote}
        </td>
        <td><div class="file-grid">${files}</div></td>
        <td class="state-cell">
          <span class="status-tag ${resumeState.className}" title="${escapeHtml(issues)}">
            ${resumeState.label}
          </span>
        </td>
      </tr>
    `
  }).join('')
  elements['visible-count'].textContent = `${projects.length} 项`
  elements['empty-state'].hidden = projects.length > 0
  const selectable = projects.filter(isProjectSelectable)
  const selectedVisible = selectable.filter((project) => state.selected.has(project.folderName)).length
  elements['select-all'].checked = selectable.length > 0 && selectedVisible === selectable.length
  elements['select-all'].indeterminate = selectedVisible > 0 && selectedVisible < selectable.length
  elements['select-all'].disabled = isRunning() || selectable.length === 0
  updateSelectionSummary()
}

function successfulTargetSlug(folderName, fieldKey) {
  const image = activeImageResult(folderName, fieldKey)
  if (image?.status === 'succeeded' && image.page) return image.page
  return state.resume?.targetSlugsByFolder?.[folderName]?.[fieldKey] || ''
}

function isFieldNotApplicable(folderName, fieldKey) {
  const image = activeImageResult(folderName, fieldKey)
  return isNotApplicableImage(image) ||
    Boolean(state.resume?.notApplicableFieldsByFolder?.[folderName]?.includes(fieldKey))
}

function activeImageResult(folderName, fieldKey) {
  const result = (state.activeJob?.results || []).find((item) => item?.folderName === folderName)
  return result?.imageResults?.[fieldKey] || null
}

function isNotApplicableImage(image) {
  return image?.status === 'not-applicable' ||
    (image?.status === 'skipped' && /^找不到 (?:页面|产品标签) slug=/.test(String(image.reason || '')))
}

function filteredProjects() {
  const query = elements['search-input'].value.trim().toLocaleLowerCase('zh-CN')
  const filter = elements['status-filter'].value
  const selectedOnly = elements['selected-filter'].checked
  return state.projects.filter((project) => {
    const text = `${project.folderName} ${project.projectName} ${project.siteUrl}`.toLocaleLowerCase('zh-CN')
    if (query && !text.includes(query)) return false
    if (filter === 'valid' && !project.valid) return false
    if (filter === 'invalid' && project.valid) return false
    if (selectedOnly && !state.selected.has(project.folderName)) return false
    return true
  })
}

function selectVisible() {
  const checked = elements['select-all'].checked
  for (const project of filteredProjects()) {
    if (!isProjectSelectable(project)) continue
    if (checked) state.selected.add(project.folderName)
    else state.selected.delete(project.folderName)
  }
  renderProjects()
}

function onProjectSelection(event) {
  const input = event.target.closest('.project-checkbox')
  if (!input) return
  const row = input.closest('tr')
  const folderName = row.dataset.folder
  if (input.checked) state.selected.add(folderName)
  else state.selected.delete(folderName)
  row.classList.toggle('selected', input.checked)
  renderProjects()
}

function updateSelectionSummary() {
  const count = state.selected.size
  const planCounts = plannedFieldCounts()
  const selectedRepairs = state.resume
    ? [...state.selected].filter((folder) => state.resume.retryFieldsByFolder?.[folder]?.length).length
    : 0
  elements['summary-selected'].textContent = count
  elements['action-selection'].textContent = state.resume
    ? `${isRepairResume() ? '问题重跑' : '续跑批次'}：已完成 ${state.resume.processed} 个，待执行 ${count} 个，共 ${planCounts.uploads} 张图片${planCounts.missing ? `，缺图 ${planCounts.missing} 项` : ''}${selectedRepairs ? `（其中待修复 ${selectedRepairs} 个）` : ''}`
    : `已选择 ${count} 个项目，共 ${planCounts.uploads} 张图片${planCounts.missing ? `，缺图 ${planCounts.missing} 项` : ''}`
  elements['action-seed'].textContent = `随机种子：${state.seed}`
  setControls()
}

function isProjectSelectable(project) {
  return project.valid && (!state.resume || state.resume.remainingFolders.includes(project.folderName))
}

function projectResumeState(project) {
  if (!project.valid) return { className: 'invalid', label: '异常' }
  if (!state.resume) return { className: 'valid', label: '可执行' }
  if (state.resume.processedFolders.includes(project.folderName)) return { className: 'processed', label: '已处理' }
  const retryFields = state.resume.retryFieldsByFolder?.[project.folderName] || []
  if (retryFields.length) return { className: 'repair', label: `待修复 ${retryFields.length} 张` }
  if (state.resume.remainingFolders.includes(project.folderName)) return { className: 'resume', label: '待继续' }
  return { className: 'excluded', label: '不在批次' }
}

async function restartBatch() {
  if (isRunning()) return
  await api('/api/resume/dismiss', { method: 'POST', body: '{}' }).catch(() => {})
  state.resume = null
  state.selected = new Set()
  state.seed = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
  elements['seed-input'].value = state.seed
  await loadPlan()
  toast('已退出续跑，重新选择全部项目', 'success')
}

function openUploadDialog() {
  if (!state.selected.size || !state.selectedFields.size || isRunning()) return
  const planCounts = plannedFieldCounts()
  elements['dialog-project-count'].textContent = state.selected.size
  elements['dialog-image-count'].textContent = planCounts.uploads
  elements['dialog-missing-count'].textContent = planCounts.missing
  elements['dialog-seed'].textContent = state.seed
  elements['dialog-fields'].textContent = selectedFieldLabels().join('、')
  elements['upload-dialog'].showModal()
}

async function startJob(mode) {
  if (!state.selected.size || !state.selectedFields.size || isRunning()) return
  try {
    switchPanel('progress')
    const result = await api(mode === 'upload' ? '/api/upload' : '/api/check', {
      method: 'POST',
      body: JSON.stringify({
        seed: state.seed,
        projects: [...state.selected],
        fields: [...state.selectedFields],
        projectText: state.projectText || undefined,
        projectListName: state.projectListName || undefined,
        resumeFields: state.resume?.retryFieldsByFolder || undefined,
        confirmation: mode === 'upload' ? 'UPLOAD' : undefined
      })
    })
    state.activeJob = result.job
    state.issueReport = null
    state.issueReportName = ''
    renderJob()
    renderProjects()
    beginPolling()
    toast(mode === 'upload' ? '正式上传任务已开始' : '站点检查已开始', 'success')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function stopJob() {
  if (!isRunning()) return
  try {
    const result = await api(`/api/jobs/${state.activeJob.id}/cancel`, { method: 'POST', body: '{}' })
    state.activeJob = result.job
    renderJob()
    toast('已请求停止任务')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function restoreActiveJob() {
  try {
    const result = await api('/api/job/active')
    if (!result.job) return
    state.activeJob = result.job
    const shouldRestoreTaskPlan = isRunning() || Boolean(state.resume)
    if (shouldRestoreTaskPlan) {
      restoreProjectListFromJob(state.activeJob)
      if (state.activeJob.projectText && state.activeJob.plan?.length) {
        state.projects = state.activeJob.plan
        state.selected = new Set(state.activeJob.selectedFolders || [])
        renderProjects()
      }
    }
    if (state.resume && state.activeJob.mode === 'upload' && state.activeJob.status === 'cancelled') {
      applyResumeFromJob(state.activeJob)
      renderProjects()
    }
    renderJob()
    if (isRunning()) beginPolling()
  } catch {
    // Initial plan loading already reports connection errors.
  }
}

function applyResumeFromJob(job) {
  restoreProjectListFromJob(job)
  const selectedFolders = job.selectedFolders || []
  const resultByFolder = new Map((job.results || []).filter(Boolean).map((result) => [result.folderName, result]))
  const processedFolders = []
  const retryFieldsByFolder = {}
  const targetSlugsByFolder = {}
  const notApplicableFieldsByFolder = {}
  for (const folder of selectedFolders) {
    const result = resultByFolder.get(folder)
    if (!result) continue
    const images = Object.values(result.imageResults || {})
    if (!images.length) {
      if (result.status !== 'failed' && result.ok !== false) processedFolders.push(folder)
      continue
    }
    const retryFields = [...new Set(images
      .filter((image) => image.status !== 'succeeded' && !isNotApplicableImage(image))
      .map((image) => image.field)
      .filter(Boolean))]
    const targetSlugs = Object.fromEntries(images
      .filter((image) => image.status === 'succeeded' && image.field && image.page)
      .map((image) => [image.field, image.page]))
    const notApplicableFields = [...new Set(images.filter(isNotApplicableImage).map((image) => image.field).filter(Boolean))]
    if (Object.keys(targetSlugs).length) targetSlugsByFolder[folder] = targetSlugs
    if (notApplicableFields.length) notApplicableFieldsByFolder[folder] = notApplicableFields
    if (retryFields.length) retryFieldsByFolder[folder] = retryFields
    else processedFolders.push(folder)
  }
  const processed = new Set(processedFolders)
  const remainingFolders = selectedFolders.filter((folder) => !processed.has(folder))
  state.resume = remainingFolders.length ? {
    sourceReport: job.reportPath || '',
    sourceStatus: job.status,
    seed: job.seed,
    total: selectedFolders.length,
    processed: processedFolders.length,
    remaining: remainingFolders.length,
    retryProjects: Object.keys(retryFieldsByFolder).length,
    selectedFolders,
    selectedFields: [...new Set((job.plan || []).flatMap((item) => item.processFields || []))],
    projectText: job.projectText || '',
    projectListName: job.projectListName || '',
    importSummary: job.importSummary || null,
    processedFolders,
    remainingFolders,
    retryFieldsByFolder,
    targetSlugsByFolder,
    notApplicableFieldsByFolder
  } : null
  state.seed = job.seed
  if (state.resume?.selectedFields?.length) {
    state.selectedFields = new Set(state.resume.selectedFields)
    renderFieldOptions()
  }
  elements['seed-input'].value = state.seed
  state.selected = new Set(remainingFolders)
}

function beginPolling() {
  clearTimeout(state.pollingTimer)
  const poll = async () => {
    if (!state.activeJob) return
    try {
      const result = await api(`/api/jobs/${state.activeJob.id}`)
      const wasRunning = isRunning()
      state.activeJob = result.job
      renderJob()
      if (isRunning()) {
        state.pollingTimer = setTimeout(poll, 800)
      } else if (wasRunning) {
        if (state.activeJob.mode === 'upload') applyResumeFromJob(state.activeJob)
        renderProjects()
        await loadReports()
        toast(jobStatusLabel(state.activeJob), state.activeJob.failed ? 'error' : 'success')
      }
    } catch (error) {
      toast(error.message, 'error')
      state.pollingTimer = setTimeout(poll, 2000)
    }
  }
  state.pollingTimer = setTimeout(poll, 300)
}

function renderJob() {
  const job = state.activeJob
  if (!job) {
    elements['job-badge'].className = 'job-badge idle'
    elements['job-badge'].textContent = '空闲'
    elements['job-fraction'].textContent = '0 / 0'
    elements['progress-bar'].style.width = '0%'
    elements['job-completed'].textContent = '0'
    elements['job-failed'].textContent = '0'
    elements['image-succeeded'].textContent = '0'
    elements['image-failed'].textContent = '0'
    elements['image-skipped'].textContent = '0'
    elements['event-list'].innerHTML = `
      <div class="event-placeholder"><i data-lucide="list-checks"></i><span>暂无运行任务</span></div>
    `
    renderIssues()
    setControls()
    refreshIcons()
    return
  }

  const percent = job.total ? Math.min(100, Math.round((job.completed / job.total) * 100)) : 0
  elements['job-badge'].className = `job-badge ${jobBadgeClass(job.status)}`
  elements['job-badge'].textContent = jobStatusLabel(job)
  elements['job-fraction'].textContent = `${job.completed} / ${job.total}`
  elements['progress-bar'].style.width = `${percent}%`
  elements['job-completed'].textContent = job.completed
  elements['job-failed'].textContent = job.failed
  elements['image-succeeded'].textContent = job.imageSucceeded || 0
  elements['image-failed'].textContent = job.imageFailed || 0
  elements['image-skipped'].textContent = job.imageSkipped || 0
  const events = [...job.events].reverse().slice(0, 1500)
  elements['event-list'].innerHTML = events.map((event) => `
    <div class="event-row ${eventClass(event.stage)}">
      <strong>${escapeHtml(eventTitle(event))}</strong>
      ${event.message ? `<span>${escapeHtml(event.message)}</span>` : ''}
      <time>${formatTime(event.at)}</time>
    </div>
  `).join('')
  renderIssues()
  setControls()
}

async function loadReports() {
  try {
    const result = await api('/api/reports')
    elements['report-list'].innerHTML = result.reports.length
      ? result.reports.map((report) => `
        <div class="report-item">
          <div class="report-item-head">
            <strong title="${escapeHtml(report.name)}">${escapeHtml(report.name)}</strong>
            <span class="status-tag ${report.failed ? 'invalid' : 'valid'}">${report.failed ? '有失败' : '完成'}</span>
          </div>
          <p>${report.total} 个项目 · 成功 ${report.succeeded} · 失败 ${report.failed} · 警告 ${report.warnings || 0}</p>
          <p>图片成功 ${report.imageSucceeded || 0} · 图片失败 ${report.imageFailed || 0} · 跳过 ${report.imageSkipped || 0}</p>
          <time>${formatDateTime(report.modifiedAt)}</time>
          <button class="report-open-button" type="button" data-report="${escapeHtml(report.name)}">
            <i data-lucide="list-tree"></i><span>查看逐图明细</span>
          </button>
          ${(report.issues || 0) > 0 ? `
            <button class="report-open-button report-issues-button" type="button" data-report-issues="${escapeHtml(report.name)}">
              <i data-lucide="circle-alert"></i><span>问题汇总 ${report.issues}</span>
            </button>
          ` : ''}
        </div>
      `).join('')
      : '<div class="event-placeholder"><span>暂无执行记录</span></div>'
    const latest = result.reports.find((report) => !report.invalid)
    if (!state.activeJob && latest) {
      const detail = await api(`/api/reports/${encodeURIComponent(latest.name)}`)
      state.issueReport = detail.report
      state.issueReportName = latest.name
    } else if (!state.activeJob && !latest) {
      state.issueReport = null
      state.issueReportName = ''
    }
    renderIssues()
    refreshIcons()
  } catch (error) {
    elements['report-list'].innerHTML = `<div class="event-placeholder"><span>${escapeHtml(error.message)}</span></div>`
  }
}

function onReportClick(event) {
  const issuesButton = event.target.closest('[data-report-issues]')
  if (issuesButton) {
    openReportIssues(issuesButton.dataset.reportIssues)
    return
  }
  const button = event.target.closest('[data-report]')
  if (button) openReport(button.dataset.report)
}

async function openReportIssues(name) {
  try {
    const result = await api(`/api/reports/${encodeURIComponent(name)}`)
    state.issueReport = result.report
    state.issueReportName = name
    renderIssues(true)
    switchPanel('issues')
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function openReport(name) {
  try {
    const result = await api(`/api/reports/${encodeURIComponent(name)}`)
    state.reportDetail = result.report
    state.reportDetailFilter = 'all'
    elements['report-detail-title'].textContent = name
    elements['report-detail-meta'].textContent = `${state.reportDetail.mode === 'upload' ? '正式上传' : '站点检查'} · ${formatDateTime(state.reportDetail.startedAt)}`
    renderReportDetail()
    elements['report-dialog'].showModal()
    refreshIcons()
  } catch (error) {
    toast(error.message, 'error')
  }
}

function onReportSummaryClick(event) {
  const button = event.target.closest('[data-report-filter]')
  if (!button || !state.reportDetail) return
  state.reportDetailFilter = button.dataset.reportFilter
  renderReportDetail()
}

function renderReportDetail() {
  const report = state.reportDetail
  if (!report) return
  const projects = reportDetailProjects(report)
  const successful = projects.filter(isSuccessfulReportProject)
  const failed = projects.filter(isFailedReportProject)
  const imageResults = projects.flatMap((project) => Object.values(project.imageResults || {}))
  const filters = {
    all: { label: '全部项目', projects },
    success: { label: '成功项目', projects: successful },
    failed: { label: '失败项目', projects: failed }
  }
  const current = filters[state.reportDetailFilter] || filters.all
  elements['report-detail-summary'].innerHTML = `
    ${reportSummaryButton('all', projects.length, '项目')}
    ${reportSummaryButton('success', successful.length, '项目成功')}
    ${reportSummaryButton('failed', failed.length, '项目失败', true)}
    <span class="report-summary-stat"><b>${report.imageSucceeded ?? imageResults.filter((image) => image.status === 'succeeded').length}</b> 图片成功</span>
    <span class="report-summary-stat summary-error"><b>${report.imageFailed ?? imageResults.filter((image) => ['upload-failed', 'write-failed'].includes(image.status)).length}</b> 图片失败</span>
  `
  elements['report-detail-body'].innerHTML = `
    <div class="report-filter-head">
      <strong>${current.label}</strong>
      <span>${current.projects.length} 个项目</span>
    </div>
    ${current.projects.map(renderReportProject).join('') ||
      `<div class="event-placeholder"><span>没有${current.label}</span></div>`}
  `
}

function reportSummaryButton(filter, count, label, error = false) {
  const active = state.reportDetailFilter === filter
  return `
    <button class="report-summary-filter ${error ? 'summary-error' : ''} ${active ? 'active' : ''}"
      type="button" data-report-filter="${filter}" aria-pressed="${active}">
      <b>${count}</b><span>${label}</span>
    </button>
  `
}

function reportDetailProjects(report) {
  const results = Array.isArray(report.results) ? report.results.filter(Boolean) : []
  const byFolder = new Map(results.filter((project) => project.folderName).map((project) => [project.folderName, project]))
  const planned = (report.plan || []).filter((project) => project?.folderName).map((project) =>
    byFolder.get(project.folderName) || {
      folderName: project.folderName,
      projectName: project.projectName || project.folderName,
      siteUrl: project.siteUrl || '',
      status: 'not-processed',
      error: '该项目尚未执行'
    })
  const plannedFolders = new Set(planned.map((project) => project.folderName))
  return planned.length
    ? [...planned, ...results.filter((project) => !plannedFolders.has(project.folderName))]
    : results
}

function isFailedReportProject(project) {
  if (project.ok === false || ['failed', 'check-failed'].includes(project.status)) return true
  return Object.values(project.imageResults || {})
    .some((image) => ['upload-failed', 'write-failed'].includes(image.status))
}

function isSuccessfulReportProject(project) {
  if (isFailedReportProject(project)) return false
  return project.ok === true || ['completed', 'completed-with-warnings', 'checked', 'checked-with-warnings'].includes(project.status)
}

function renderReportProject(project) {
  const images = Object.values(project.imageResults || {})
  const failed = isFailedReportProject(project)
  const successful = isSuccessfulReportProject(project)
  const warning = project.status === 'completed-with-warnings' || Boolean(project.warnings?.length)
  const status = failed ? '失败' : successful ? warning ? '成功，有跳过' : '成功' : '未执行'
  const imageRows = images.length ? images.map((image) => `
    <div class="report-image-row">
      <div class="report-image-name">
        <strong>${escapeHtml(image.label || FIELD_LABELS[image.field] || image.field)}</strong>
        <code>${escapeHtml(image.field)}</code>
      </div>
      <span class="report-filename" title="${escapeHtml(image.filename)}">${escapeHtml(image.filename || '无文件')}</span>
      <span class="image-status ${reportImageStatusClass(image.status)}">${reportImageStatusLabel(image.status)}</span>
      <span class="report-image-detail">${escapeHtml(reportImageDetail(image))}</span>
    </div>
  `).join('') : `<p class="report-project-note">${escapeHtml(project.error || project.warnings?.join('；') || '旧报告没有逐图记录')}</p>`
  return `
    <section class="report-project ${failed ? 'has-error' : successful ? '' : 'not-run'}">
      <header>
        <div><strong>${escapeHtml(project.projectName || project.folderName)}</strong><span>${escapeHtml(project.siteUrl || '')}</span></div>
        <span class="status-tag ${failed ? 'invalid' : successful ? 'valid' : 'excluded'}">${status}</span>
      </header>
      ${project.error ? `<p class="report-project-error">${escapeHtml(project.error)}</p>` : ''}
      ${imageRows}
    </section>
  `
}

function reportImageStatusLabel(status) {
  return ({
    succeeded: '成功',
    'upload-failed': '上传失败',
    'write-failed': '写入失败',
    skipped: '已跳过',
    'not-applicable': '目标不存在',
    'not-processed': '未处理',
    uploading: '上传中',
    uploaded: '已上传',
    writing: '写入中',
    pending: '等待中'
  })[status] || status || '未知'
}

function reportImageStatusClass(status) {
  if (status === 'succeeded') return 'success'
  if (['upload-failed', 'write-failed'].includes(status)) return 'error'
  if (['skipped', 'not-applicable'].includes(status)) return 'warning'
  return 'neutral'
}

function reportImageDetail(image) {
  if (image.error) return image.error
  if (image.reason) return image.reason
  const details = []
  if (image.mediaId) details.push(`媒体 ID ${image.mediaId}`)
  if (image.pageId) details.push(`页面 ID ${image.pageId}`)
  if (image.writeMethod) details.push(image.writeMethod)
  return details.join(' · ') || '无补充信息'
}

const PROBLEM_IMAGE_STATUSES = new Set(['upload-failed', 'write-failed', 'skipped', 'not-processed'])

function renderIssues(forceReport = false) {
  const useJob = !forceReport && Boolean(state.activeJob)
  const source = useJob ? state.activeJob : state.issueReport
  const groups = collectProblemGroups(source?.results || [])
  const count = groups.reduce((total, group) => total + Math.max(1, group.images.length), 0)
  const sourceLabel = useJob
    ? `当前任务 · ${state.activeJob.completed} / ${state.activeJob.total}`
    : state.issueReportName ? `执行记录 · ${state.issueReportName}` : '尚无执行记录'

  elements['issue-count'].textContent = String(count)
  elements['issues-tab'].classList.toggle('has-issues', count > 0)
  elements['issue-callout'].hidden = count === 0
  elements['issue-callout-count'].textContent = `${count} 个问题需要处理`
  elements['issues-source'].textContent = sourceLabel
  elements['issue-list'].innerHTML = groups.length
    ? groups.map(renderIssueGroup).join('')
    : `<div class="event-placeholder"><i data-lucide="circle-check-big"></i><span>${source ? '当前记录没有失败或跳过项' : '暂无可汇总的执行记录'}</span></div>`
  refreshIcons()
}

function collectProblemGroups(results) {
  return (results || []).filter(Boolean).map((project) => {
    const images = Object.values(project.imageResults || {})
      .filter((image) => PROBLEM_IMAGE_STATUSES.has(image.status) && !isNotApplicableImage(image))
    const projectOnlyFailure = (project.status === 'failed' || project.ok === false) && images.length === 0
    if (!images.length && !projectOnlyFailure) return null
    return { project, images, projectOnlyFailure }
  }).filter(Boolean)
}

function renderIssueGroup({ project, images, projectOnlyFailure }) {
  const onlyWarnings = images.length > 0 && images.every((image) => image.status === 'skipped')
  const rows = images.map((image) => `
    <div class="issue-row">
      <div class="issue-image-name">
        <strong>${escapeHtml(image.label || FIELD_LABELS[image.field] || image.field)}</strong>
        <code>${escapeHtml(image.field)}</code>
      </div>
      <span class="image-status ${reportImageStatusClass(image.status)}">${reportImageStatusLabel(image.status)}</span>
      <span class="issue-filename" title="${escapeHtml(image.filename)}">${escapeHtml(image.filename || '无文件')}</span>
      <p>${escapeHtml(reportImageDetail(image))}</p>
    </div>
  `).join('')
  return `
    <section class="issue-group ${onlyWarnings ? 'warning' : 'error'}">
      <header>
        <div>
          <strong>${escapeHtml(project.projectName || project.folderName || '未知项目')}</strong>
          <span>${escapeHtml(project.siteUrl || '')}</span>
        </div>
        <b>${projectOnlyFailure ? '项目失败' : `${images.length} 项问题`}</b>
      </header>
      ${project.error ? `<p class="issue-project-error">${escapeHtml(project.error)}</p>` : ''}
      ${rows}
    </section>
  `
}

function sortProjectsByProblems(results) {
  return [...results].sort((left, right) => {
    const rightProblems = collectProblemGroups([right]).length
    const leftProblems = collectProblemGroups([left]).length
    return rightProblems - leftProblems
  })
}

function switchPanel(panel) {
  for (const name of ['progress', 'issues', 'reports']) {
    const active = panel === name
    elements[`${name}-tab`].classList.toggle('active', active)
    elements[`${name}-tab`].setAttribute('aria-selected', String(active))
    elements[`${name}-panel`].hidden = !active
  }
}

function setControls() {
  const running = isRunning()
  const unavailable = state.loading || state.selectingDirectory || running || state.selected.size === 0 || state.selectedFields.size === 0
  elements['check-button'].disabled = unavailable
  elements['upload-button'].disabled = unavailable
  elements['resume-button'].disabled = unavailable
  elements['stop-button'].hidden = !running
  elements['resume-button'].hidden = running || !state.resume
  const resumeLabel = elements['resume-button'].querySelector('span')
  if (resumeLabel) resumeLabel.textContent = isRepairResume() ? '重跑问题项' : '继续未完成'
  elements['upload-button'].hidden = Boolean(state.resume)
  elements['restart-batch-button'].hidden = running || !state.resume
  elements['restart-batch-button'].disabled = state.loading
  elements['stop-button'].disabled = Boolean(state.activeJob?.cancelRequested)
  elements['refresh-button'].disabled = state.loading || running
  elements['random-seed-button'].disabled = state.loading || running
  elements['seed-input'].disabled = state.loading || running
  elements['import-projects-button'].disabled = state.loading || running
  elements['clear-projects-button'].disabled = state.loading || running
  elements['select-images-button'].disabled = state.selectingDirectory || running
  elements['select-images-button'].setAttribute('aria-busy', String(state.selectingDirectory))
  elements['select-all-fields'].disabled = state.loading || running || Boolean(state.resume)
  for (const input of elements['field-options'].querySelectorAll('.field-checkbox')) {
    input.disabled = state.loading || running || Boolean(state.resume)
  }
}

function isRepairResume() {
  return Boolean(state.resume?.sourceStatus &&
    !['cancelled', 'running', 'failed'].includes(state.resume.sourceStatus))
}

function renderFieldOptions() {
  elements['field-options'].innerHTML = state.fields.map((field) => `
    <label class="field-option ${state.selectedFields.has(field.key) ? 'selected' : ''}"
      title="${escapeHtml(field.label)}">
      <input class="field-checkbox" type="checkbox" value="${escapeHtml(field.key)}"
        ${state.selectedFields.has(field.key) ? 'checked' : ''} />
      <span>
        <strong>${escapeHtml(FIELD_LABELS[field.key] || field.label)}</strong>
        <small>${escapeHtml(field.prefix)}</small>
      </span>
    </label>
  `).join('')
  elements['selected-field-count'].textContent = state.selectedFields.size
  elements['field-count-total'].textContent = state.fields.length
  syncAllFieldSelection()
  setControls()
}

function syncAllFieldSelection() {
  const total = state.fields.length
  const selected = state.selectedFields.size
  elements['select-all-fields'].checked = total > 0 && selected === total
  elements['select-all-fields'].indeterminate = selected > 0 && selected < total
}

async function onAllFieldSelection() {
  if (state.loading || isRunning() || state.resume) return
  state.selectedFields = elements['select-all-fields'].checked
    ? new Set(state.fields.map((field) => field.key))
    : new Set()
  renderFieldOptions()
  await loadPlan()
}

async function onFieldSelection(event) {
  const input = event.target.closest('.field-checkbox')
  if (!input || isRunning() || state.resume) return
  state.selectedFields = new Set([...elements['field-options'].querySelectorAll('.field-checkbox:checked')]
    .map((checkbox) => checkbox.value))
  renderFieldOptions()
  await loadPlan()
}

function plannedFieldCounts() {
  const projects = new Map(state.projects.map((project) => [project.folderName, project]))
  let uploads = 0
  let missing = 0
  for (const folder of state.selected) {
    const project = projects.get(folder)
    const retryFields = state.resume?.retryFieldsByFolder?.[folder]
    const fieldKeys = retryFields?.length ? retryFields : [...state.selectedFields]
    for (const key of fieldKeys) {
      if (project?.selected?.[key]) uploads += 1
      else missing += 1
    }
  }
  return { uploads, missing }
}

function selectedFieldLabels() {
  return state.fields
    .filter((field) => state.selectedFields.has(field.key))
    .map((field) => FIELD_LABELS[field.key] || field.label)
}

function isRunning() {
  return state.activeJob?.status === 'running'
}

function setConnection(online) {
  elements['connection-state'].classList.toggle('online', online)
  elements['connection-state'].lastChild.textContent = online ? '本地服务已连接' : '连接失败'
}

function eventTitle(event) {
  const name = event.projectName || ''
  if (event.stage === 'completed' && !name) return '任务全部完成'
  const map = {
    started: '任务开始',
    checking: `检查 ${name}`,
    checked: `${name} 检查通过`,
    'checked-with-warnings': `${name} 检查完成，有缺失字段`,
    'check-failed': `${name} 检查失败`,
    starting: `开始处理 ${name}`,
    uploading: `${name} · 上传 ${event.fieldLabel}`,
    'upload-succeeded': `${name} · ${event.fieldLabel} 上传成功`,
    'writing-image': `${name} · 写入 ${event.fieldLabel}`,
    'image-succeeded': `${name} · ${event.fieldLabel} 处理成功`,
    'image-skipped': `${name} · ${event.fieldLabel} 已跳过`,
    'upload-failed': `${name} · ${event.fieldLabel} 上传失败`,
    'write-failed': `${name} · ${event.fieldLabel} 写入失败`,
    completed: `${name} 上传完成`,
    'completed-with-warnings': `${name} 上传完成，有跳过字段`,
    warning: `${name} · 字段检查警告`,
    failed: `${name} 上传失败`,
    'cancel-requested': '正在停止任务',
    cancelled: '任务已停止',
    'completed-with-errors': '任务完成，存在失败项目',
    fatal: '任务异常终止'
  }
  return map[event.stage] || event.message || event.stage
}

function eventClass(stage) {
  if (['completed', 'checked', 'upload-succeeded', 'image-succeeded'].includes(stage)) return 'success'
  if (['failed', 'check-failed', 'fatal', 'completed-with-errors', 'upload-failed', 'write-failed'].includes(stage)) return 'error'
  if (['warning', 'completed-with-warnings', 'checked-with-warnings', 'image-skipped'].includes(stage)) return 'warning'
  if (['starting', 'uploading', 'writing-image', 'checking'].includes(stage)) return 'active'
  return ''
}

function jobStatusLabel(job) {
  const labels = {
    running: job.cancelRequested ? '正在停止' : job.mode === 'upload' ? '正在上传' : '正在检查',
    completed: '全部完成',
    'completed-with-errors': '完成，有失败',
    cancelled: '已停止',
    failed: '异常终止'
  }
  return labels[job.status] || job.status
}

function jobBadgeClass(status) {
  if (status === 'running') return 'running'
  if (status === 'completed') return 'success'
  return 'warning'
}

async function api(url, options = {}) {
  let response
  const { timeoutMs = 30000, ...fetchOptions } = options
  try {
    response = await fetch(url, {
      ...fetchOptions,
      headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) },
      signal: fetchOptions.signal || AbortSignal.timeout(timeoutMs)
    })
  } catch (cause) {
    if (cause.name === 'TimeoutError') throw new Error('请求等待超时，请重试')
    const error = new Error(`无法连接本地服务：${cause.message}`)
    error.connectionFailed = true
    throw error
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：HTTP ${response.status}`)
  return data
}

function toast(message, type = '') {
  const item = document.createElement('div')
  item.className = `toast ${type}`
  item.textContent = message
  elements['toast-region'].append(item)
  setTimeout(() => item.remove(), 4200)
}

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } })
}

function formatTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character])
}
