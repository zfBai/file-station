// 文件传输站 —— Vercel 版
//
// 用途：把 ZIP / RAR / 7Z 压缩包临时传给朋友。上传后得到一串密码，接收方在
// 首页输入密码即可拿到下载链接；文件 30 分钟后自动删除（阅后即焚式临时中转）。
//
// 账号：与图床（img-station）共用同一个 Vercel Blob store，直接读 _users/{用户名}.json
// 里的 scrypt 哈希校验，所以图床账号密码在这里通吃，不需要单独注册。
//
// 路由（file.mltd-imagesaving.site）：
//   POST /api/upload   签发 Blob 直传令牌（需登录）——浏览器拿到后直接 PUT 到 Vercel Blob，
//                      绕开 Vercel 函数 4.5MB 请求体上限，最大可传 MAX_FILE
//   POST /api/finish   上传完成后登记 { token } → 返回取件密码
//   POST /api/open     取件：{ password } → 返回下载直链（无需登录）
//   GET  /api/mine     我上传的、还在有效期内的文件列表（需登录）
//   POST /api/delete   { token } 提前删除自己的文件（需登录）
// 路由（download.mltd-imagesaving.site）：
//   GET  /dl/{令牌}/{文件名}?e={过期时间}&s={签名}  校验签名后 302 到 Blob 直链
//
// 数据布局（Blob key）：
//   f/{32位令牌}/{原始文件名}                          文件本体
//   _files/{过期毫秒}-{令牌}-{密码指纹}.json            取件索引（元数据）
//   _users/{用户名}.json                              用户档案（图床写入，这里只读）
// 索引键里直接编码了过期时间、令牌、密码指纹，所以「按密码取件」和「过期清理」
// 都只需要 list 一次、不用逐个读内容 —— 见 parseIndexKey()。

const crypto = require('crypto')
const store = require('./store')

// ============ 常量 ============
const FILE_PREFIX = 'f/'            // 文件本体前缀
const INDEX_PREFIX = '_files/'      // 取件索引前缀
const DOWNLOAD_DOMAIN = process.env.DOWNLOAD_DOMAIN || 'download.mltd-imagesaving.site'
// 下载链接的基地址（Cloudflare 上给 download 子域配了 CNAME 才生效）
const DOWNLOAD_BASE = process.env.DOWNLOAD_BASE || `https://${DOWNLOAD_DOMAIN}`

// 文件有效期：默认 30 分钟（环境变量 FILE_TTL_MINUTES 可改）
const TTL_MS = (parseInt(process.env.FILE_TTL_MINUTES, 10) || 30) * 60 * 1000
// 单文件上限：默认 300MB（环境变量 MAX_FILE_MB 可改）—— 直传不受函数体积限制
const MAX_FILE = (parseInt(process.env.MAX_FILE_MB, 10) || 300) * 1024 * 1024
// 站点总存储上限：默认 900MB（环境变量 TOTAL_QUOTA_MB 可改），超了就拒绝新上传
// 免费额度只有 1GB 存储，留 100MB 给图床和索引文件
const TOTAL_QUOTA = (parseInt(process.env.TOTAL_QUOTA_MB, 10) || 900) * 1024 * 1024
// 只允许压缩包
const ALLOWED_EXT = ['zip', 'rar', '7z']
const ALLOWED_TYPES = [
  'application/zip', 'application/x-zip-compressed',
  'application/vnd.rar', 'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/octet-stream', // 浏览器认不出扩展名时的兜底类型
]
// 上传中断留下的孤儿对象（没有对应索引）超过这个时间就清理
const ORPHAN_MS = 2 * 60 * 60 * 1000
// 清理节流：同一实例 60 秒内最多清理一次
const CLEANUP_INTERVAL_MS = 60 * 1000
// 取件密码：8 位，字母表去掉了易混淆的 I O 0 1
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PW_LENGTH = 8
// 取件失败限速：同一 IP 15 分钟内错 10 次就锁到窗口结束
const OPEN_WINDOW_MS = 15 * 60 * 1000
const OPEN_MAX_FAILS = 10
// 签名密钥：用于密码指纹和下载链接签名，可用环境变量 FILE_SECRET 覆盖（建议设置）
const FILE_SECRET = process.env.FILE_SECRET || 'file-station-default-secret'

