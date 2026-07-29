const FIELD_LABELS = {
  ap_img: '应用场景',
  af_img: '售后服务',
  hp_img: 'HotProducts',
  mo_banner: '手机 banner',
  pt_img: 'Price List'
}

const state = {
  seed: '',
  projects: [],
  selected: new Set(),
  activeJob: null,
  resume: null,
  issueReport: null,
  issueReportName: '',
  pollingTimer: 0,
  loading: false
}

const elements = Object.fromEntries(
  [
    'images-path', 'connection-state', 'refresh-button', 'seed-input', 'random-seed-button',
    'summary-total', 'summary-selected', 'summary-valid', 'summary-invalid', 'search-input',
    'status-filter', 'selected-filter', 'visible-count', 'select-all', 'project-body', 'empty-state',
    'progress-tab', 'issues-tab', 'reports-tab', 'progress-panel', 'issues-panel', 'reports-panel',
    'issue-count', 'issue-callout', 'issue-callout-count', 'issues-source', 'issue-list', 'job-badge', 'job-fraction',
    'progress-bar', 'job-completed', 'job-failed', 'event-list', 'report-list', 'action-selection',
    'image-succeeded', 'image-failed', 'image-skipped', 'report-dialog', 'report-detail-title',
    'report-detail-meta', 'report-detail-summary', 'report-detail-body',
    'action-seed', 'stop-button', 'check-button', 'upload-button', 'upload-dialog',
    'resume-button', 'restart-batch-button',
    'dialog-project-count', 'dialog-seed', 'confirm-checkbox', 'confirm-upload-button', 'toast-region'
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
    state.resume = resumeResult.resume
    state.seed = state.resume?.seed || config.seed
    elements['seed-input'].value = state.seed
    elements['images-path'].textContent = config.imagesDir
    setConnection(true)
    await loadPlan()
    await Promise.all([loadReports(), restoreActiveJob()])
  } catch (error) {
    setConnection(false)
    toast(error.message, 'error')
  }
}

