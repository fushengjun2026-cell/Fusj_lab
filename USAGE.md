# Codex 个人用量

入口：Lab 第一张卡片，页面为 `usage.html`。打开即可查看，无需密码或登录；手动刷新也无需密码。
额度数据与账户每日 Token 活动分别显示，不把 Token 数换算成剩余额度。

每日柱状图支持点击或触摸选择日期，显示当日用量：大数使用“万 / 亿 Token”，
并在下方保留精确数值。默认选中最新的有效记录；左右按钮或键盘方向键可切换
有记录的日期。刷新时保留所选日期，切换时间范围后仍可继续查看每日明细。

## 更新方式

打开页面只读取云端已保存的结果，不会查询账号。
点击“刷新数据”才提交一次请求：在线的电脑同时读取 `account/rateLimits/read`
和 `account/usage/read`，分别获取额度与每日 Token 统计，再把结果返回网页。
没有点击时，不自动按分钟、按天或在电脑启动时读取账号。

网页显示等待电脑、正在读取、完成、部分返回或失败；请求最多等待两分钟。
电脑休眠、关机、断网时不能处理请求，超时后可重新手动刷新。
只有正在等待一次手动请求时，网页才轮询云端结果；平时不自动加载数据。
图表和额度分别显示来源时间。部分数据未返回时保留上次值，不将旧记录标成
本次成功读取；额度读取失败也不会丢弃已经成功返回的每日统计。

电脑后台只每五秒检查是否有手动刷新请求，没有请求时不访问 OpenAI。
进行中的重复刷新会合并，每分钟最多新建六次请求。
同一请求只读取一次账号，网络上传失败时重发缓存的结果，不重复读取账号。
读取失败不自动重试；用户可以再次点击刷新，当天也能立即重新读取。

同步程序仅上传筛选后的统计字段，不上传账号 ID、邮箱、登录令牌、提示词或对话。

## 私有配置与启动

使用 Node.js 22+、已登录的本机 Codex CLI 和系统 curl。
默认配置路径：`~/Library/Application Support/FusjLab/codex-usage.json`，权限为 `600`。
同目录的 `codex-usage.json.cache.json` 保存统计缓存与待交付的手动刷新结果，权限同为 `600`，
不包含登录凭证。旧版本的每日尝试日期会被忽略，不再限制手动刷新。

配置字段：`syncUrl`、`syncToken`、`codexPath`、`pollSeconds`，以及可选 `proxyUrl`。
同步密钥由维护者随机生成，与 Cloudflare Secret `USAGE_SYNC_TOKEN` 一致，
不写入仓库，也不放进网页。该密钥可领取刷新任务和交付统计结果，不能修改笔记；统计读取现已公开。

```sh
node tools/codex-usage-sync.mjs --once
node tools/codex-usage-sync.mjs
node tools/install-usage-agent.mjs
```

`--once` 只检查和处理一次待办刷新；没有待办时不查询账号。默认持续等待手动请求。
`--read-only` 是维护者主动读取账号并在本机输出筛选后统计的命令，不会上传。
用量页面不读取或保存管理会话；后台上传和任务交付仍验证独立同步密钥。
本机通过用户级 LaunchAgent 保持同步进程，登录 macOS 后启动，退出登录后结束。
安装器将运行所需的脚本复制到 `~/Library/Application Support/FusjLab/runtime/`，
后台运行不依赖仓库目录；更新同步脚本后，重新运行安装器使后台版本生效。
LaunchAgent 标签为 `com.fusjlab.codex-usage`；运行
`node tools/install-usage-agent.mjs --uninstall` 可停止并取消登录时的自动同步，
再次运行安装器即可启用。私有配置与日志不会因卸载而删除。
日志位于 `~/Library/Logs/FusjLab/`，只记录同步结果，不记录统计正文或凭证。

## 服务与数据

- `GET /api/codex-usage`：公开读取筛选后的统计及刷新状态，不包含任务交付凭据。
- `POST /api/codex-usage/refresh`：公开创建手动刷新请求，进行中的重复请求合并，每分钟最多六次新请求。
- `POST /api/codex-usage/refresh/claim`：独立同步密钥领取任务，仅返回任务 ID 与交付凭据。
- `PUT /api/codex-usage/refresh/complete`：独立同步密钥交付结果，任务状态和统计在同一事务保存。
- `PUT /api/codex-usage/sync`：保留维护用上传接口，不用于后台自动同步。
- 数据单独保存在 Durable Object 的 `codex_usage` 表，不修改笔记或笔记历史。
- 不向前端提供额度重置、消费点数、账户登录等操作。

验证包含公开读取、上传凭据保护、笔记管理权限、重启持久化、统计数据校验、
乱序更新，以及周期结束时保留未知状态。运行 `pnpm test`。

官方协议：[Codex App Server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)。
