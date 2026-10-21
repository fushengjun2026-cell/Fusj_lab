# 笔记的阅读与管理

Note 的管理入口使用统一密码。拥有密码的人可新建、编辑、删除和发布；
访客无需登录即可阅读、搜索、筛选和分享单篇笔记。

## 日常使用

1. 在正式 HTTPS 网站打开 Note，点击「管理笔记」。
2. 输入管理密码，点击「进入管理」。
3. 点击「写一篇」或打开现有笔记后点击「编辑笔记」。
4. 点击「发布笔记」或「发布修改」，其他设备刷新后即可看到。

登录有效期为一天，当前标签页刷新后仍可恢复。密码不写入网页、仓库、地址或
浏览器存储。浏览器标签页会话中只保存随机登录凭证；每次写入都由云端验证。
退出管理会清除本地凭证，并请求云端撤销登录。密码变更后，旧登录无法再写入。

网页代码继续由 GitHub Pages 托管；笔记实时保存在 Cloudflare 的 SQLite
Durable Object 中，不再通过浏览器写 GitHub 仓库。发布笔记无需触发网站构建。
GitHub 上的 `data/notes.json` 是初始数据及离线备份，实时发布不会自动修改它。
在线服务不可达时，网页会明确显示「网站已发布版本」，此时可能不是最新内容。

## 草稿和多人编辑

未发布的草稿保存在当前设备，不会跨设备同步，也不会被访客看到。
浏览器无法保存草稿时，会提示复制正文；发布失败时保留编辑器内容。

多人可同时管理。不同笔记的修改会合并保存；同一篇笔记已被其他人修改或删除时，
旧版本的编辑和删除会被拒绝，避免覆盖对方的内容。发布响应丢失时，重试不会
重复创建同一篇笔记。正文按纯文本显示，保留段落，不执行其中的 HTML。

云端保留最近 50 次修改之前的完整笔记本，登录后可通过 `GET /api/history`
导出历史记录用于恢复。`GET /api/notes` 可导出当前公开笔记本。历史接口不可匿名读取。

## 首次部署（维护者）

需要 Cloudflare 账号；完成一次 Wrangler 登录后，可部署后端。
使用 Node.js 和 pnpm：

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler secret put NOTES_PASSWORD --config server/wrangler.jsonc
pnpm notes:deploy
```

`NOTES_PASSWORD` 仅保存在 Cloudflare Secret 中，不填入源码。
设置为站长指定的管理密码。Wrangler 会创建笔记存储，不需要另外创建数据库。
如果先部署再设置 Secret，设置完成前所有登录和写入都会被拒绝，公开阅读仍可用。

部署一个 Pages 访问入口（通过 Service Binding 连接上面的笔记服务）：

```sh
pnpm exec wrangler pages deploy public --cwd server/gateway --project-name fusj-notes-api --branch main
```

当前公开接口为 `https://fusj-notes-api.pages.dev`。它与 Worker 共用同一份笔记、
同一套密码验证，不保存第二份数据；用于改善部分网络对 `workers.dev` 的解析问题。

将这个 HTTPS 接口根地址填入 `js/notes-config.js` 的 `NOTES_API_URL`。
然后提交和发布前端。后端 `ALLOWED_ORIGINS` 包含正式 GitHub Pages 的来源及
本地预览来源；修改网站域名后需同步更新允许的来源。所有来源只写协议、域名和端口，
不包含页面路径。`file://` 不支持管理，请用网站地址或本地 HTTP 预览。

`data/notes.json` 只在云端笔记本首次创建时导入。后续部署代码不会覆盖已保存的笔记。
可重新设置 `NOTES_PASSWORD` 更改管理密码；不用修改前端。登录请求有云端次数限制，
即使绕过网页直接请求接口，也必须拥有有效登录凭证才能写入。

## 本地验证

在 `server/.dev.vars` 设置本地测试密码（文件已忽略，勿提交），启动：

```sh
pnpm notes:dev
python3 -m http.server 8765 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8765/note.html`；在线地址尚未配置时，本地页面自动连接
`http://127.0.0.1:8787`。本地和线上存储完全隔离。不要把本地测试笔记发布到正式环境。

运行 `pnpm test` 验证密码、服务端权限、登录有效期、跨设备读写、并发冲突、
发布重试、数据库回滚与请求大小限制。测试使用内存 SQLite，不写云端或 GitHub。

参考：[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)、
[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、
[SQLite Durable Object](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。
