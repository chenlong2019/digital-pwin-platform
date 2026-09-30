/**
 * 浏览器落盘工具。
 *
 * 渲染层只负责「拍出内容」,不负责下载 —— 什么时候存、存成什么名字属于界面决策。
 */

/** 文件名时间戳 YYYYMMDD_HHMMSS */
export function timestampTag(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join('_')
}

/** 下载一个 data URL(PNG 照片走这条路,不用绕 objectURL) */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * 下载一个 Blob(录像成片走这条路)。
 * objectURL 延迟回收 —— 立刻 revoke 会让部分浏览器来不及取内容,下载变成空文件。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