// ============ 工具 ============
function json(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data),
  }
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
// 请求体 → 对象（适配层给 Buffer，测试里给字符串）
function readJson(event) {
  const buf = event.body
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '')
  try { return JSON.parse(text || '{}') } catch { throw new HttpError(400, '请求格式错误') }
}
// scrypt 密码哈希（与图床完全一致，才能复用同一批用户档案）
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex')
}
function verifyPassword(password, salt, expected) {
  return hashPassword(password, salt) === expected
}
// Blob 公共直链基础地址：优先 BLOB_BASE 环境变量，否则由 BLOB_STORE_ID 推导
function blobBase() {
  if (process.env.BLOB_BASE) return process.env.BLOB_BASE
  const id = String(process.env.BLOB_STORE_ID || '').replace(/^store_/, '')
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : null
}
// 生成取件密码，形如 K7M2QP93（存的是不带连字符的原始形态）
function newPassword() {
  const bytes = crypto.randomBytes(PW_LENGTH)
  let s = ''
  for (let i = 0; i < PW_LENGTH; i++) s += PW_ALPHABET[bytes[i] % PW_ALPHABET.length]
  return s
}
// 展示格式：每 4 位加一个连字符，方便念给朋友听
function formatPassword(pw) {
  return `${pw.slice(0, 4)}-${pw.slice(4)}`
}
// 用户输入的密码归一化：去掉空格和连字符、统一大写，容忍大小写和连字符差异
function normalizePassword(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}
// 密码 → 索引键里的 16 位指纹（带密钥的 HMAC，拿到 Blob 也反推不出密码）
function passwordHash(password) {
  return crypto.createHmac('sha256', FILE_SECRET + ':pw').update(password).digest('hex').slice(0, 16)
}
// 索引键：过期时间-令牌-密码指纹，三段都能直接从键名解析，取件和清理都不用读内容
function indexKey(expiresAt, token, pwHash) {
  return `${INDEX_PREFIX}${expiresAt}-${token}-${pwHash}.json`
}
function parseIndexKey(key) {
  const m = /^_files\/(\d+)-([a-f0-9]{32})-([a-f0-9]{16})\.json$/.exec(key)
  return m ? { expiresAt: Number(m[1]), token: m[2], pwHash: m[3] } : null
}
// 下载链接签名：绑定令牌和过期时间，改一个字符链接就失效
function downloadSig(token, expiresAt) {
  return crypto.createHmac('sha256', FILE_SECRET + ':dl')
    .update(`${token}:${expiresAt}`).digest('hex').slice(0, 32)
}
function downloadUrl(token, fileName, expiresAt) {
  return `${DOWNLOAD_BASE}/${token}/${encodeURIComponent(fileName)}?e=${expiresAt}&s=${downloadSig(token, expiresAt)}`
}
// 扩展名（小写，不含点）；没有扩展名返回空串
function extOf(name) {
  return String(name).match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || ''
}
// 控制字符判断：charCode 小于 32 或等于 127
// （这里用码点过滤而不是写正则范围，免得源码里出现真的控制字符）
function isControlChar(ch) {
  const code = ch.charCodeAt(0)
  return code < 32 || code === 127
}
// 文件名清洗：去掉路径分隔符、控制字符等危险字符；中文等正常字符保留
function sanitizeFileName(raw) {
  let s = Array.from(String(raw || ''))
    .filter(ch => !isControlChar(ch))
    .join('')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > 80) {
    // 超长名保留扩展名，只截断主体
    const ext = extOf(s)
    s = s.slice(0, 80 - (ext ? ext.length + 1 : 0)) + (ext ? '.' + ext : '')
  }
  return s || 'file.zip'
}
// 前端提交的 pathname 里的文件名必须干净：不准带路径分隔符、上级目录、控制字符
function isSafeFileName(name) {
  if (!name || name.length > 120) return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  if (/[*?"<>|]/.test(name)) return false
  if (Array.from(name).some(isControlChar)) return false
  return true
}

// ============ 入口 ============
exports.main = async (event) => {
  const { path: urlPath, httpMethod } = event
  try {
    return await route(urlPath, httpMethod, event)
  } catch (err) {
    return json(err.status || 500, { error: err.message || '服务器内部错误' })
  }
}

async function route(urlPath, httpMethod, event) {
  // ---- download 域名的下载请求：/dl/{令牌}/{文件名} ----
  if (urlPath === '/dl' || urlPath.startsWith('/dl/')) {
    if (httpMethod !== 'GET' && httpMethod !== 'HEAD') return json(405, { error: 'Method Not Allowed' })
    return await download(event, urlPath)
  }
  // ---- 公开接口 ----
  if (urlPath === '/api/open' && httpMethod === 'POST') return await open(event)
  // 登录接口：只用来让前端确认凭证对不对。本站不签发会话，
  // 后续每个请求照样带 x-user/x-password 重新校验一次。
  if (urlPath === '/api/login' && httpMethod === 'POST') return await login(event)
  // ---- 本地联调专用：模拟浏览器直传（只在本机内存模式下存在，生产环境这个路由直接 404） ----
  if (urlPath === '/api/local-upload' && httpMethod === 'PUT') return await localUpload(event)
  // ---- 登录后可用的接口 ----
  if (urlPath === '/api/upload' && httpMethod === 'POST') return await uploadToken(event)
  if (urlPath === '/api/finish' && httpMethod === 'POST') return await finish(event)
  if (urlPath === '/api/mine' && httpMethod === 'GET') return await mine(event)
  if (urlPath === '/api/delete' && httpMethod === 'POST') return await del(event)

  return json(404, { error: 'Not Found' })
}

// ============ 认证（读图床的用户档案） ============
async function auth(event) {
  const headers = event.headers || {}
  const username = String(headers['x-user'] || '').toLowerCase()
  const password = String(headers['x-password'] || '')
  if (!username || !password) throw new HttpError(401, '请先登录')

  const user = await store.readUser(username)
  if (!user) throw new HttpError(401, '用户不存在，请确认用的是图片保存站的账号')
  if (user.banned) throw new HttpError(403, '账号已被封禁，请联系管理员')
  if (!verifyPassword(password, user.salt, user.passHash)) throw new HttpError(401, '密码错误')
  return user
}

// ============ 登录 ============
// 前端登录时调这个（同源，不需要 CORS）。
// 早先是直接调图床的 /api/login，但那是跨域请求，浏览器预检会被拦下（Failed to fetch），
// 而且图床那边也没返回 CORS 头 —— 本站自己就能校验，何必绕一圈。
async function login(event) {
  const user = await auth(event)
  return json(200, { ok: true, username: user.username, role: user.role })
}

// ============ 直传令牌签发 ============
// 前端拿到 clientToken 后直接 PUT 到 Vercel Blob，文件字节不经过本函数，
// 因此不受 Vercel 函数 4.5MB 请求体上限约束（最大 MAX_FILE）。
async function uploadToken(event) {
  const user = await auth(event) // 未登录直接拒
  await cleanup().catch(() => {}) // 先清一次过期文件，保证下面的配额统计准确

  const body = readJson(event)
  const pathname = String(body?.payload?.pathname || '')
  // 令牌和文件名由前端生成，服务端只认 f/{32位令牌}/{压缩包名} 这种形状
  const m = /^f\/([a-f0-9]{32})\/(.+)$/.exec(pathname)
  if (!m) throw new HttpError(400, '上传路径不合法')
  const fileName = m[2]
  if (!isSafeFileName(fileName)) throw new HttpError(400, '文件名含非法字符，请重命名后再传')
  if (!ALLOWED_EXT.includes(extOf(fileName))) {
    throw new HttpError(400, '只支持 ZIP / RAR / 7Z 压缩包')
  }

  // 配额预检：用前端报的大小（clientPayload）判断，避免把整个存储塞满
  let declaredSize = 0
  try { declaredSize = Number(JSON.parse(body?.payload?.clientPayload || '{}').size) || 0 } catch { /* 忽略 */ }
  if (declaredSize > MAX_FILE) throw new HttpError(413, `文件超过 ${MAX_FILE / 1024 / 1024}MB 上限`)
  const used = (await store.listFiles(FILE_PREFIX)).reduce((sum, f) => sum + f.Size, 0)
  if (used + declaredSize > TOTAL_QUOTA) {
    throw new HttpError(413, `站点存储已满（上限 ${Math.round(TOTAL_QUOTA / 1024 / 1024)}MB），请稍后再试`)
  }

  // 交给官方 SDK 签发令牌：allowedContentTypes / maximumSizeInBytes 会被写进签名，
  // Blob 服务端据此强制校验，前端绕不过去。
  const { handleUpload } = require('@vercel/blob/client')
  try {
    const result = await handleUpload({
      body,
      request: { headers: event.headers || {} }, // handleUpload 只读这个头对象
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_TYPES,
        maximumSizeInBytes: MAX_FILE,
        addRandomSuffix: false,  // 令牌已经在路径里了，不能再随机
        cacheControlMaxAge: 60,  // 临时文件，不长期缓存
      }),
      // 登记走前端的 /api/finish，这里只作为 Blob 回调用，不做额外事情
      onUploadCompleted: async () => {},
    })
    return json(200, result)
  } catch (err) {
    return json(400, { error: err.message || '签发上传令牌失败' })
  }
}

