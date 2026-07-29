import path from 'node:path'
import { IMAGE_FIELDS } from './constants.mjs'
import {
  findPage,
  getMissingImageFields,
  preflightSite,
  updateAndVerifyImageFields,
  uploadMedia
} from './wordpress.mjs'

export async function checkSites(projects, onProgress = () => {}, concurrency = 5, shouldContinue = () => true) {
  const results = new Array(projects.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < projects.length && shouldContinue()) {
      const index = nextIndex++
      const item = projects[index]
      onProgress({ index, total: projects.length, item, stage: 'checking' })
      try {
        const pages = await preflightSite(item.project)
        if (pages.missingFields.length === IMAGE_FIELDS.length) {
          throw new Error('站点未定义任何目标图片字段，已在上传前阻止该项目')
        }
        const warnings = pages.missingFields.length
          ? [`站点缺少图片字段：${pages.missingFields.join('、')}`]
          : []
        results[index] = { folderName: item.folderName, projectName: item.project.name, ok: true, pages, warnings }
        onProgress({
          index,
          total: projects.length,
          item,
          stage: warnings.length ? 'checked-with-warnings' : 'checked',
          result: results[index]
        })
      } catch (error) {
        results[index] = {
          folderName: item.folderName,
          projectName: item.project.name,
          ok: false,
          error: error.message
        }
        onProgress({ index, total: projects.length, item, stage: 'check-failed', result: results[index] })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker))
  return results.filter(Boolean)
}

export async function executeBatch(projects, onProgress = () => {}, shouldContinue = () => true) {
  const results = []
  for (let index = 0; index < projects.length; index += 1) {
    if (!shouldContinue()) break
    const item = projects[index]
    const targetFields = IMAGE_FIELDS.filter((field) =>
      !Array.isArray(item.fieldsToProcess) || item.fieldsToProcess.includes(field.key))
    const result = {
      folderName: item.folderName,
      projectName: item.project.name,
      siteUrl: item.project.url,
      status: 'running',
      selected: selectedBasenames(item.selected, targetFields),
      processFields: targetFields.map((field) => field.key),
      pages: {},
      uploads: {},
      writes: {},
      imageResults: createImageResults(item.selected, targetFields),
      warnings: [],
      startedAt: new Date().toISOString()
    }
    results.push(result)
    onProgress({ index, total: projects.length, item, result, stage: 'starting' })

    try {
      if (!targetFields.length) throw new Error('当前项目没有需要处理的图片字段')
      const needsAboutPage = targetFields.some((field) => field.pageKey === 'about')
      const needsPriceListPage = targetFields.some((field) => field.pageKey === 'price-list')
      const [aboutPage, priceListPage] = await Promise.all([
        needsAboutPage
          ? findPage(item.project, 'about-us', { expectedFields: ['ap_img', 'af_img', 'hp_img', 'mo_banner'] })
          : Promise.resolve(null),
        needsPriceListPage
          ? findPage(item.project, 'price-list', { expectedFields: ['pt_img'] })
          : Promise.resolve(null)
      ])
      result.pages = {
        ...(aboutPage ? { about: Number(aboutPage.id) } : {}),
        ...(priceListPage ? { priceList: Number(priceListPage.id) } : {})
      }
      const missingFields = getMissingImageFields(aboutPage, priceListPage)
        .filter((field) => targetFields.some((candidate) => candidate.key === field))
      if (missingFields.length) {
        result.warnings.push(`站点缺少图片字段，已跳过：${missingFields.join('、')}`)
        onProgress({
          index,
          total: projects.length,
          item,
          result,
          stage: 'warning',
          message: result.warnings.at(-1)
        })
        for (const field of targetFields.filter((candidate) => missingFields.includes(candidate.key))) {
          const imageResult = result.imageResults[field.key]
          imageResult.status = 'skipped'
          imageResult.reason = `站点未定义字段 ${field.key}`
          imageResult.finishedAt = new Date().toISOString()
          onProgress({
            index,
            total: projects.length,
            item,
            result,
            stage: 'image-skipped',
            field,
            filename: imageResult.filename,
            message: `${imageResult.filename}：站点未定义字段 ${field.key}，已跳过`
          })
        }
      }

      const availableFields = targetFields.filter((field) => !missingFields.includes(field.key))
      if (!availableFields.length) throw new Error('站点没有任何可写入的目标图片字段')

      for (const field of availableFields) {
        const imageResult = result.imageResults[field.key]
        const pageId = field.pageKey === 'about' ? result.pages.about : result.pages.priceList
        imageResult.pageId = pageId
        imageResult.status = 'uploading'
        imageResult.startedAt = new Date().toISOString()
        onProgress({
          index,
          total: projects.length,
          item,
          result,
          stage: 'uploading',
          field,
          filename: imageResult.filename,
          message: `正在上传 ${imageResult.filename}`
        })

        try {
          result.uploads[field.key] = await uploadMedia(
            item.project,
            item.selected[field.key],
            field.label
          )
          const upload = result.uploads[field.key]
          imageResult.mediaId = upload.id
          imageResult.mediaUrl = upload.sourceUrl
          imageResult.status = 'uploaded'
          onProgress({
            index,
            total: projects.length,
            item,
            result,
            stage: 'upload-succeeded',
            field,
            filename: imageResult.filename,
            message: `${imageResult.filename} 上传成功，媒体 ID ${upload.id}`
          })
        } catch (error) {
          imageResult.status = 'upload-failed'
          imageResult.error = error.message
          imageResult.finishedAt = new Date().toISOString()
          onProgress({
            index,
            total: projects.length,
            item,
            result,
            stage: 'upload-failed',
            field,
            filename: imageResult.filename,
            message: `${imageResult.filename} 上传失败：${error.message}`
          })
          continue
        }

        const fieldValue = field.gallery ? [imageResult.mediaId] : imageResult.mediaId
        imageResult.status = 'writing'
        onProgress({
          index,
          total: projects.length,
          item,
          result,
          stage: 'writing-image',
          field,
          filename: imageResult.filename,
          message: `正在写入字段 ${field.key}，页面 ID ${pageId}`
        })
        try {
          result.writes[field.key] = await updateAndVerifyImageFields(
            item.project,
            pageId,
            { [field.key]: fieldValue }
          )
          imageResult.status = 'succeeded'
          imageResult.writeMethod = result.writes[field.key].method
          imageResult.finishedAt = new Date().toISOString()
          onProgress({
            index,
            total: projects.length,
            item,
            result,
            stage: 'image-succeeded',
            field,
            filename: imageResult.filename,
            message: `${imageResult.filename} 已上传并写入 ${field.key}，媒体 ID ${imageResult.mediaId}`
          })
        } catch (error) {
          imageResult.status = 'write-failed'
          imageResult.error = error.message
          imageResult.finishedAt = new Date().toISOString()
          onProgress({
            index,
            total: projects.length,
            item,
            result,
            stage: 'write-failed',
            field,
            filename: imageResult.filename,
            message: `${imageResult.filename} 已上传（媒体 ID ${imageResult.mediaId}），但字段 ${field.key} 写入失败：${error.message}`
          })
        }
      }

      result.summary = summarizeImageResults(result.imageResults)
      if (result.summary.failed > 0) {
        result.status = 'failed'
        result.error = `失败图片：${result.summary.failedFields.map((image) => `${image.label}（${image.statusLabel}）`).join('、')}`
      } else {
        result.status = result.warnings.length || result.summary.skipped
          ? 'completed-with-warnings'
          : 'completed'
      }
    } catch (error) {
      result.status = 'failed'
      result.error = error.message
      markUnprocessedImages(result.imageResults, error.message)
      result.summary = summarizeImageResults(result.imageResults)
    }

    result.summary ||= summarizeImageResults(result.imageResults)
    result.finishedAt = new Date().toISOString()
    onProgress({
      index,
      total: projects.length,
      item,
      result,
      stage: result.status,
      message: projectSummaryMessage(result)
    })
  }
  return results
}

