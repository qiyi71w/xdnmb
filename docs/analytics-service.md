# 使用统计服务

汐岛的自愿使用统计由仓库中的独立服务 `server/analytics/` 接收，作者用它的私人网页看板查看参与统计的安装实例规模、日活与版本／平台分布。服务是单独部署的 Node.js 进程，不随桌面应用启动，也不经手论坛、图片、搜索或订阅请求。本文是它的公开协议、统计口径与运维说明。

服务统计的是**参与统计的安装实例**：随机标识不能证明一个自然人，公开协议也不能完全防伪造。看板上的数字不是用户人数。

## 客户端协议 v1

协议常量与类型在 `src/shared/analytics-protocol.ts`，客户端与服务共用。所有请求均为 `POST`，`Content-Type: application/json`，请求体不超过 1024 字节，字段必须恰好是下表所列（多一个、少一个都拒绝）。标识与凭证只放在请求体里，不放在 URL 或请求头。

| 路径 | 请求体 | 成功 |
| --- | --- | --- |
| `/v1/instances` | `{"protocol":1}` | `201 {"instanceId","token"}` |
| `/v1/activity` | `{"protocol":1,"instanceId","token","version","platform"}` | `200 {"statDay","duplicate"}` |
| `/v1/deletion` | `{"protocol":1,"instanceId","token"}` | `200 {"deleted":true}` |

- `instanceId`：服务生成的 16 字节随机数（base64url，22 字符），只用于区分实例，不构成授权。
- `token`：服务生成的 32 字节随机数（base64url，43 字符），只授权对自己这个实例的上报与删除。服务端只保存它的 SHA-256，丢失后无法找回。
- `version`：汐岛实际运行版本，`主.次.修订`，可带不超过 24 字符的预发布后缀，如 `1.1.0-beta.1`。
- `platform`：`windows` 或 `macos`。
- 不接受日期、架构、地区、时长或任何论坛身份字段。统计日由服务器时钟按北京时间决定，客户端不能指定或补报历史日期。

失败响应为 `{"error":"<code>"}`：

| 状态 | `error` | 含义与客户端处理 |
| --- | --- | --- |
| 400 | `invalid_request` | 字段、类型或格式不符；不要原样重试 |
| 400 | `unsupported_protocol` | `protocol` 不是 1 |
| 403 | `invalid_credentials` | 标识不存在，或凭证不属于该标识 |
| 413 | `payload_too_large` | 请求体超过 1024 字节 |
| 415 | `unsupported_media_type` | 不是 JSON |
| 429 | `rate_limited` | 服务繁忙；`Retry-After` 秒数之前不要再发 |
| 503 | `capacity_exhausted` | 已登记实例达到上限，暂不接受新登记 |
| 404／405 | `not_found`／`method_not_allowed` | 路径或方法不对 |
| 500 | `server_error` | 服务内部失败，本次请求没有生效 |

### 顺序与幂等

1. **登记**只在用户明确开启统计后进行。登记本身不算活跃；一直没有上报的登记会在 31 个统计日后清除。客户端应先把 `instanceId` 与 `token` 安全保存，再发第一次活跃上报；登记响应丢失时重新登记即可，遗留的空登记不会被计数。
2. **活跃上报**表示当天有一次合格的前台使用。同一实例同一统计日重复上报只计一次，返回 `duplicate: true`，版本与平台更新为这次的值。客户端以响应中的 `statDay` 记录“这一统计日已成功上报”，同一 `statDay` 内不再上报。
3. 活跃上报**不会**为未知标识自动登记。收到 `403 invalid_credentials` 说明这个身份已不在服务端（已删除，或连续 31 个统计日没有活动而被清除）。只有在统计仍处于开启、且没有未完成的删除时，客户端才可以丢弃旧身份并重新登记。
4. **删除**清除仍与该实例关联的全部记录。`200` 表示服务端已没有与这组凭证关联的记录；凭证本来就不存在（已删除或已过期）时同样返回 `200`，所以重复删除是安全的。凭证属于另一个标识时返回 `403`，不会删除任何内容。删除前客户端应先停止上报；网络失败、`429` 或 `5xx` 表示删除未完成，保留凭证供用户重试。
5. 删除与晚到的上报在服务端串行执行：删除完成后到达的上报得到 `403`，不会重新建立这个实例。

### 请求节奏

服务端限流是全进程的令牌桶，不按 IP 或客户端特征区分：登记每分钟约 20 次（突发 20），上报与删除合计每分钟约 300 次（突发 300）。正常客户端每个统计日只需一次成功上报。失败后不要立即循环重试：遵守 `Retry-After`，其他失败按客户端自己的退避与次数上限处理，不建立离线补报队列。服务端单个请求最长 15 秒，建议客户端超时不长于此。