// ============ 本地联调：模拟浏览器直传 ============
// dev-server.js 和 test.js 在本机内存模式下用它替代真实 Blob 的 PUT。
// 生产环境不设 TEST_MEMORY，这个路由直接不存在（404），不会被误用。
async function localUpload(event) {
  if (process.env.TEST_MEMORY !== '1') return json(404, { error: 'Not Found' })
  await auth(event)
  const pathname = String((event.queryString || {}).pathname || '')
  if (!/^f\/[a-f0-9]{32}\/.+$/.test(pathname)) throw new HttpError(400, '上传路径不合法')
  const buf = Buffer.isBuffer(event.body) ? event.body : Buffer.from(String(event.body || ''), 'utf8')
  if (!buf.length) throw new HttpError(400, '未收到文件')
  if (buf.length > MAX_FILE) throw new HttpError(413, `文件超过 ${MAX_FILE / 1024 / 1024}MB 上限`)
  const type = String((event.headers || {})['x-content-type'] || 'application/octet-stream')
  await store.putFile(pathname, buf, type)
  return json(200, { ok: true, pathname })
}

// ============ 上传完成登记 → 发密码 ============
async function finish(event) {
  const user = await auth(event)
  const body = readJson(event)
  const token = String(body.token || '')
  if (!/^[a-f0-9]{32}$/.test(token)) throw new HttpError(400, '文件令牌不合法')

  // 以 Blob 里的真实对象为准，不信前端报的名字和大小
  const objs = await store.listFiles(FILE_PREFIX + token + '/')
  if (!objs.length) throw new HttpError(400, '没有找到上传的文件，请重新上传')
  const obj = objs[0]
  const fileName = sanitizeFileName(obj.Key.slice((FILE_PREFIX + token + '/').length))
  if (!ALLOWED_EXT.includes(extOf(fileName))) {
    await store.deleteFile(obj.Key)
    throw new HttpError(400, '只支持 ZIP / RAR / 7Z 压缩包')
  }
  if (obj.Size > MAX_FILE) {
    await store.deleteFile(obj.Key)
    throw new HttpError(413, `文件超过 ${MAX_FILE / 1024 / 1024}MB 上限`)
  }

  const expiresAt = Date.now() + TTL_MS
  const password = newPassword()
  await store.putFile(
    indexKey(expiresAt, token, passwordHash(password)),
    Buffer.from(JSON.stringify({
      token, name: fileName, size: obj.Size, user: user.username,
      createdAt: new Date().toISOString(), expiresAt,
    })),
    'application/json'
  )

  return json(200, {
    ok: true,
    password: formatPassword(password), // 能直接念给朋友听的形态
    name: fileName,
    size: obj.Size,
    expiresAt,
    ttlMinutes: Math.round(TTL_MS / 60000),
    url: downloadUrl(token, fileName, expiresAt),
  })
}

