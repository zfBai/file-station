// 本地全流程测试（内存 store，不连真实 Blob）
// 用法：node test.js
//
// 覆盖：登录鉴权 → 签发直传令牌 → 直传 → 生成密码 → 取件 → 下载签名校验
//       → 我的文件 → 删除归属 → 大小/配额 → 过期清理 → 取件限速
// 说明：真实浏览器直传（PUT 到 blob.vercel-storage.com）没法在本地跑，
//       这里用 /api/local-upload 走同一套后端逻辑；真实直传请部署后在浏览器验证。
process.env.TEST_MEMORY = '1'
process.env.MAX_FILE_MB = '1'      // 单文件 1MB，方便测试大小限制
process.env.TOTAL_QUOTA_MB = '2'   // 站点总配额 2MB，方便测试配额
process.env.FILE_SECRET = 'test-secret'
process.env.FILE_TTL_MINUTES = '30'
// 假令牌：只需符合 vercel_blob_rw_<storeId>_<secret> 的形状，签出来的 clientToken 才有 storeId
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore123_secret'
process.env.BLOB_STORE_ID = 'store_teststore123'

const crypto = require('crypto')
const { main } = require('./api/core.js')
const store = require('./api/store.js')

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅ ' + msg) }
  else { failed++; console.error('  ❌ ' + msg) }
}
function eq(a, b, msg) { assert(a === b, `${msg}（期望 ${b}，实际 ${a}）`) }

async function call(path, httpMethod, { headers = {}, body, qs } = {}) {
  const event = { path, httpMethod, headers, queryString: qs }
  if (body !== undefined) event.body = Buffer.isBuffer(body) ? body : (typeof body === 'string' ? body : JSON.stringify(body))
  const res = await main(event)
  let data = null
  try { data = JSON.parse(res.body) } catch { /* 非 JSON（如 302 的空 body） */ }
  return { status: res.statusCode, data, headers: res.headers || {} }
}
const auth = (u, p) => ({ 'x-user': u, 'x-password': p })
const mb = n => Buffer.alloc(Math.round(n * 1024 * 1024), 1)

// 造一个用户档案（生产环境里这些由图床项目写入，本地内存模式得自己造）
function makeUser(username, password, role = 'user', banned = false) {
  const salt = crypto.randomBytes(16).toString('hex')
  const passHash = crypto.scryptSync(password, salt, 32).toString('hex')
  return store._writeUser({ username, salt, passHash, role, banned, createdAt: new Date().toISOString() })
}
// 走一遍完整上传：签发令牌 → 直传 → 换密码，返回 { token, password, name, url, expiresAt }
async function uploadFlow(user, pass, fileName, sizeBytes = 1024) {
  const token = crypto.randomBytes(16).toString('hex')
  const pathname = `f/${token}/${fileName}`
  const r1 = await call('/api/upload', 'POST', {
    headers: auth(user, pass),
    body: { type: 'blob.generate-client-token', payload: { pathname, callbackUrl: 'https://x/api/upload', clientPayload: JSON.stringify({ size: sizeBytes }), multipart: false } },
  })
  if (r1.status !== 200) return { error: r1.data && r1.data.error, status: r1.status, token }
  const r2 = await call('/api/local-upload', 'PUT', {
    headers: { ...auth(user, pass), 'x-content-type': 'application/zip' },
    qs: { pathname },
    body: Buffer.alloc(sizeBytes, 7),
  })
  if (r2.status !== 200) return { error: r2.data && r2.data.error, status: r2.status, token }
  const r3 = await call('/api/finish', 'POST', { headers: auth(user, pass), body: { token } })
  return { ...(r3.data || {}), status: r3.status, token, error: r3.data && r3.data.error }
}

