# 后端性能、内存与稳定性审查 · 2026-09-26

> 后续状态：本报告记录修复前的审查结果。F01–F15 已在当前工作区修复；完整回归 132 项通过，升级与运行边界见 [修复记录](backend-repairs-2026-09-26.md)。未部署线上。

结论：当前已有流式转发、分片上传、备份租约及索引原子发布等基础，但部分入口没有共享这些保障。优先问题是分片下载缺少背压、本地合并整文件驻留、列表重复全量读取，以及失败上传和重命名的一致性。单纯增加缓存或提高并发不能解决这些问题。

**范围与证据边界**

- 基线：`986e0989a41fb9eb97ed52b97482e2eb92b66876` 加审查开始时已有工作区修改；包含尚未提交的索引发布和移动修复。
- 覆盖 Worker/Pages 与 Node 两套入口、D1/KV/SQLite 适配、管理列表与索引、文件下载、普通和分片上传、六类存储渠道、WebDAV、缩略图、随机图/公开图库、鉴权会话、自动分层、Telegram 备份与源站切换。静态追踪关键调用链；不是所有第三方服务的真实端到端测试。
- 当前 Worker 配置绑定 D1/R2；Node 启用 STATE_GATEWAY 时使用 RemoteD1/RemoteR2。下述 LocalR2 问题只在 Node 本地存储模式生效，不能据此断定线上共享 R2 路径也发生同样复制。
- 本次 `npm test`：56/56 通过（31 项存储相关，25 项审计/源站/索引相关）。另完成 11 组隔离复现；断言刻意验证当前缺陷，不能解释为缺陷已修复。
- 没有访问生产数据或对线上施压；没有生产 P95/P99、RSS 曲线或吞吐基线。缓冲测量来自本机 Node，小规模结果不能直接当作线上峰值。
- 本次只新增本报告和本地复现材料，未修改业务代码、提交或部署。

复现脚本：[reproduce.mjs](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/.codex-tmp/backend-review-20260926/reproduce.mjs)。结果：[results.json](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/.codex-tmp/backend-review-20260926/results.json)。运行：

```powershell
node --expose-gc --import ./deploy/server/register.mjs .codex-tmp/backend-review-20260926/reproduce.mjs
```

**已确认的问题**

P1 表示优先修复的稳定性、数据一致性或显著资源风险；P2 表示应安排修复的性能与规模问题。

| 编号 | 优先级 | 问题 | 适用范围 | 证据 |
| --- | --- | --- | --- | --- |
| F01 | P1 | 分片下载不服从客户端读取速度 | TG/Discord 主存储 | TG 路由复现；Discord 同构代码 |
| F02 | P1 | 本地分片合并约三份文件缓冲并同步读写 | Node LocalR2 | 8 MiB 文件额外约 24 MiB ArrayBuffer |
| F03 | P1 | 每次分页重复加载全量索引 | 两套运行时 | 1000 条索引返回 50 条，所有块读取两次 |
| F04 | P1 | 批量重建失败破坏当前索引指针 | 两套运行时 | 故障注入后当前索引不可读 |
| F05 | P1 | 分片失败仍返回成功，D1 无数据可重试 | 两套运行时，D1 更严重 | HTTP 200、存储状态 failed、value 为空 |
| F06 | P1 | 重命名在元数据提交前删除源文件 | R2，S3/WebDAV 同类顺序 | 元数据失败后源对象消失 |
| F07 | P1 | D1 settings 缺分页导致会话撤销不完整 | D1/SQLite/RemoteD1 | 1001 个会话只撤销 1000 个 |
| F08 | P2 | 缩略图没有请求级并发和排队上限 | Node sharp | 8 个请求同时进入源数据读取 |
| F09 | P2 | 每次自动上传都扫描整个 R2 桶 | 自动分层路径 | 3000 个对象、3 次上传产生 9 次 list |
| F10 | P2 | 成功重命名没有更新公开别名 | 使用公开链接的文件 | 200 后旧别名仍指向已删除元数据 |
| F11 | P2 | D1 忽略过期设置，临时记录持续积累 | D1/SQLite/RemoteD1 | TTL 1 秒记录超时后仍存在 |
| F12 | P2 | 不存在的公开 ID 触发全库搜索和逐文件哈希 | 公开文件入口 | 相同无效 ID 的 3 次请求扫描 3 次 |
| F13 | P2 | 上传体重复解析并在验证前完整缓冲 | 分片与部分普通上传 | 跨 middleware/handler 调用链 |
| F14 | P2 | 合并前重复串行检查分片，完成后串行清理 | 分片上传，RemoteD1 尤甚 | 成功路径 3N 次检查 + N 次清理 |
| F15 | P2 | 即时备份缺少跨文件并发限制 | R2/HF 的 Telegram 备份 | 每次上传直接启动独立任务 |