// ============ 取件：输密码换下载链接 ============
async function open(event) {
  checkOpenRate(event) // 先限速，避免有人拿密码本硬撞
  const body = readJson(event)
  const password = normalizePassword(body.password)
  if (password.length !== PW_LENGTH) throw new HttpError(400, '密码是 8 位，形如 K7M2-QP93')

  const want = passwordHash(password)
  const hit = (await store.listFiles(INDEX_PREFIX)).find(f => {
    const info = parseIndexKey(f.Key)
    return info && info.pwHash === want
  })
  if (!hit) {
    recordOpenFail(event)
    throw new HttpError(404, '密码不对，或者文件已经过期（有效期 30 分钟）')
  }

  // 命中索引后读一次元数据（文件名和大小）
  const info = parseIndexKey(hit.Key)
  const meta = JSON.parse((await store.readFile(hit.Key)).toString('utf8'))
  if (Date.now() > meta.expiresAt || info.expiresAt !== meta.expiresAt) {
    throw new HttpError(410, '文件已过期，请让上传者重新传一次')
  }

  cleanupIfDue() // 取件成功后顺手清理过期文件（不阻塞返回）
  return json(200, {
    ok: true,
    name: meta.name,
    size: meta.size,
    expiresAt: meta.expiresAt,
    remainingSeconds: Math.max(0, Math.floor((meta.expiresAt - Date.now()) / 1000)),
    url: downloadUrl(meta.token, meta.name, meta.expiresAt),
  })
}

