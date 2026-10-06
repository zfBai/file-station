# 文件传输站（file-station）

给朋友临时传压缩包的小站：

```
你：拖入 xxx.zip  →  拿到密码 K7M2-QP93  →  把密码发给朋友
朋友：打开 file.mltd-imagesaving.site  →  输入密码  →  点下载
30 分钟后：文件自动删除，密码和链接一起失效
```

- 面向用户的地址：**https://file.mltd-imagesaving.site**（上传 + 输密码取件都在这里）
- 下载直链地址：**https://download.mltd-imagesaving.site**（输对密码后拿到的链接指向它）
- 账号：**与图床共用**（image.mltd-imagesaving.site 的账号密码直接能登录，不用单独注册）
- 限制：只收 ZIP / RAR / 7Z，单个最大 300MB，站点总存储 900MB
- 有效期：30 分钟（可用环境变量改）

---

## 一、它是怎么工作的

```
浏览器                          本站函数(Vercel)                Vercel Blob
  │                                  │                              │
  ├─① POST /api/upload ─────────────►│  校验登录 + 大小 + 配额        │
  │                                  ├─ 签发一次性直传令牌 ─────────►│
  │◄──────────── clientToken ────────┤                              │
  │                                  │                              │
  ├─② PUT 文件（带令牌，直传）────────────────────────────────────►│  文件存在这里
  │                                  │                              │
  ├─③ POST /api/finish ─────────────►│  生成密码，写一条取件索引 ────►│
  │◄──────────── 密码 K7M2-QP93 ─────┤                              │
  │                                  │                              │
朋友输密码 ─④ POST /api/open ────────►│  按密码找到索引，返回下载链接  │
点下载    ─⑤ GET download.…/… ──────►│  校验签名 → 302 ──────────────►│  浏览器直接下
```

**为什么文件不经过本站函数？** Vercel 函数的请求体上限只有 4.5MB，300MB 的包根本传不进来。
所以文件由浏览器带着一次性令牌**直接 PUT 给 Vercel Blob**，本站函数只负责签发令牌和记账。

**为什么下载是 302 跳转而不是函数代理？** Vercel 函数的响应体也有体积上限，300MB 的包同样回不来。
所以 download 域名只做签名和过期校验，然后把流量直接甩给 Blob 的 CDN。

### 数据布局（Blob key）

| 前缀 | 内容 | 说明 |
|---|---|---|
| `f/{32位令牌}/{原文件名}` | 文件本体 | 令牌是 128 位随机数，猜不到就等于拿不到 |
| `_files/{过期毫秒}-{令牌}-{密码指纹}.json` | 取件索引 | 三段都编码在键名里，取件和清理都不用读内容 |
| `_users/{用户名}.json` | 用户档案 | **图床写入的**，本站只读，所以账号是共用的 |

索引键里存的是密码的 HMAC 指纹（不是明文，也不是能直接反推的哈希），
所以就算有人翻到了 Blob 列表，也看不出密码是什么。

---

## 二、目录结构

```
file-station/
├── api/
│   ├── index.js      单段入口：从 query 恢复原始路径（vercel.json 的 rewrites 把请求收到这里）
│   ├── core.js       全部业务逻辑：签发直传令牌 / 生成密码 / 取件 / 下载 / 过期清理
│   └── store.js     数据层：Blob（生产）/ 内存（本地测试）两套实现
├── public/
│   └── index.html    前端单页：登录 / 拖拽上传 / 显示密码 / 输密码取件
├── dev-server.js     本地预览服务器（内存存储，不碰真实 Blob）
├── test.js           本地全流程测试（56 项）
├── vercel.json       rewrites：download 域名 → ?dl=，/api/* → ?path=
└── package.json
```

---

## 三、本地开发

```bash
cd file-station
npm install
node test.js          # 跑测试，56 项全过即可
node dev-server.js    # 本地预览：http://localhost:8788
```

本地测试账号：`zfbai` / `siBAIsiBAI`、`mltd` / `123456`（内存里现造的，重启就没了）。

本地是内存存储，**上传的文件刷新页面就没了**，也不会连真实的 Vercel Blob ——
真实直传（浏览器直接 PUT 到 Blob）只能在部署后验证。

---

## 四、部署

### 步骤 1：建 GitHub 仓库并推送

在 GitHub 上新建一个仓库（比如 `file-station`，**不要**勾选 Add README），然后：

```bash
cd file-station
git init
git add .
git commit -m "文件传输站：上传加密压缩包，密码取件，30 分钟自动删除"
git branch -M main
git remote add origin https://github.com/zfBai/file-station.git
git push -u origin main
```

### 步骤 2：Vercel 导入项目

1. 打开 https://vercel.com/new
2. 选 `file-station` 仓库 → Import
3. Framework Preset 保持 **Other**，其余不用改 → Deploy

### 步骤 3：连接图床那个 Blob 存储（关键！）

账号共用就靠这一步 —— 让新项目能读到图床写在 `_users/` 里的用户档案。

1. Vercel 控制台 → **Storage** → 点开已有的那个 Blob store（图床在用的，如 `img-station-blob`）
2. 切到 **Projects** 标签 → **Connect Project**
3. 选 `file-station`，环境选 **Production / Preview / Development 全勾**
4. **务必勾选 `BLOB_READ_WRITE_TOKEN`**（浏览器直传靠它签发令牌，不勾就传不了）
5. 连接完成后，去 `file-station` 项目的 **Deployments → 最新一条 → Redeploy**（连了存储不会自动重新部署）