汐岛桌面客户端的实现：单次在途、10 秒超时、自动尝试至少间隔 60 秒，无响应或 5xx 依次等待 5 分钟／30 分钟／2 小时，`429` 遵守 `Retry-After`，每个统计日每次运行最多 6 个自动请求；同意、前台判定与删除流程见[开发说明](development.md#使用统计客户端)，面向用户的说明见 README 的“数据与隐私”。

## 统计口径

- **统计日**：北京时间（UTC+8）自然日，以服务器收到上报的时间计。
- **今日活跃实例**：今天至少有一次成功上报的不同实例数，今天结束前持续变化。
- **近 30 天活跃实例**：今天及前 29 个统计日内至少上报过一次的不同实例数。
- **版本／平台分布**：每个实例归入它在该时段内最后一次成功上报的版本与平台；实例升级只换桶，不重复计入总数。
- **日活趋势**：每个统计日的活跃实例数。服务当天没有运行的日期显示为“无数据”，不当作 0；服务在运行但没有上报的日期才是 0。

## 保留与删除

| 数据 | 内容 | 保留 |
| --- | --- | --- |
| 实例 | `instanceId`、凭证的 SHA-256、最近一次活动（或登记）所在统计日 | 最近活动日起共 31 个统计日；持续活跃的实例保持同一身份 |
| 逐日活动 | 统计日、实例、该日最后上报的版本与平台 | 当天及前 30 个统计日，共 31 个统计日 |
| 日汇总 | 统计日、当日活跃实例数及当日版本／平台分桶计数，不含任何实例标识 | 当天及前 12 个月的同一日期（月末按目标月份天数截断） |

- 一个统计日的逐日活动过期时，同一事务先把当日活跃数与版本／平台分桶冻结进日汇总，再删除明细。仍有明细的日期总是从明细现算，所以删除一个实例会立即反映到这些日期；已冻结的更早日汇总不再含实例信息，不会因删除而扣减。
- 超过 31 个统计日没有活动的身份即使尚未被清理删除，也不能再上报，因此清理暂时失败也不会让它续期。
- 不保存首次登记日期、历史凭证或逐次上报日志。
- 删除、过期清理与汇总冻结都在单个 `BEGIN IMMEDIATE` 事务中完成，失败整体回滚，可重复执行。数据库使用 WAL、`synchronous=FULL`（已确认的删除在断电后仍有效）和 `secure_delete=ON`，删除与清理后执行 WAL 检查点，被删除的内容不留在空闲页或 WAL 中。
- 服务启动时先应用保留规则再开始监听，运行中每分钟检查一次统计日变化，日期变化时立即清理。

## 运行与配置

需要 Node.js 24（与仓库 `.nvmrc` 一致）。服务直接运行 TypeScript 源码，没有构建步骤和运行时依赖（HTTP、SQLite 与密码学均使用 Node 内置模块），部署时只需要仓库中的 `server/analytics/` 与 `src/shared/analytics-protocol.ts`。

```bash
# 生成看板密码哈希（从标准输入读取，至少 12 个字符；不要把密码写进命令行历史）
node server/analytics/main.ts hash-password < password.txt

node server/analytics/main.ts serve            # 先清理，再提供接口与看板
node server/analytics/main.ts cleanup          # 只执行一次保留清理
node server/analytics/main.ts backup <文件>    # 导出无实例标识的日汇总与分桶
node server/analytics/main.ts restore <文件>   # 用备份新建数据库并清理
```

开发时可用 `npm run analytics -- serve`。环境变量：

| 变量 | 说明 |
| --- | --- |
| `XIDAO_ANALYTICS_DB` | 数据库文件路径（`hash-password` 以外的命令必需） |
| `XIDAO_ANALYTICS_ADMIN_PASSWORD_HASH` | `hash-password` 的输出（`serve` 必需，缺少时拒绝启动） |
| `XIDAO_ANALYTICS_ADMIN_USER` | 看板用户名，默认 `admin` |
| `XIDAO_ANALYTICS_HOST`／`XIDAO_ANALYTICS_PORT` | 监听地址与端口，默认 `127.0.0.1:8787` |
| `XIDAO_ANALYTICS_MAX_INSTANCES` | 已登记实例上限，默认 100000 |

同一数据库只运行一个 `serve` 进程。配置放在仅 root 可读（`0600`）的环境文件中。正式部署用官方 `node:24` 镜像运行（主机不需要安装 Node）：应用文件只读挂载，数据目录归一个不对应任何主机账户的专用 uid，只在本机回环地址发布端口：

```bash
docker run -d --name xidao-analytics --restart unless-stopped \
  --user 64787:64787 --read-only --tmpfs /tmp:size=8m --cap-drop ALL \
  --security-opt no-new-privileges --memory 256m --pids-limit 64 \
  --log-driver json-file --log-opt max-size=1m --log-opt max-file=3 \
  --env-file /opt/xidao-analytics/analytics.env \
  -v /opt/xidao-analytics/app:/app:ro -v /opt/xidao-analytics/data:/data \
  -p 127.0.0.1:18787:8787 -w /app node:24-bookworm-slim \
  node --disable-warning=ExperimentalWarning server/analytics/main.ts serve
```

其中 `app/` 是仓库中的 `server/analytics/` 与 `src/shared/analytics-protocol.ts`（保持相对路径），环境文件设置 `XIDAO_ANALYTICS_DB=/data/analytics.sqlite`、`XIDAO_ANALYTICS_HOST=0.0.0.0`（容器内）与密码哈希。数据目录权限 `0700`。`cleanup`／`backup`／`restore` 用同一镜像、同一挂载以 `docker run --rm` 执行；不要和 `serve` 同时指向同一个库做 `restore`。镜像建议按 digest 固定，升级 Node 时再更新。

对外由现有反向代理终止 HTTPS，只转发 `/v1/` 与 `/admin` 到本机监听地址，其余路径返回 404。服务不读取 `X-Forwarded-For` 等来源头，也不按 IP 做任何判断，所以代理不必添加这些头。统计请求在请求体里带有标识与凭证，代理常用的访问日志格式会记录来源 IP，因此要在这个站点关闭访问日志与错误日志（nginx 中站点级 `access_log` 会覆盖上层继承的所有 `access_log`，包括写到标准输出的那一条）：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name stats.example.com;
    access_log off;
    error_log /dev/null;
    # ssl_certificate / ssl_certificate_key / ssl_protocols TLSv1.3 TLSv1.2 ...
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 4k;
    location /v1/  { proxy_pass http://127.0.0.1:18787; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header Connection ""; proxy_redirect off; }
    location /admin { proxy_pass http://127.0.0.1:18787; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header Connection ""; proxy_redirect off; }
    location / { return 404; }
}
```

80 端口的同名站点只提供 ACME 验证路径，其余请求 301 到 HTTPS，同样关闭两种日志。桌面客户端只使用 HTTPS 来源且不跟随重定向，所以这个 301 不会让请求体改走明文。

## 私人看板与认证

看板位于 `/admin/`，数据接口为 `/admin/api/summary`。所有 `/admin` 路径（包括不存在的路径）都先经过单管理员 HTTP Basic 认证：服务端只保存密码的 scrypt 哈希（Node 内置实现），认证通过后 10 分钟内复用校验结果。上报凭证不能访问看板。失败的登录尝试全进程限流（突发 10 次，之后约每 12 秒 1 次），已通过认证的会话不受影响。Basic 认证必须经 HTTPS 传输；反向代理需原样转发 `Authorization` 请求头，不应另设绕过认证的路径。浏览器会记住凭证直至关闭，看板没有“退出登录”。

看板展示今日与近 30 天活跃实例、两个时段的版本／平台分布（数量与占比），以及可选近 30 天、近 90 天或全部保留数据的日活趋势表。读取失败时保留上次成功读取的数据并标明读取时间，不显示为 0；页面只从本服务加载脚本与样式。

## 备份与恢复

`backup` 只导出已结束统计日的无实例标识日汇总及其版本／平台分桶（JSON，文件权限 `0600`），不包含任何实例、凭证或逐日活动；恢复时会校验每天各分桶之和等于当日活跃数。因此恢复备份不可能让已删除的实例重新出现。

`restore` 拒绝覆盖已有数据库文件：先把损坏或旧的数据库移走，再恢复到新路径，恢复后立即应用保留清理，超过 12 个月的汇总不会被导入保留。恢复后的影响：

- 原有实例身份都不再存在，客户端会收到 `403` 并在仍开启统计时重新登记；
- 恢复的日期在看板上标为“日汇总”，近 30 天活跃实例数不含这些日期，页面会注明天数，30 天后完全恢复；
- 恢复当天的活跃数只包含恢复之后的上报。

不要把数据库文件本身纳入超过 31 天的主机快照或文件备份，否则这些备份会把已删除或已过期的实例记录保留得更久。

## 日志

服务只向标准输出写一行一个 JSON 的运维事件：`listening`（监听地址与端口）、`retention_applied`（清理时间与各类删除行数）、`backup_written`／`restored`（天数）、`stopped`，以及 `failure`（失败区域、错误类名与错误码）。日志不包含请求体、请求头、实例标识、凭证、来源 IP 或客户端信息；错误也只记录类名，不记录可能带有请求内容的错误消息。正常请求不产生日志。

这只约束应用自身。反向代理的访问日志、云平台的流日志与主机日志需要在部署时单独核对并关闭或去除标识与来源 IP；网络层在连接时仍能看到来源 IP。

## 正式部署

汐岛正式版本的统计来源是 `https://xidao-stats.qiyi71w.com`（写在仓库的 `.env.production` 中）。以下是部署时核对过的事实：

- 服务器：作者的甲骨文云实例，加拿大多伦多区域（`ca-toronto-1`），ARM64 Ubuntu。服务按上文以 Docker 容器运行，随 Docker 开机自启；现有的 OpenResty 反向代理在同一台主机上终止 HTTPS。
- 网络链路：DNS 记录不经 CDN 代理，客户端直接与这台主机建立 TLS，中间没有其他会解密请求的代理。证书由 Let's Encrypt 签发，certbot 用 webroot 方式自动续期，续期钩子安装证书并重载代理；已用 `certbot renew --dry-run` 验证续期流程。只接受 TLS 1.2 与 1.3。
- 日志：统计站点的访问日志与错误日志都已关闭，成功的统计、删除与看板请求在代理的访问日志、错误日志和容器标准输出中都没有记录。例外：TLS 握手在选定站点之前就失败的连接（例如客户端只支持旧版 TLS）由代理的默认站点记录一行，含来源 IP 与握手字节，但没有主机名、路径或请求内容。这份共享日志不由本服务管理。服务容器本身只写运维事件，日志按 1 MiB × 3 份轮转。
- 数据与备份：数据库只在容器挂载的数据目录里。主机没有面板备份任务，云平台未启用引导卷备份策略，也没有其他文件备份覆盖这个目录。
- 保留：清理在服务进程内完成，启动时先清理再监听，运行中每分钟检查一次统计日变化，所以不需要另配定时任务；服务停止期间不清理，重新启动时立即补做。
- 云平台：主机上的 OCI 日志代理没有配置任何采集源，不向云端发送主机日志；主机自己的系统日志只有账户登录和其他服务的记录，不含统计内容。VCN 流日志（会保留连接的来源 IP 与端口元数据）是否启用只能在云控制台查看，部署时**尚未核对**。

部署后的统计数据从清空的数据库开始：验收用的隔离身份在验收结束后与数据库文件一起删除。

## 验证范围

`tests/analytics-service.test.ts` 用真实本地 HTTP、临时 SQLite 文件和受控时钟覆盖：同日重复与并发上报、北京时间零点、第 30／31 日窗口、最后上报归属、登记不计数、他人凭证拒绝、重复删除、删除与上报并发、事务中断回滚与重启后重试、31 日与 12 个月清理、清理失败后重试、备份只含日汇总、字段白名单与大小限制、限流与容量、看板全路径认证，以及日志中不出现合成敏感标记、标识、凭证与地址。

另在 Linux 上以 Node 24 实际运行服务进程，验证了：两个隔离实例上报到浏览器看板；删除、重启和停止服务后的看板状态；`SIGKILL` 中断并发上报和删除后重启的数据一致性；`backup`／`restore`／`cleanup` 命令；以及真实日志采样。这些都是本机受控演练，不代表正式域名、TLS、反向代理、云平台日志或主机备份已经通过核对。

正式部署（上文“正式部署”）另在实际主机上验证了：TLS 证书、协议版本与 HSTS；未认证访问 `/admin`、`/admin/`、`/admin/api/summary`、不存在的 `/admin` 子路径及 `../` 构造的路径都返回 `401`，大小写变体、编码与双斜杠变体返回 `404`，没有绕过认证的路径；上报凭证（作为 Bearer 或 Basic 提交）不能读取看板；两个隔离身份经公网 HTTPS 登记、上报、同日去重、跨实例凭证 `403`、多余字段 `400`、删除与重复删除、删除后上报 `403`，看板计数随之变化；容器重启后已删除身份仍被拒绝、有效身份保留；真实的 Windows 客户端经公网走完开启、上报、浏览器看板、关闭与删除的完整链路（见[开发说明](development.md#使用统计客户端)）；删除后数据库、WAL 与共享内存文件中没有已删除实例的标识，也没有凭证明文；代理与容器日志采样中没有统计请求、标识或凭证。保留规则在同一主机上用相同镜像和应用文件、隔离数据库与偏移时钟演练：40 天前上报的实例在按真实时间启动时被清理并冻结为日汇总，已自删的实例不计入也不复活，10 天前的实例保留；重启后结论不变；`backup`／`restore` 恢复出的库没有任何实例。