// ============ 我上传的文件 ============
async function mine(event) {
  const user = await auth(event)
  cleanupIfDue()
  const out = []
  for (const f of await store.listFiles(INDEX_PREFIX)) {
    const info = parseIndexKey(f.Key)
    if (!info || info.expiresAt <= Date.now()) continue
    const buf = await store.readFile(f.Key)
    if (!buf) continue
    const meta = JSON.parse(buf.toString('utf8'))
    if (meta.user !== user.username) continue
    out.push({
      token: meta.token,
      name: meta.name,
      size: meta.size,
      expiresAt: meta.expiresAt,
      remainingSeconds: Math.max(0, Math.floor((meta.expiresAt - Date.now()) / 1000)),
      url: downloadUrl(meta.token, meta.name, meta.expiresAt),
    })
  }
  out.sort((a, b) => b.expiresAt - a.expiresAt)
  return json(200, out)
}

// ============ 提前删除 ============
async function del(event) {
  const user = await auth(event)
  const body = readJson(event)
  const token = String(body.token || '')
  if (!/^[a-f0-9]{32}$/.test(token)) throw new HttpError(400, '文件令牌不合法')

  // 归属校验：找到这个令牌的索引，确认是本人上传的才能删
  for (const f of await store.listFiles(INDEX_PREFIX)) {
    const info = parseIndexKey(f.Key)
    if (!info || info.token !== token) continue
    const buf = await store.readFile(f.Key)
    if (buf) {
      const meta = JSON.parse(buf.toString('utf8'))
      if (meta.user !== user.username) throw new HttpError(403, '只能删除自己上传的文件')
    }
    break
  }
  const removed = await removeToken(token)
  if (!removed) throw new HttpError(404, '文件不存在或已过期')
  return json(200, { ok: true, message: '已删除，链接立即失效' })
}

