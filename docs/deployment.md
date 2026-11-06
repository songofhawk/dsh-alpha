# dsh-alpha 自动部署

本项目的生产包不是直接在服务器上执行 `git pull`，而是由 GitHub Actions 在 `main` 推送后打包当前 commit，通过 SSH 上传到目标服务器，再刷新服务器上的本地 `file:` 依赖并重启已配置的 systemd 服务。

## GitHub Secrets

当前 workflow 的 `tt_hk` 目标需要配置以下仓库 Secrets：

- `TT_HK_DEPLOY_HOST`：服务器地址
- `TT_HK_DEPLOY_USER`：SSH 用户
- `TT_HK_DEPLOY_SSH_KEY`：部署私钥内容
- `TT_HK_DEPLOY_KNOWN_HOSTS`：固定的 SSH 主机指纹，不能留空

私钥和主机指纹只存在于 GitHub Secrets，不写入仓库。新增服务器时，在 `.github/workflows/deploy.yml` 的 matrix 中增加一项，并为该项配置对应 Secrets。

## 当前 tt_hk 目标

workflow 会更新：

- `/root/.dsh/profiles/web` 中的 dsh-alpha master 包
- `/opt/dsh-alpha-worker` 中的 worker 包
- 在重启 `dsh-alpha-master.service` 前等待持久化中的 Alpha 任务结束（默认最多 15 分钟）；超时或任务存储不可读会拒绝重启，避免中断受控任务
- 在主控任务排空并重启后，重启已启用的 `dsh-alpha-worker.service`
- 检查 `http://127.0.0.1:3080/` 返回 200；启用新版 DSH 浏览器会话鉴权时，未带令牌返回 401 也表示服务已就绪

`dsh-alpha-worker.service` 已在 tt_hk 上启用，workflow 会在更新 worker 包后重启它。

主控的 Jev 路由从 `/etc/dsh-alpha/master.env` 读取 `TYPESAFE_API_KEY` 和
`DSH_ALPHA_JEV_ROUTING=1`。这两个值只属于主控进程，不在仓库或发布包中；
仅推送代码或更新本地 `.env` 不会启用线上 Jev。更新环境文件后，应等 Alpha
任务排空，再重启 `dsh-alpha-master.service`，并通过真实新会话检查 Jev 路由记录。

## 账号密码登录

账号登录要求 Web profile 使用 DSH `0.2.1-rc.5` 或更新版本提供浏览器会话鉴权接口。
仓库当前锁定的 `0.1.0-rc.8` 用于原有插件回归测试；旧版启用账号配置会报告升级错误，
不要在旧版上移除公网入口保护。当前仅支持一个管理员账号，各设备共享控制平面，没有注册入口。

以运行主控的同一系统用户，在服务器交互终端运行：

```bash
cd ~/.dsh/profiles/web
./node_modules/.bin/dsh-alpha login-setup
```

密码输入不回显，不经命令行参数传递。默认将用户名和 scrypt 密码哈希写入
`~/.dsh/storages/dsh-alpha/login.json`，文件权限为 `0600`，不保存明文密码。
主控使用自定义 `DSH_HOME`、`DSH_ALPHA_DATA_DIR` 或 `DSH_ALPHA_LOGIN_FILE` 时，
设置命令必须使用相同环境。`DSH_ALPHA_LOGIN_FILE` 可指定账号文件。
重置密码使用同一命令，重启主控后旧账号的全部会话失效。

Tunnel / HTTPS 反向代理后，主控进程还需配置公网 Origin，例如 M1：

```bash
DSH_ALPHA_LOGIN_ORIGIN=https://dsh-m1.showme.talk
```

Origin 必须为 HTTPS，不带路径和末尾斜杠。DSH 的 `trustedHosts` 须包含对应域名，
主控仍监听回环地址。不读取 `X-Forwarded-*` 头决定登录来源。未配置 Origin 时，
仅原生 HTTPS 或本机回环 HTTP 可使用账号登录。

等待主控任务排空，再重启对应服务。浏览器访问 `/` 会进入 `/login`，成功后返回
主界面；侧栏底部提供「退出登录」。会话保留七天，可跨主控重启，保存在数据目录的
`login-sessions.sqlite3`，数据库只存随机令牌的 SHA-256 摘要。退出会撤销当前会话，
同时断开该会话的 WebSocket。错误统一提示；15 分钟内每个连接来源最多尝试 10 次、
全局最多 50 次，Tunnel 后多台设备可能共享来源限额。

未配置账号文件时保留 DSH 原有启动 token / Cookie 登录，作为本机恢复入口。
它与 Alpha 账号会话相互独立，「退出登录」只撤销 Alpha 账号会话。

## 移除 Cloudflare Access 登录，保留域名

插件不再信任 `Cf-Access-Jwt-Assertion`，`DSH_ALPHA_CF_ACCESS_ISSUER` 和
`DSH_ALPHA_CF_ACCESS_AUD` 已不使用，可从目标主控的环境配置移除。
代码更新不会修改 Cloudflare 的 Access、DNS 或 Tunnel 配置。

切换顺序（仅操作目标域名，例如 `dsh-m1.showme.talk`，不要影响其他部署）：

1. 保留现有 DNS 记录、Tunnel 的 Public Hostname 和指向本机 Web 端口的服务映射。
2. 检查目标主控的 DSH 版本，部署插件、设置账号和 Origin，在服务器本机用对应的
   Host / Origin 先验证 `/login`、登录后 API 和 WebSocket。
3. 在 Cloudflare Zero Trust → Access → Applications 中，仅删除或禁用保护目标
   域名的 Access 应用。若应用还保护其他域名，先拆分并保留其他域名的策略。
   不要删除 Tunnel、Public Hostname 或 DNS 记录。
4. 无痕浏览器访问目标域名，应进入 Alpha 登录页，不再跳转到 `cloudflareaccess.com`。
   验证登录、刷新、退出及退出后 API 返回 401。

Cloudflare 边缘登录成功不代表 DSH 已接受浏览器凭据。旧接入只覆盖
`requestRejection` / `authorizeIndex`，新版 DSH 的 API 与 WebSocket 改走
`admit` / `admitConnection` 后仍可能返回 401。新登录接入共同的浏览器凭据验证器，
保留 DSH 自身的 Host / Origin 校验。

## 本地手工部署

GitHub Actions 使用的脚本也可以在本地运行：

```bash
DEPLOY_TARGET_HOST=<host> \
DEPLOY_TARGET_USER=<user> \
DEPLOY_SSH_KEY_FILE=<local-key-file> \
DEPLOY_SSH_KNOWN_HOSTS_FILE=<known-hosts-file> \
DEPLOY_MASTER_PROFILE=/root/.dsh/profiles/web \
DEPLOY_MASTER_SERVICE=dsh-alpha-master.service \
DEPLOY_WORKER_ROOT=/opt/dsh-alpha-worker \
node scripts/deploy-remote.mjs
```

脚本会校验上传包 SHA256、校验远端实际安装源码包含当前 RPC 修复、重启服务并等待健康检查。部署过程使用 commit 专属包名，避免同版本号的旧 tarball 被包管理器错误复用。

默认读取 `/root/.dsh/storages/dsh-alpha/tasks.sqlite3`。如主控使用了自定义 `DSH_ALPHA_DATA_DIR`，部署环境也必须设置对应的 `DEPLOY_TASK_STORE`；可用 `DEPLOY_DRAIN_TIMEOUT_SECONDS` 调整等待上限。旧版 `tasks.json` 会在首次启动时自动迁移并保留备份。