async function runTests() {
  // ---------- 0. 准备账号（模拟图床已存在的用户） ----------
  console.log('== 0. 准备账号 ==')
  await makeUser('zfbai', 'siBAIsiBAI', 'su')
  await makeUser('mltd', '123456', 'h')
  await makeUser('blocked', '123456', 'user', true)
  assert(!!(await store.readUser('zfbai')), '用户档案写入成功（与图床同格式）')

  // ---------- 1. 鉴权 ----------
  console.log('== 1. 鉴权 ==')
  let r = await call('/api/mine', 'GET')
  eq(r.status, 401, '无凭证访问返回 401')
  r = await call('/api/mine', 'GET', { headers: auth('zfbai', 'wrong') })
  eq(r.status, 401, '密码错误返回 401')
  r = await call('/api/mine', 'GET', { headers: auth('nobody', 'x') })
  eq(r.status, 401, '用户不存在返回 401')
  assert(String(r.data.error).includes('图片保存站'), '提示用的是图片保存站的账号')
  r = await call('/api/mine', 'GET', { headers: auth('blocked', '123456') })
  eq(r.status, 403, '被封禁账号返回 403')
  r = await call('/api/mine', 'GET', { headers: auth('zfbai', 'siBAIsiBAI') })
  eq(r.status, 200, '正确凭证通过')
  // 登录接口：前端靠它确认凭证（同源，不跨域调图床）
  r = await call('/api/login', 'POST', { headers: auth('zfbai', 'siBAIsiBAI') })
  eq(r.status, 200, '登录接口凭证正确返回 200')
  eq(r.data.username, 'zfbai', '登录成功返回用户名')
  r = await call('/api/login', 'POST', { headers: auth('zfbai', 'nope') })
  eq(r.status, 401, '登录接口密码错误返回 401')
  r = await call('/api/login', 'POST', { headers: auth('blocked', '123456') })
  eq(r.status, 403, '登录接口封禁账号返回 403')

  // ---------- 2. 签发直传令牌 ----------
  console.log('== 2. 签发直传令牌 ==')
  const tokenOk = () => crypto.randomBytes(16).toString('hex')
  r = await call('/api/upload', 'POST', {
    headers: auth('zfbai', 'siBAIsiBAI'),
    body: { type: 'blob.generate-client-token', payload: { pathname: 'f/' + tokenOk() + '/包.zip', clientPayload: '{}' } },
  })
  eq(r.status, 200, '合法压缩包签发成功')
  assert(String(r.data.clientToken).startsWith('vercel_blob_client_'), '返回官方格式的 clientToken')
  r = await call('/api/upload', 'POST', {
    headers: auth('zfbai', 'siBAIsiBAI'),
    body: { type: 'blob.generate-client-token', payload: { pathname: 'f/' + tokenOk() + '/病毒.exe', clientPayload: '{}' } },
  })
  eq(r.status, 400, '非压缩包扩展名返回 400')
  r = await call('/api/upload', 'POST', {
    headers: auth('zfbai', 'siBAIsiBAI'),
    body: { type: 'blob.generate-client-token', payload: { pathname: 'f/../别人的目录/x.zip', clientPayload: '{}' } },
  })
  eq(r.status, 400, '非法令牌/路径穿越返回 400')
  r = await call('/api/upload', 'POST', {
    headers: auth('zfbai', 'siBAIsiBAI'),
    body: { type: 'blob.generate-client-token', payload: { pathname: 'f/' + tokenOk() + '/../x.zip', clientPayload: '{}' } },
  })
  eq(r.status, 400, '文件名里的 .. 被拒绝')
  r = await call('/api/upload', 'POST', {
    headers: auth('zfbai', 'siBAIsiBAI'),
    body: { type: 'blob.generate-client-token', payload: { pathname: 'f/' + tokenOk() + '/超大.zip', clientPayload: JSON.stringify({ size: 5 * 1024 * 1024 }) } },
  })
  eq(r.status, 413, '超过单文件上限返回 413')
  r = await call('/api/upload', 'POST', {
    body: { type: 'blob.generate-client-token', payload: { pathname: 'f/' + tokenOk() + '/a.zip', clientPayload: '{}' } },
  })
  eq(r.status, 401, '未登录签发令牌返回 401')

  // ---------- 3. 上传 + 生成密码 ----------
  console.log('== 3. 上传 + 生成密码 ==')
  const up = await uploadFlow('zfbai', 'siBAIsiBAI', '我的模组包.zip', 2048)
  eq(up.status, 200, '完整上传流程成功')
  assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(up.password), '返回 8 位密码（形如 K7M2-QP93）')
  assert(!/[IO01]/.test(up.password), '密码不含易混淆字符 I O 0 1')
  assert(String(up.url).startsWith('https://download.mltd-imagesaving.site/'), '下载链接指向 download 域名')
  assert(String(up.url).includes(encodeURIComponent('我的模组包.zip')), '下载链接带原文件名')
  const idxList = await store.listFiles('_files/')
  eq(idxList.length, 1, '写入了一条取件索引')
  assert(/^_files\/\d+-[a-f0-9]{32}-[a-f0-9]{16}\.json$/.test(idxList[0].Key), '索引键形如 过期时间-令牌-密码指纹')
  assert(!idxList[0].Key.includes(up.password.replace('-', '')), '索引键里不含明文密码')
  r = await call('/api/finish', 'POST', { headers: auth('zfbai', 'siBAIsiBAI'), body: { token: 'x'.repeat(32) } })
  eq(r.status, 400, '登记不存在的令牌返回 400')

  // ---------- 4. 取件 ----------
  console.log('== 4. 取件（输密码换链接）==')
  r = await call('/api/open', 'POST', { body: { password: up.password.replace('-', '') } })
  eq(r.status, 200, '不带连字符的密码也能取件')
  eq(r.data.name, '我的模组包.zip', '返回正确文件名')
  r = await call('/api/open', 'POST', { body: { password: up.password.toLowerCase().replace('-', ' ') } })
  eq(r.status, 200, '小写 + 空格的密码也能取件（自动归一化）')
  const openUrl = r.data.url
  r = await call('/api/open', 'POST', { body: { password: 'ZZZZ-ZZZZ' } })
  eq(r.status, 404, '错误密码返回 404')
  assert(String(r.data.error).includes('过期'), '错误提示提到可能是过期')
  r = await call('/api/open', 'POST', { body: { password: 'ABC' } })
  eq(r.status, 400, '位数不对返回 400')

  // ---------- 5. 下载签名 ----------
  console.log('== 5. 下载签名校验 ==')
  const u = new URL(openUrl)
  const dlPath = '/dl' + u.pathname
  const e = u.searchParams.get('e'), s = u.searchParams.get('s')
  r = await call(dlPath, 'GET', { qs: { e, s } })
  eq(r.status, 302, '签名正确 → 302 跳转')
  assert(String(r.headers.Location).includes('.public.blob.vercel-storage.com/f/'), 'Location 指向 Blob 直链')
  r = await call(dlPath, 'GET', { qs: { e, s: 'f'.repeat(32) } })
  eq(r.status, 403, '签名被篡改 → 403')
  r = await call(dlPath, 'GET', { qs: { s } })
  eq(r.status, 403, '缺少过期时间 → 403')
  // 测过期得用「针对过去时间戳的正确签名」：签名绑定过期时间，签名不对会先被 403 拦下
  const pastE = Date.now() - 1000
  const dlToken = u.pathname.split('/')[1]
  const pastSig = crypto.createHmac('sha256', 'test-secret:dl').update(`${dlToken}:${pastE}`).digest('hex').slice(0, 32)
  r = await call(dlPath, 'GET', { qs: { e: String(pastE), s: pastSig } })
  eq(r.status, 410, '已过期 → 410')
  r = await call(dlPath, 'GET', { qs: { e, s } })
  eq(r.status, 302, '合法链接可重复下载（不是一次性的）')

  // ---------- 6. 我的文件 / 越权 ----------
  console.log('== 6. 我的文件与越权 ==')
  const up2 = await uploadFlow('mltd', '123456', '别人的包.7z', 1024)
  eq(up2.status, 200, 'mltd 也能上传（图床账号直接可用）')
  r = await call('/api/mine', 'GET', { headers: auth('zfbai', 'siBAIsiBAI') })
  eq(r.data.length, 1, 'zfbai 只看到自己的 1 个文件')
  eq(r.data[0].name, '我的模组包.zip', '看到的是自己传的那个')
  r = await call('/api/mine', 'GET', { headers: auth('mltd', '123456') })
  eq(r.data.length, 1, 'mltd 只看到自己的 1 个文件')
  r = await call('/api/delete', 'POST', { headers: auth('zfbai', 'siBAIsiBAI'), body: { token: up2.token } })
  eq(r.status, 403, '删别人的文件返回 403')

  // ---------- 7. 删除（提前失效） ----------
  console.log('== 7. 删除 ==')
  r = await call('/api/delete', 'POST', { headers: auth('zfbai', 'siBAIsiBAI'), body: { token: up.token } })
  eq(r.status, 200, '删自己的文件成功')
  r = await call('/api/open', 'POST', { body: { password: up.password.replace('-', '') } })
  eq(r.status, 404, '删除后密码立即失效')
  eq((await store.listFiles('f/' + up.token + '/')).length, 0, '文件本体已从存储删除')

  // ---------- 8. 站点配额 ----------
  console.log('== 8. 站点配额 ==')
  // 站点总配额 2MB：先传满 1MB（正好卡在单文件上限内），第二个就顶满配额了
  const fill1 = await uploadFlow('mltd', '123456', '占位1.zip', 1048576)
  eq(fill1.status, 200, '第一个 1MB 文件上传成功')
  const fill2 = await uploadFlow('mltd', '123456', '占位2.zip', 1048576)
  eq(fill2.status, 413, '超过站点总配额返回 413')
  assert(String(fill2.error).includes('存储已满'), '配额错误有中文提示')
  // 腾出空间给后面的用例
  r = await call('/api/delete', 'POST', { headers: auth('mltd', '123456'), body: { token: fill1.token } })
  eq(r.status, 200, '删掉占位文件释放空间')

  // ---------- 9. 过期清理 ----------
  console.log('== 9. 过期清理 ==')
  const up3 = await uploadFlow('mltd', '123456', '会过期的.zip', 1024)
  eq(up3.status, 200, '再传一个用于测试过期')
  // 把索引键改成"已过期"（键名第一段就是过期时间戳）
  const idx3 = (await store.listFiles('_files/')).find(f => f.Key.includes(up3.token))
  assert(!!idx3, '找到对应索引')
  const m = /^_files\/(\d+)-([a-f0-9]{32})-([a-f0-9]{16})\.json$/.exec(idx3.Key)
  await store.putFile(`_files/${Date.now() - 1000}-${m[2]}-${m[3]}.json`, await store.readFile(idx3.Key), 'application/json')
  await store.deleteFile(idx3.Key)
  // 任何一次 /api/upload 都会先跑一遍清理
  await call('/api/upload', 'POST', {
    headers: auth('mltd', '123456'),
    body: { type: 'blob.generate-client-token', payload: { pathname: 'f/' + tokenOk() + '/x.zip', clientPayload: '{}' } },
  })
  eq((await store.listFiles('f/' + up3.token + '/')).length, 0, '过期文件本体被清理')
  assert(!(await store.listFiles('_files/')).some(f => f.Key.includes(up3.token)), '过期索引被清理')
  r = await call('/api/open', 'POST', { body: { password: up3.password.replace('-', '') } })
  eq(r.status, 404, '过期后密码取不到件')

  // ---------- 10. 上传中断的孤儿对象 ----------
  console.log('== 10. 孤儿对象保护 ==')
  const orphanToken = tokenOk()
  await call('/api/local-upload', 'PUT', {
    headers: { ...auth('mltd', '123456'), 'x-content-type': 'application/zip' },
    qs: { pathname: `f/${orphanToken}/没登记的.zip` },
    body: Buffer.alloc(512, 3),
  })
  await call('/api/upload', 'POST', {
    headers: auth('mltd', '123456'),
    body: { type: 'blob.generate-client-token', payload: { pathname: 'f/' + tokenOk() + '/y.zip', clientPayload: '{}' } },
  })
  eq((await store.listFiles('f/' + orphanToken + '/')).length, 1, '刚上传还没登记的孤儿文件不会被立刻删掉')

  // ---------- 11. 取件限速 ----------
  console.log('== 11. 取件限速（抗密码爆破）==')
  const attacker = { 'x-forwarded-for': '9.9.9.9' }
  let last = null
  for (let i = 0; i < 11; i++) {
    last = await call('/api/open', 'POST', { headers: attacker, body: { password: 'ZZZZ-ZZZZ' } })
  }
  eq(last.status, 429, '同一 IP 连错 10 次后被锁（429）')
  assert(String(last.data.error).includes('错误次数过多'), '限速提示有中文说明')
  r = await call('/api/open', 'POST', { headers: { 'x-forwarded-for': '8.8.8.8' }, body: { password: up2.password ? up2.password.replace('-', '') : 'ZZZZ-ZZZZ' } })
  assert(r.status !== 429, '换一个 IP 不受影响（限速按 IP 隔离）')

  // ---------- 结果 ----------
  console.log(`\n${passed} 通过 / ${failed} 失败`)
  process.exit(failed ? 1 : 0)
}

runTests().catch(e => { console.error('测试异常:', e); process.exit(1) })