// ============ 下载：校验签名后 302 到 Blob 直链 ============
// 不走函数回源：Vercel 函数的响应体也有体积上限，300MB 的包扛不住。
// 这里只做签名与过期校验，然后把流量交给 Blob 的 CDN。
async function download(event, urlPath) {
  const rest = urlPath.replace(/^\/dl\/?/, '')
  const parts = rest.split('/')
  if (parts.length !== 2) return json(404, { error: 'Not Found' })
  const [token, encodedName] = parts
  if (!/^[a-f0-9]{32}$/.test(token)) return json(404, { error: 'Not Found' })

  const qs = event.queryString || {}
  const expiresAt = Number(qs.e)
  const sig = String(qs.s || '')
  if (!expiresAt || !sig) return json(403, { error: '链接不完整，请回到首页重新取件' })
  if (sig !== downloadSig(token, expiresAt)) return json(403, { error: '链接无效或已被修改' })
  if (Date.now() > expiresAt) return json(410, { error: '文件已过期（有效期 30 分钟），请让上传者重新传一次' })

  let name
  try { name = decodeURIComponent(encodedName) } catch { name = encodedName }
  const base = blobBase()
  if (!base) return json(502, { error: '存储服务未配置' })
  return {
    statusCode: 302,
    headers: {
      Location: `${base}/${FILE_PREFIX}${token}/${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store', // 临时文件，别让中间层缓存
    },
    body: '',
  }
}

// ============ 过期清理（惰性，不需要 Cron） ============
// Vercel Hobby 的 Cron 一天只能跑一次，扛不住 30 分钟的有效期，
// 所以改成「有请求来就顺手清一次」，同一实例内 60 秒最多一次。
let lastCleanupAt = 0
function cleanupIfDue() {
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return
  lastCleanupAt = Date.now()
  cleanup().catch(() => { /* 清理失败不影响本次请求，下次再来 */ })
}

async function cleanup() {
  const now = Date.now()
  const aliveTokens = new Set()

  // 1) 过期索引：删文件本体 + 删索引（文件本体按令牌前缀列，不用读索引内容）
  for (const f of await store.listFiles(INDEX_PREFIX)) {
    const info = parseIndexKey(f.Key)
    if (!info) { await store.deleteFile(f.Key); continue } // 格式不对的残留索引
    if (info.expiresAt <= now) {
      for (const obj of await store.listFiles(FILE_PREFIX + info.token + '/')) {
        await store.deleteFile(obj.Key)
      }
      await store.deleteFile(f.Key)
    } else {
      aliveTokens.add(info.token)
    }
  }

  // 2) 孤儿对象：上传到一半就关掉浏览器、没走 finish 的文件，超过 2 小时没人认领就删
  for (const obj of await store.listFiles(FILE_PREFIX)) {
    const token = obj.Key.slice(FILE_PREFIX.length).split('/')[0]
    if (aliveTokens.has(token)) continue
    if (now - new Date(obj.LastModified).getTime() > ORPHAN_MS) await store.deleteFile(obj.Key)
  }
}

// 删掉某个令牌对应的全部对象（文件本体 + 索引），返回是否删到了东西
async function removeToken(token) {
  let removed = false
  for (const obj of await store.listFiles(FILE_PREFIX + token + '/')) {
    await store.deleteFile(obj.Key)
    removed = true
  }
  for (const f of await store.listFiles(INDEX_PREFIX)) {
    const info = parseIndexKey(f.Key)
    if (info && info.token === token) {
      await store.deleteFile(f.Key)
      removed = true
    }
  }
  return removed
}

// ============ 取件限速（内存计数，抗密码爆破） ============
// 每个函数实例各记一份，冷启动会重置；密码空间 32^8 足够大，这道墙只是拦住脚本猛撞。
const openAttempts = new Map() // ip -> { fails, resetAt }

function clientIp(event) {
  const h = event.headers || {}
  return String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim() || 'unknown'
}
function checkOpenRate(event) {
  const ip = clientIp(event)
  const rec = openAttempts.get(ip)
  if (!rec) return
  if (Date.now() > rec.resetAt) { openAttempts.delete(ip); return }
  if (rec.fails >= OPEN_MAX_FAILS) {
    const mins = Math.ceil((rec.resetAt - Date.now()) / 60000)
    throw new HttpError(429, `密码错误次数过多，请 ${mins} 分钟后再试`)
  }
}
function recordOpenFail(event) {
  const ip = clientIp(event)
  const now = Date.now()
  const rec = openAttempts.get(ip)
  if (!rec || now > rec.resetAt) openAttempts.set(ip, { fails: 1, resetAt: now + OPEN_WINDOW_MS })
  else rec.fails++
}