### 步骤 4：绑定两个域名

**先加 Vercel 域名：**

项目 → Settings → Domains → 分别添加：

- `file.mltd-imagesaving.site`
- `download.mltd-imagesaving.site`

添加后 Vercel 会给每个域名显示一个 CNAME 目标（形如 `xxxxxxxx.vercel-dns.com`），记下来。

**再去 Cloudflare 加解析**（域名的 DNS 托管在 Cloudflare）：

| Type | Name | Target | 代理状态 |
|---|---|---|---|
| CNAME | `file` | Vercel 给的 CNAME 目标 | **DNS only（灰云）** |
| CNAME | `download` | Vercel 给的 CNAME 目标 | **DNS only（灰云）** |

⚠️ 一定要选灰云，**不要开橙色云代理**（跟图床的 `image` 记录一样）。

### 步骤 5：设置环境变量（可选但建议）

项目 → Settings → Environment Variables：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `FILE_SECRET` | 密码指纹和下载链接的签名密钥，**建议设一个随机字符串** | `file-station-default-secret` |
| `FILE_TTL_MINUTES` | 文件保留多少分钟 | `30` |
| `MAX_FILE_MB` | 单文件上限（MB） | `300` |
| `TOTAL_QUOTA_MB` | 站点总存储上限（MB） | `900` |

改完环境变量要 Redeploy 才生效。

> 改了 `MAX_FILE_MB` / `FILE_TTL_MINUTES`，顺手把 `public/index.html` 顶部
> 的 `MAX_FILE` 常量和文案一起改掉（只影响页面提示，服务端仍然按环境变量拦截）。

### 步骤 6：验证

1. 打开 `https://file.mltd-imagesaving.site` → 用图床账号登录
2. 拖一个 zip 进去 → 应该出现进度条，然后显示大号密码
3. 无痕窗口打开同一个网址 → 输入密码 → 应该出现文件名和下载按钮
4. 点下载 → 浏览器开始下载文件

---

## 五、和图床（img-station）的关系

| | 图床 | 文件站 |
|---|---|---|
| 域名 | `image.mltd-imagesaving.site` | `file.` + `download.` |
| Vercel 项目 | `img-station` | `file-station`（独立项目、独立仓库） |
| Blob 存储 | **同一个** | **同一个**（所以账号能共用） |
| 数据前缀 | `{用户名}/`、`_users/` | `f/`、`_files/` |

因为两个站共用一个 Blob store，图床的 `api/core.js` 里的「恢复如初」（Start-over）
**已经改过一行**：初始化时只删图片和账号，跳过了 `f/` 和 `_files/` 前缀，
免得清空图床的时候把文件站的文件一起删了。

> 如果哪天把文件站改回独立 Blob store，那行过滤可以撤掉。

---

## 六、常见问题

**Q：`git push` 报 `Recv failure: Connection was reset`？**

这是网络把 `github.com` 解析到了一个连不通的 IP（`api.github.com`、`codeload.github.com`
通常还是好的，所以症状很迷惑）。先找一个能用的 IP：

```bash
nslookup github.com          # 看当前解析到哪个（多半不通）
for ip in 140.82.112.4 20.27.177.113 20.205.243.166; do
  curl -s -o /dev/null -m 6 -w "$ip → %{http_code}\n" --resolve "github.com:443:$ip" https://github.com
done
```

挑回 `200` 的那个，写进 git 全局配置（只对 github.com 生效，`<IP>` 换成上一步的结果）：

```bash
git config --global http.curloptResolve "github.com:443:<IP>"
```

IP 会变，以后再推不动就重跑这两步。想撤掉这条配置：`git config --global --unset http.curloptResolve`。

**Q：点下载没反应 / 一直转圈？**
先直接访问 `https://<store-id>.public.blob.vercel-storage.com` 看通不通。
`vercel-storage.com` 在部分网络环境下可能被污染，如果确实打不开，
可以把 `download` 域名套一层 Cloudflare Worker 回源（改 `core.js` 的 `download()`，
不返回 302 而是由边缘流式转发）。

**Q：传大文件失败？**
- 先看是不是超过 300MB（前端会直接拦）
- 再看 Vercel → Storage → 用量，免费额度约 1GB 存储 / 10GB 月流量，
  **超额不会扣钱，但 Blob 会被暂停 30 天**（图床也会跟着用不了），所以总量上限默认卡在 900MB
- 单文件超过 100MB 时网络中断的概率变高，传大包建议先压缩

**Q：密码忘了 / 传完忘了发给谁？**
首页登录后「我上传的文件」能看到最近 30 分钟的记录，可以重新复制链接或提前删除。
密码只在上传成功那一刻显示一次，服务端不存明文，**找不回来**，30 分钟后文件也会自己消失。

**Q：为什么输密码不要登录，上传却要登录？**
取件只是拿一个 30 分钟有效的链接，给个密码就够了；
上传要往存储里写东西，得先确认是谁在写，所以必须登录（图床账号）。

**Q：想改成 7 天有效期？**
Vercel 环境变量 `FILE_TTL_MINUTES=10080` 即可。清理是「有人访问就顺手清一次」的惰性机制
（Vercel 免费版的定时任务一天只能跑一次，扛不住短有效期），
所以过期文件最迟会在过期后的**下一次访问**时被清掉，不影响链接本身的过期判断。
