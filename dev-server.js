// 本地预览/联调服务器：用 Node http 直接跑 Vercel 的入口，浏览器里能完整试用
// （内存存储，数据不持久，重启即清空）。
// 用法：node dev-server.js  然后浏览器打开 http://localhost:8788
//
// 这里模拟生产 vercel.json 的 rewrites，保证本地行为与线上一致：
//   download.mltd-imagesaving.site 的请求 → ?dl=
//   /api/xxx 的请求                      → ?path=xxx
// 另外会造两个本地测试账号（生产环境里账号来自图床项目）。

process.env.TEST_MEMORY = '1'  // 用内存 store，不碰真实 Blob
// 假的令牌和 store id：本地不连真实 Blob，但让签名逻辑走通（前端本地模式走 /api/local-upload）
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_localdev0000_localdev'
process.env.BLOB_STORE_ID = 'store_localdev0000'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const handler = require('./api/index.js')
const store = require('./api/store.js')

// 模拟 vercel.json rewrites
// 线上靠 Host 区分 download 域名，本地浏览器访问的是 localhost，
// 所以本地额外支持 /dl/xxx 这种路径写法（前端在本地模式会把下载链接换成这个形状）
function applyRewrites(req) {
  const u = new URL(req.url, 'http://localhost')
  const host = String(req.headers.host || '').replace(/:\d+$/, '')
  const origPath = u.pathname
  if (host === 'download.mltd-imagesaving.site') {
    u.pathname = '/api/index'
    u.searchParams.set('dl', origPath.replace(/^\//, ''))
  } else if (origPath.startsWith('/dl/')) {
    u.pathname = '/api/index'
    u.searchParams.set('dl', origPath.replace(/^\/dl\//, ''))
  } else if (origPath.startsWith('/api/')) {
    u.pathname = '/api/index'
    u.searchParams.set('path', origPath.slice('/api/'.length))
  }
  return u.pathname + u.search
}

// 造两个测试账号，密码哈希算法与图床一致（scrypt），所以本地测的就是线上那套
async function seedUsers() {
  const seeds = [
    { username: 'zfbai', password: 'siBAIsiBAI', role: 'su' },
    { username: 'mltd', password: '123456', role: 'h' },
  ]
  for (const s of seeds) {
    const salt = crypto.randomBytes(16).toString('hex')
    await store._writeUser({
      username: s.username, salt,
      passHash: crypto.scryptSync(s.password, salt, 32).toString('hex'),
      role: s.role, banned: false, createdAt: new Date().toISOString(),
    })
  }
}

const server = http.createServer(async (req, res) => {
  // 静态首页（模拟 Vercel public/ 目录的行为）
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')))
    return
  }
  req.url = applyRewrites(req)
  await handler(req, res)
})

server.listen(8788, async () => {
  await seedUsers()
  console.log('本地测试账号：zfbai / siBAIsiBAI（登录后即可上传）')
  console.log('本地预览：http://localhost:8788  （Ctrl+C 退出）')
  console.log('提示：本地没有真实 Blob，上传走内存存储，刷新页面或重启服务数据即清空')
})
