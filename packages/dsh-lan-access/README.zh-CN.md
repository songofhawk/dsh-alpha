# dsh-lan-access

面向可信局域网的 DSH Web profile bundle。安装后会：

- 将 DSH Web 从 `127.0.0.1` 改为监听 `0.0.0.0`；
- 保留 `dsh web --port <端口>`，默认端口仍为 `3080`；
- 为局域网 HTTP 页面补充 `crypto.randomUUID()`，恢复工作区加载、新建工作区和其他依赖客户端 RPC ID 的功能；
- 复用 DSH 在全接口监听时自动生成的局域网可信 Host 列表。

它是独立的用户 profile 扩展，不修改 DSH 安装包或 `node_modules`。

## 安装

在本仓库中本地安装：

```bash
dsh plugin --profile web add -w ./packages/dsh-lan-access
```

安装后重启：

```bash
dsh web --no-open
```

DSH 会打印本机和局域网访问地址，例如：

```text
dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.8:3080)
```

## 验收

```bash
lsof -nP -iTCP:3080 -sTCP:LISTEN
curl -I http://127.0.0.1:3080/
curl -I http://<局域网 IP>:3080/
```

浏览器还应能够加载工作区列表并打开“添加工作区”目录选择器。

## 安全边界

该 bundle 会把具备本机文件与命令能力的 DSH Web 暴露给所在网络。只应在可信局域网或受控 VPN 中使用，并通过主机防火墙限制来源；不要把端口直接映射到公网。

兼容层只补充 UUID 生成。局域网 `http://` 仍不是浏览器安全上下文，剪贴板、摄像头、麦克风及其他要求 HTTPS 的 API 不会因此获得权限。需要完整浏览器能力时，应使用设备信任证书的 HTTPS。

卸载后，DSH Web 将恢复 profile 中其他配置决定的监听方式：

```bash
dsh plugin --profile web remove dsh-lan-access
```
