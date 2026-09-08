# R2 → Hugging Face 主存储与 Telegram 备份

本分支保留原项目的上传和文件管理接口，默认先写 R2，预计容量达到阈值时改写 Hugging Face。Telegram 保存独立副本，不参与自动主渠道重试。

## 配置

- 保留原有 KV (`img_url`) 或 D1 (`img_d1`) 数据库。
- 绑定 R2 为 `img_r2`。除了主文件，这个桶也保存容量预留和备份任务。
- 配置原项目 Hugging Face 渠道：`HF_TOKEN`、`HF_REPO`，私有仓库设置 `HF_PRIVATE=true`；也可在管理页面配置。
- 配置 Telegram 渠道：`TG_BOT_TOKEN`、`TG_CHAT_ID`，或在管理页面配置。机器人需要有向目标聊天发送文件的权限。
- 可选 `TG_BACKUP_CHANNEL_NAME` 固定备份渠道。开始备份后会固定渠道和机器人身份，避免分块混用机器人。
- 默认 `R2_AUTO_TIER_LIMIT_GB=10`、`R2_AUTO_TIER_THRESHOLD=95`；可显式设置环境变量覆盖。未设置时也兼容管理页面已有 R2 配额。
- 新客户端默认选择 R2。已有客户端若保存了 Telegram 偏好，请在上传设置改选 R2；显式选择 Telegram 仍保留原项目行为。

## 上传行为

`POST /upload` 未指定渠道、`uploadChannel=auto` 或 `uploadChannel=cfr2` 均启用分层。普通上传先做原子预留，成功或失败后释放；分块会话保留预留直到合并或清理，过期后先中止已登记的 multipart 再释放。R2 分块大小保持原前端的 16 MiB。

容量检查扫描**当前绑定桶的实际对象**，加上在途预留和 1 MiB 控制数据余量。它不依赖图床索引，也会计入未被索引记录的对象。并发预留通过 R2 ETag 条件写入仲裁。接近阈值时允许提前切换；上传完成和预留释放之间会短暂保守重复计数。

这不是整个 Cloudflare 账户的计费计量：其他桶、绕过本接口的写入、旧版本遗留的未完成 multipart，以及 API 操作费用不在控制范围内。要以免费额度为目标，请使用专用桶，并保留 R2 的未完成 multipart 生命周期清理规则。扫描成本约为每次路由每 1000 个对象一次 list 请求。

大文件在 R2 空间不足时，初始化返回 `409 hf_direct_upload_required`，本分支前端会自动调用原项目已有的 Hugging Face LFS 直传流程。API 客户端需做同样处理。Hug 未配置时返回 503，不越过阈值写 R2。

特殊情况下 API 可用 `tiering=off` 或 `forcePrimary=true` 绕过容量路由。正常 R2/Hug 上传默认备份到 Telegram；普通 `/upload` 的 `tgBackup=false` 可显式关闭副本。HF 直传提交始终创建副本任务。

## 备份的执行与重试

上传响应成功前先持久化任务。任务和分块清单保存在 R2 的 `.imgbed-internal/` 下，文件元数据仅新增稳定的 `BackupId`，不反复写同一个 KV key。不要手动修改该目录；公开 R2 自定义域名应阻止直接访问此目录。不要为此目录配置自动删除生命周期。

备份每次最多读取、发送一个 8 MiB 分块，保存进度，失败指数退避重试。没有原来的 800 MiB 人为上限。领取任务使用条件写入和过期租约；崩溃后可恢复。Telegram 不提供发送幂等键：若发送成功后进程在记录结果前终止，可能重复发送最后一块，但恢复清单只引用已确认的分块。

- **Worker**：本分支生成器及 Wrangler 配置包含每分钟的 Cron Trigger，浏览器关闭后也会重试。
- **Docker**：服务进程每分钟继续任务。支持原项目单进程、本地数据目录部署；不要让多个进程共享同一目录。
- **Pages**：上传页保持打开时会主动推进任务。Pages 没有 Cron Trigger；要保证关页后仍自动重试，必须在常驻机器运行下方 runner，或定时 POST `/api/telegramBackupRun`。

Pages 端和 runner 端设置相同的随机 secret `TG_BACKUP_RUNNER_TOKEN`，runner 再设置 `IMGBED_URL`：

```sh
node deploy/telegram-backup-runner.mjs
# 外部调度器每次只运行一步：
node deploy/telegram-backup-runner.mjs --once
```

`TG_BACKUP_RUNNER_TOKEN` 只授权推进队列，不用于下载备份。缺失或失效的渠道配置会保留任务为 retrying；恢复配置后继续。上传成功表示主存储已保存且任务已持久化，**不代表 Telegram 已完成**。

## 查看与恢复

以下接口使用原项目管理登录或具备 `manage` 权限的 API Token：

- `GET /api/manage/telegramBackup?fileId=<文件ID>`：状态、已完成分块、错误和重试时间。
- `POST /api/manage/telegramBackup?fileId=<文件ID>`：为已有 R2/Hug 文件补建备份任务。
- `GET /api/manage/telegramBackup?fileId=<文件ID>&download=true`：下载完成的备份，支持单个 `Range: bytes=start-end`。

大文件建议分段下载，避免单次请求超过 Workers 免费套餐的外部子请求限制。设置 `IMGBED_URL` 和 `IMGBED_MANAGE_TOKEN` 后运行：

```sh
node deploy/download-telegram-backup.mjs "folder/file.zip" "recovered.zip"
```

原 `/file/...` 在通过原有访问控制后，遇到 R2/Hug 返回 404 或 5xx 时尝试读取已完成的 TG 副本；访问权限不会被绕过。移动和重命名会保留新文件的备份关联。删除主文件后不会自动复活文件记录；尚未完成的任务会取消，TG 中已有消息和完成的备份清单保留，不会自动删除远端备份。

## 验证与维护

```sh
npm run test:storage
node deploy/worker/generate-routes.js
npx wrangler deploy --dry-run --config deploy/worker/wrangler.toml
```

前端逻辑已同步到同级 `Sanyue-ImgHub` 源码，保留该仓库已有界面修改。在前端目录执行 `npm test`，再执行 `npm run build -- --dest ../CloudFlare-ImgBed/frontend-dist` 更新完整资源（包含 gzip 和 source map）。默认渠道仅在没有用户配置时选用 R2，已有显式渠道选择保持不变。不要再使用编译文件字符串补丁。
