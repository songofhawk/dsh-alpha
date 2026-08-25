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
- 重启 `dsh-alpha-master.service`
- 检查 `http://127.0.0.1:3080/` 返回 200

`dsh-alpha-worker.service` 当前在 tt_hk 上是停用状态，因此 workflow 不会擅自启用或重启它；需要启用 worker 时，再把该目标的 `worker_service` 配置为对应 systemd unit。

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