function bindEvents() {
  elements['refresh-button'].addEventListener('click', () => loadPlan(true))
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

async function loadPlan(showSuccess = false) {
  if (state.loading || isRunning()) return
  state.loading = true
  setControls()
  try {
    state.seed = elements['seed-input'].value.trim() || state.seed
    const result = await api(`/api/plan?seed=${encodeURIComponent(state.seed)}`)
    const previous = new Set(state.selected)
    state.projects = result.projects
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
    setConnection(true)
    if (showSuccess) toast('项目和素材已刷新', 'success')
  } catch (error) {
    setConnection(false)
    toast(error.message, 'error')
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
    const files = Object.entries(FIELD_LABELS).map(([key, label]) => {
      const fieldState = retryFields.size
        ? retryFields.has(key) ? 'retry' : 'already-complete'
        : ''
      const fieldNote = fieldState === 'retry'
        ? '待修复'
        : fieldState ? '已成功，不重传' : `${project.counts[key] || 0} 选 1`
      return `
      <div class="file-item ${fieldState}" title="${escapeHtml(project.selected[key] || '')}">
        <b>${escapeHtml(label)} · ${fieldNote}</b>
        <span>${escapeHtml(project.selected[key] || '缺失')}</span>
      </div>
    `}).join('')
    const issues = project.issues.join('；')
    return `
      <tr class="${checked ? 'selected' : ''}" data-folder="${escapeHtml(project.folderName)}">
        <td class="select-cell">
          <input class="project-checkbox" type="checkbox" aria-label="选择 ${escapeHtml(project.folderName)}"
            ${checked ? 'checked' : ''} ${isProjectSelectable(project) && !isRunning() ? '' : 'disabled'} />
        </td>
        <td>
          <span class="project-name">${escapeHtml(project.projectName || project.folderName)}</span>
          <span class="project-site">${escapeHtml(project.siteUrl || '未匹配站点')}</span>
          ${alias}
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
  const selectedRepairs = state.resume
    ? [...state.selected].filter((folder) => state.resume.retryFieldsByFolder?.[folder]?.length).length
    : 0
  elements['summary-selected'].textContent = count
  elements['action-selection'].textContent = state.resume
    ? `续跑批次：已完成 ${state.resume.processed} 个，待执行 ${count} 个${selectedRepairs ? `（其中待修复 ${selectedRepairs} 个）` : ''}`
    : `已选择 ${count} 个项目，共 ${count * 5} 张图片`
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
  state.resume = null
  state.selected = new Set()
  state.seed = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
  elements['seed-input'].value = state.seed
  await loadPlan()
  toast('已退出续跑，重新选择全部项目', 'success')
}

function openUploadDialog() {
  if (!state.selected.size || isRunning()) return
  elements['dialog-project-count'].textContent = state.selected.size
  elements['dialog-seed'].textContent = state.seed
  elements['upload-dialog'].showModal()
}

async function startJob(mode) {
  if (!state.selected.size || isRunning()) return
  try {
    switchPanel('progress')
    const result = await api(mode === 'upload' ? '/api/upload' : '/api/check', {
      method: 'POST',
      body: JSON.stringify({
        seed: state.seed,
        projects: [...state.selected],
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
    if (state.activeJob.mode === 'upload' && state.activeJob.status === 'cancelled') {
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
  const selectedFolders = job.selectedFolders || []
  const resultByFolder = new Map((job.results || []).filter(Boolean).map((result) => [result.folderName, result]))
  const processedFolders = []
  const retryFieldsByFolder = {}
  for (const folder of selectedFolders) {
    const result = resultByFolder.get(folder)
    if (!result) continue
    const images = Object.values(result.imageResults || {})
    if (!images.length) {
      if (result.status !== 'failed' && result.ok !== false) processedFolders.push(folder)
      continue
    }
    const retryFields = [...new Set(images
      .filter((image) => image.status !== 'succeeded')
      .map((image) => image.field)
      .filter(Boolean))]
    if (retryFields.length) retryFieldsByFolder[folder] = retryFields
    else processedFolders.push(folder)
  }
  const processed = new Set(processedFolders)
  const remainingFolders = selectedFolders.filter((folder) => !processed.has(folder))
  state.resume = remainingFolders.length ? {
    sourceReport: job.reportPath || '',
    seed: job.seed,
    total: selectedFolders.length,
    processed: processedFolders.length,
    remaining: remainingFolders.length,
    retryProjects: Object.keys(retryFieldsByFolder).length,
    selectedFolders,
    processedFolders,
    remainingFolders,
    retryFieldsByFolder
  } : null
  state.seed = job.seed
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
        if (state.activeJob.mode === 'upload' && state.activeJob.status === 'cancelled') {
          applyResumeFromJob(state.activeJob)
        } else if (state.activeJob.mode === 'upload') {
          state.resume = null
        }
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
    const report = result.report
    elements['report-detail-title'].textContent = name
    elements['report-detail-meta'].textContent = `${report.mode === 'upload' ? '正式上传' : '站点检查'} · ${formatDateTime(report.startedAt)}`
    const imageResults = (report.results || []).flatMap((project) => Object.values(project.imageResults || {}))
    const succeeded = report.succeeded ?? (report.results || []).filter((project) =>
      ['completed', 'completed-with-warnings'].includes(project.status) || project.ok === true).length
    elements['report-detail-summary'].innerHTML = `
      <span><b>${report.totalProjects || 0}</b> 项目</span>
      <span><b>${succeeded}</b> 项目成功</span>
      <span class="summary-error"><b>${report.failed || 0}</b> 项目失败</span>
      <span><b>${report.imageSucceeded ?? imageResults.filter((image) => image.status === 'succeeded').length}</b> 图片成功</span>
      <span class="summary-error"><b>${report.imageFailed ?? imageResults.filter((image) => ['upload-failed', 'write-failed'].includes(image.status)).length}</b> 图片失败</span>
    `
    elements['report-detail-body'].innerHTML = sortProjectsByProblems(report.results || []).map(renderReportProject).join('') ||
      '<div class="event-placeholder"><span>报告中没有项目明细</span></div>'
    elements['report-dialog'].showModal()
    refreshIcons()
  } catch (error) {
    toast(error.message, 'error')
  }
}

function renderReportProject(project) {
  const images = Object.values(project.imageResults || {})
  const failed = project.status === 'failed' || project.ok === false
  const warning = project.status === 'completed-with-warnings' || Boolean(project.warnings?.length)
  const status = failed ? '失败' : warning ? '完成，有警告' : '成功'
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
    <section class="report-project ${failed ? 'has-error' : ''}">
      <header>
        <div><strong>${escapeHtml(project.projectName || project.folderName)}</strong><span>${escapeHtml(project.siteUrl || '')}</span></div>
        <span class="status-tag ${failed ? 'invalid' : 'valid'}">${status}</span>
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
  if (status === 'skipped') return 'warning'
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
      .filter((image) => PROBLEM_IMAGE_STATUSES.has(image.status))
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
  const unavailable = state.loading || running || state.selected.size === 0
  elements['check-button'].disabled = unavailable
  elements['upload-button'].disabled = unavailable
  elements['resume-button'].disabled = unavailable
  elements['stop-button'].hidden = !running
  elements['resume-button'].hidden = running || !state.resume
  elements['upload-button'].hidden = Boolean(state.resume)
  elements['restart-batch-button'].hidden = running || !state.resume
  elements['restart-batch-button'].disabled = state.loading
  elements['stop-button'].disabled = Boolean(state.activeJob?.cancelRequested)
  elements['refresh-button'].disabled = state.loading || running
  elements['random-seed-button'].disabled = state.loading || running
  elements['seed-input'].disabled = state.loading || running
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
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  })
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
