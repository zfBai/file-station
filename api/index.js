// 单段 API 入口：vercel.json 的 rewrites 把任意段数的请求都转到这里，原始路径放在 query 里
//
// 为什么要这样：非 Next.js 项目的 api/ 函数 catch-all 只匹配单段路径，
// 多段路径（如 /api/admin/users、/abc123/我的文件.zip）会直接 404 不进函数。
// 所以用平台级 rewrites（与框架无关，支持任意段数）统一收口到这一个单段文件：
//   ?path=xxx   file.mltd-imagesaving.site 的接口请求，原始路径为 /api/xxx
//   ?dl=xxx     download.mltd-imagesaving.site 的下载请求，原始路径为 /dl/xxx
// 恢复后的 path 交给 core.js，路由逻辑只认还原后的完整路径。
const { main } = require('./core')

// 从 query 恢复原始请求路径（rewrites 捕获的段数不限，含斜杠；值可能带 URL 编码）
function restorePath(url) {
  const qs = Object.fromEntries(url.searchParams)
  const raw = qs.path || qs.dl
  if (raw == null) return url.pathname // 兜底：直接访问 /api/index
  let decoded
  try {
    decoded = decodeURIComponent(raw) // 中文文件名等非 ASCII 字符在这里还原
  } catch {
    decoded = raw // 个别非法 % 序列时原样使用，避免 500
  }
  return qs.dl ? `/dl/${decoded}` : `/api/${decoded}`
}

module.exports = async function handler(req, res) {
  // 只读请求体：直传模式下文件由浏览器直接 PUT 到 Vercel Blob，函数收到的 body 都是小 JSON
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const buf = Buffer.concat(chunks)

  const url = new URL(req.url, 'http://localhost')
  const event = {
    path: restorePath(url),
    httpMethod: req.method,
    headers: req.headers,          // Node 的 headers 是小写 key，core 里按小写读取，正好兼容
    queryString: Object.fromEntries(url.searchParams),
    body: buf,
  }

  const result = await main(event)
  res.statusCode = result.statusCode
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v)
  res.end(result.body)
}