**F01 · 分片下载需要改为按需读取。**

位置：[TG 流构造](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/file/[[path]].js:358)、[Discord 流构造](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/file/[[path]].js:552)。二者在 `ReadableStream.start()` 中遍历所有分片，每片先 `arrayBuffer()`，随后持续 `enqueue()`；没有 `pull()`、字节预算或取消上游的控制。复现中客户端读取 0 字节，服务端仍完成 8/8 分片拉取。慢下载时，队列可能增长到请求范围的总大小，顺序 await 并不等于背压。

建议抽取共同的按需流，在 `pull()` 中逐段读取上游、最多保留有界预取，`cancel()` 联动 AbortController。可参考项目已有的 [备份恢复流](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/telegramBackup.js:320)。验收：停止读取后预取停止；中断客户端后上游停止；增长受缓冲预算约束，而非文件大小。Workers isolate 的内存上限是 128 MB，且同一 isolate 可处理多个请求，因此这一问题会直接影响并发可用性。[Cloudflare 限制说明](https://developers.cloudflare.com/workers/platform/limits/)

**F02 · LocalR2 分片合并会产生接近 3 倍文件大小的缓冲。**

位置：[complete()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/deploy/server/r2Storage.js:202)、[put()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/deploy/server/r2Storage.js:94)。先把全部分片读为 Buffer，再 `Buffer.concat()`，传给 `put()` 后 `Buffer.from()` 再复制。8 MiB 样本在进入 put 前额外约 16 MiB，put 后约 24 MiB ArrayBuffer；这不是 RSS 峰值测量。读取、拼接和落盘还发生在主事件循环。`put(ReadableStream)` 同样先完整收集，重命名/移动大对象也受影响。

建议使用异步文件流按顺序写临时文件，完成校验后原子 rename；保留内部小 JSON 对象所需的条件写入语义。缺失分片必须失败，不能直接跳过。验收应覆盖大文件、磁盘错误、客户端断开、并行上传和条件写冲突。

**F03 · 管理列表的分页没有限制后端工作量。**

位置：[readIndex()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/indexManager.js:523)、[loadChunkedIndex()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/indexManager.js:1992)。`readIndex` 先调用会读取完整索引的 merge，再调用 getIndex 重读；即使没有待处理操作也发生。随后才过滤和 slice，所有索引块还会同时发起读取。列表、公开图库、随机图、标签联想和部分文件别名解析都会进入该路径。

索引异常时，[列表降级](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/api/manage/list.js:161)调用全库扫描，仅按目录返回，未保持 start/count/search 等筛选语义；失败越多，工作量越大。建议短期先复用已读取快照、合并同一实例上的重复加载并限制分块 I/O 并发；长期为 D1 使用数据库过滤、稳定排序和游标分页，KV 保留独立方案。验收用 1 万/10 万条元数据比较单页查询的扫描量、分配量和延迟。

**F04 · 批量重建接口绕过了已有的原子发布修复。**

位置：[saveIndex()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/api/manage/batch/index/finalize.js:243)。它先覆盖 meta，再写固定名称的 `manage@index_0...`，没有 generation 或 CAS，且会在保存前清理旧块。复现先构造有效旧 generation，在新块写入时注入错误：接口 500，旧块仍在，meta 已改为指向不存在的新块，当前索引不可读。

建议所有发布入口统一调用已存在的 `saveChunkedIndex`，以基线快照进行条件发布，成功后再按保留期 GC。验收覆盖任意块失败、两个重建并发、重建与增量合并并发，以及不丢失重建期间的新操作。

**F05 · 分片失败被当成成功，超时也没有终止工作。**

位置：[handleChunkUpload 返回](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/upload/chunkUpload.js:166)、[超时包装](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/upload/chunkUpload.js:217)、[重试数据读取](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/upload/chunkUpload.js:863)。内层将失败写入 metadata 后不向调用方传播，外层无条件返回 200/success。D1 路径不保存二进制，合并时服务端重试又要求 value 非空，结果无法恢复该失败分片。

复现得到 HTTP 200、`success:true`，但分片状态为 failed、value 为空；同时留下一个 180 秒定时器。`Promise.race` 仅停止等待，不会取消仍运行的上传，成功后也未 clearTimeout。建议失败返回可重试状态，让客户端重传原片；成功必须以存储确认落盘为条件；实现取消与 finally 清理定时器，并防止超时任务晚到覆盖新状态。

**F06 · 重命名的提交顺序可能使文件失联。**

位置：[删除 R2 源对象](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/api/manage/rename/[[path]].js:132)、[写新元数据](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/api/manage/rename/[[path]].js:170)。顺序为复制对象→删除旧对象→写新元数据。复现注入元数据失败后，旧元数据仍在、旧字节已删除、新对象存在但没有新元数据，业务无法正常访问。S3/WebDAV 移动辅助函数也在元数据提交之前处理源对象。

建议与已经改进的 move 路径统一为同一迁移服务：保留源数据，先保证目标对象与元数据可恢复，持久化索引/别名变更后再清理源，并处理目标存储对象冲突。返回状态应清楚区分完成与待恢复。不要将此问题表述为全部字节已永久丢失，复现中新对象仍可人工恢复。

**F07 · D1 settings 分页不完整，影响撤销、导出和 GC。**

位置：[listSettings()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/d1Database.js:176)、[批量撤销会话](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/auth/sessionManager.js:158)。适配器只执行 LIMIT，不处理 cursor，也不返回 list_complete。消费者按 KV 游标遍历会在第一页停止。复现 1001 个有效管理员会话，仅撤销 1000 个，剩余 1 个未处理。设置导出、索引旧 generation 清理同样依赖这一接口。

建议补齐按 key 的稳定游标分页，或对 SQL 路径直接执行匹配删除；至少测试超过 1000 条、不同 authType 混合、第一页没有目标项等边界。

**F08 · sharp 的线程参数不能限制请求内存。**

位置：[imageProcessor](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/deploy/server/imageProcessor.js:18)。`sharp.concurrency(1)` 限制的是每张图的 libvips 线程数；`sharp.cache({memory:32})` 限制操作缓存，均不是进程内存或请求总量的上限。[sharp 官方说明](https://sharp.pixelplumbing.com/api-utility/)

所有请求都会先完整读取最多 20 MiB 输入，再进入解码/编码。复现 8 个调用同时进入输入读取，证明没有请求级入口限制；该复现使用 SVG 分支验证公共读取入口，没有测量真实 JPEG 解码并发。建议在读取输入之前获取任务槽位，限制等待队列并支持取消；按压缩输入、解码像素、输出和动画帧数共同设预算。保持现有单文件字节/像素限制。

**F09 · R2 容量校验把全桶扫描放在每个上传请求内。**

位置：[reserveR2()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/r2Capacity.js:31)。每次预留都列举所有对象，CAS 冲突后重新扫描。复现 3000 对象、3 次无竞争预留产生 9 次 list。Node LocalR2 的每一页 list 又会同步遍历整个目录并排序，因此本地模式额外放大开销。随着文件和备份 manifest 增多，上传开始前的等待也增长。

建议使用可信的已用容量计数与原子预留，上传/删除进行增量更新，后台分批对账并保留安全余量。不能直接用未经校准的短期缓存替代容量保护。验收并发完成/释放、外部写入、失败 multipart 回收及阈值附近的行为。

**F10 · 重命名成功会让现有公开链接失效。**

位置：[重命名收尾](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/api/manage/rename/[[path]].js:170)。该路径未调用 `relocatePublicFile`。复现中 rename 返回 200，新记录存在，但旧公开别名仍解析到 old.jpg，而该记录已删除。建议复用 move 的别名迁移和索引确认逻辑；测试连续重命名、改回原名、别名缓存与失败恢复。

**F11 · D1 不实现 expirationTtl。**

位置：[D1 put 分派](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/d1Database.js:318)。KV 的 expirationTtl 参数被接收但未持久化或执行。分片、multipart、上传会话在失败或浏览器关闭后可能长期留在 files 表，认证会话也会留在 settings 表。复现 1 秒 TTL 的上传会话，等待 1.1 秒后仍可读。认证会话另有 expiresAt 检查，因此本条不意味着过期登录仍有效。

建议增加 expires_at 与有索引的分批 GC，读取时遵守过期语义；上传临时状态最好独立表，避免混入真实文件与索引扫描。清理顺序还需同步中止废弃 multipart。

**F12 · 无效公开链接会重复扫描全部文件。**

位置：[resolvePublicFile()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/publicFileId.js:31)。当一个符合格式的 p_ ID 没有映射时，加载整个索引并逐个 await SHA-256。没有查询负缓存或迁移完成标记。复现相同不存在 ID 的 3 次查询，回调加载全表 3 次，并执行 300 次候选哈希（样本 100 个文件）。

建议先完成旧数据别名的后台回填，使未知 ID 的正常读取可直接返回 404；迁移期的兜底需限制预算与并发。仅给相同 ID 加负缓存无法解决不断变化的无效 ID。

**F13 · 上传请求体存在重复解析和多份缓冲。**

位置：[中间件分片解析](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/upload/_middleware.js:103)、[handler 解析](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/upload/chunkUpload.js:95)、[容量估算](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/storageTiering.js:52)。分片先 clone().formData()，下游再 formData() 和 file.arrayBuffer()。16 MiB 限制在上游解析完成后才检查；无 Content-Length 的普通自动上传也会为估算大小先解析 clone，再由 handler 重读。WebDAV PUT 则先 blob，再封装 multipart 转发，仍走普通上传全量解析。

建议单次解析后通过显式上下文传递；适用的存储路径流式写入；在读取阶段实际计数字节并截断，不能只信任 Content-Length。这里不声称固定内存倍率，具体 clone/Blob 复制取决于运行时。

**F14 · 分片合并重复串行读取，远程数据库延迟相加。**

位置：[第一次状态检查](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/upload/chunkMerge.js:59)、[第二与第三次检查](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/upload/chunkMerge.js:178)、[串行查询](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/upload/chunkUpload.js:1039)。成功路径也会检查三遍，之后再逐条删除临时状态。RemoteD1 每次调用是一次 HTTP 往返。

例如 N=64、每次往返假设 50 ms，仅 3N 次检查和 N 次删除就约 12.8 秒；这是模型估算，不是实测线上延迟。建议复用第一次状态结果，只复查重试项；为 SQL 增加批量查询/删除，为 KV 使用有界并发。必要的落盘确认应保留。

**F15 · 上传后即时备份可无界叠加。**

位置：[enqueueTelegramBackup()](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/telegramBackup.js:76)、[视频预览读取](/E:/Desktop/my_project/imghub/CloudFlare-ImgBed/functions/utils/telegramBackup.js:165)。每个成功上传独立 waitUntil 启动一个任务。job lease 只防止同一个文件重复处理，Node 的 backupRunning 也只保护定时器，不覆盖这些即时任务。多个文件仍可并行执行；视频预览允许整段读取至 50 MiB，额外叠加上传和 FormData 内存。

建议上传只持久化任务后应答，用共享的有界消费者处理；即时处理也必须走同一预算。视频预览与文档备份分开计量或排队。验收并发上传多个接近阈值的视频，确保前台响应不被后台吞吐拖垮；测试租约和失败恢复仍然有效。

**次级优化与需保留的现有保障**

- Node 路由在每次请求中反复同步 exists/stat 并寻找中间件，声明的 middlewareCache 未使用；可以启动时构建路由表，避免按任意完整路径建立无界缓存。
- 上传链重复读取安全/渠道/遥测配置，可先做请求内复用；鉴权配置不要直接使用无失效机制的全局缓存。
- 若改为 SQL 标签查询，需先修复 D1 putFile 未维护 tags 列的问题；当前查询依赖 metadata.Tags，因此这是改造前置条件，不是当前所有标签都不可用。
- Node caches 为 no-op，随机图/公开图库每次都会回到索引。随机列表还把 expirationTtl 当作 cache.put 的第三个参数；Cloudflare Cache API 的过期应通过响应缓存头控制，不能依赖这一参数。[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- 部分上游 fetch 没有明确超时；S3 HEAD 分支先发 GetObject 再丢弃 body、多个失败重试分支没有主动 cancel 响应体。建议统一上游请求的超时、取消和响应体释放策略，随后做真实连接数测试。
- state-gateway 的数据库备份虽然已有事务一致性，但一次性 SELECT 所有表再 JSON 序列化，数据量大时需另设计有一致性保障的导出流程，不能简单分页后宣称同一快照。
- 现有 R2/HF/多数 WebDAV 正常下载会转发 body；备份恢复流已使用 pull/cancel；容量条件写、备份 lease、主索引 generation/CAS、失败移动保留源数据等都值得保留。优化时不要为了减少等待破坏这些一致性保障。

**建议执行顺序与验收**

1. 先处理 F01/F02 的流和内存，以及 F04/F05/F06/F07 的失败一致性；为各入口增加对应回归测试。
2. 再处理 F03/F09/F13/F14：减少全量工作、重复解析和网络往返，同时修正 F10/F11/F12。
3. 最后统一 F08/F15 的任务并发预算，并验证配置/缓存失效和连接释放。

验收至少包括：慢客户端与取消下载；10 万条元数据下单页查询；并发分片上传与超时重试；缩略图和备份同时运行；进程中断后的恢复；D1 与 KV 两类适配。Node 记录 RSS、heapUsed、external、arrayBuffers、事件循环延迟和在途任务数；Worker 记录 CPU、资源超限、每请求数据库/R2 调用数。没有这些数据前，不给出“性能提升多少倍”或“内存问题已解决”的结论。