function createImageResults(selected, fields = IMAGE_FIELDS) {
  return Object.fromEntries(fields.map((field) => [field.key, {
    field: field.key,
    label: field.label,
    filename: selected?.[field.key] ? path.basename(selected[field.key]) : '',
    page: field.pageSlug,
    pageId: null,
    status: 'pending',
    mediaId: null,
    mediaUrl: '',
    writeMethod: '',
    error: '',
    reason: '',
    startedAt: '',
    finishedAt: ''
  }]))
}

function markUnprocessedImages(imageResults, reason) {
  for (const imageResult of Object.values(imageResults)) {
    if (!['pending', 'uploading', 'uploaded', 'writing'].includes(imageResult.status)) continue
    imageResult.status = 'not-processed'
    imageResult.reason = `项目处理提前终止：${reason}`
    imageResult.finishedAt = new Date().toISOString()
  }
}

function summarizeImageResults(imageResults) {
  const values = Object.values(imageResults)
  const failedFields = values
    .filter((image) => ['upload-failed', 'write-failed'].includes(image.status))
    .map((image) => ({
      field: image.field,
      label: image.label,
      filename: image.filename,
      status: image.status,
      statusLabel: image.status === 'upload-failed' ? '上传失败' : '写入失败',
      error: image.error
    }))
  return {
    total: values.length,
    succeeded: values.filter((image) => image.status === 'succeeded').length,
    failed: failedFields.length,
    skipped: values.filter((image) => image.status === 'skipped').length,
    notProcessed: values.filter((image) => image.status === 'not-processed').length,
    successfulFields: values.filter((image) => image.status === 'succeeded').map((image) => image.field),
    failedFields,
    skippedFields: values.filter((image) => image.status === 'skipped').map((image) => image.field)
  }
}

function projectSummaryMessage(result) {
  const summary = result.summary
  const parts = [`成功 ${summary.succeeded} 张`, `失败 ${summary.failed} 张`, `跳过 ${summary.skipped} 张`]
  if (summary.notProcessed) parts.push(`未处理 ${summary.notProcessed} 张`)
  if (summary.failedFields.length) {
    parts.push(`失败项：${summary.failedFields.map((image) => `${image.label}/${image.field} ${image.statusLabel}`).join('；')}`)
  }
  if (result.error && !summary.failedFields.length) parts.push(result.error)
  return parts.join('；')
}

function selectedBasenames(selected, fields = IMAGE_FIELDS) {
  return Object.fromEntries(
    fields.map(({ key }) => [key, selected?.[key] ? path.basename(selected[key]) : null])
  )
}
