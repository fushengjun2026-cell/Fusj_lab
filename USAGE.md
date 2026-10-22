# Codex 个人用量

入口：Lab 第一张卡片，页面为 `usage.html`。输入现有笔记管理密码后可见。
额度数据与账户每日 Token 活动分别显示，不把 Token 数换算成剩余额度。

## 更新方式

本机同步程序每 60 秒通过 `codex app-server` 读取 `account/rateLimits/read`
和 `account/usage/read`。前者提供额度分组、周期、已用比例、重置时间、点数及
可用重置次数；后者提供累计 Token、连续使用天数和每日 Token 记录。
没有返回的项目保持未知，不填入演示数字。

同步程序只上传明确挑选的统计字段，不上传账号 ID、邮箱、授权令牌、提示词或对话。
Cloudflare 保存最近一条成功同步；网页登录后每 30 秒检查更新。
电脑关机、休眠、断网、退出 Codex 登录或本地代理不可用时暂停同步。
超过三分钟没有新记录，网页会明确标为上次同步记录；原额度周期结束后，
不推算新的剩余额度，等待下一条成功同步。

## 私有配置与启动

使用 Node.js 22+、已登录的本机 Codex CLI 和系统 curl。
默认配置路径：`~/Library/Application Support/FusjLab/codex-usage.json`，权限为 `600`。

配置字段：`syncUrl`、`syncToken`、`codexPath`、`intervalSeconds`，以及可选 `proxyUrl`。
同步密钥由维护者随机生成，与 Cloudflare Secret `USAGE_SYNC_TOKEN` 一致，
不写入仓库，也不放进网页。该密钥只能上传用量，不能读取用量或修改笔记。

```sh
node tools/codex-usage-sync.mjs --once
node tools/codex-usage-sync.mjs
node tools/install-usage-agent.mjs
```

`--once` 用于首次验证；默认持续运行。`--read-only` 只在本机输出已筛选的统计信息。
管理登录沿用 Note 的会话和服务器密码校验；匿名请求无法读取用量。
本机通过用户级 LaunchAgent 保持同步进程，登录 macOS 后启动，退出登录后结束。
安装器将运行所需的脚本复制到 `~/Library/Application Support/FusjLab/runtime/`，
后台运行不依赖仓库目录；更新同步脚本后，重新运行安装器使后台版本生效。
LaunchAgent 标签为 `com.fusjlab.codex-usage`；运行
`node tools/install-usage-agent.mjs --uninstall` 可停止并取消登录时的自动同步，
再次运行安装器即可启用。私有配置与日志不会因卸载而删除。
日志位于 `~/Library/Logs/FusjLab/`，只记录同步结果，不记录统计正文或凭证。

## 服务与数据

- `GET /api/codex-usage`：需要现有有效管理会话。
- `PUT /api/codex-usage/sync`：需要独立同步密钥；服务端校验、筛选字段并阻止旧记录覆盖新记录。
- 数据单独保存在 Durable Object 的 `codex_usage` 表，不修改笔记或笔记历史。
- 不向前端提供额度重置、消费点数、账户登录等操作。

验证包含私有读取、上传与阅读权限隔离、过期会话、重启持久化、统计数据校验、
乱序更新，以及周期结束时保留未知状态。运行 `pnpm test`。

官方协议：[Codex App Server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)。
