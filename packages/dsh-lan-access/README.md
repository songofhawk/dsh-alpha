# dsh-lan-access

A DSH Web profile bundle for access from devices on a trusted local network.
It binds the Web server to `0.0.0.0`, preserves the configured Web port, and
injects a `crypto.randomUUID()` compatibility shim for HTTP LAN origins so
client RPCs such as workspace listing and creation continue to work.

The bundle uses DSH's profile composition mechanism. It does not modify the DSH
installation or files under `node_modules`.

## Install from this repository

```bash
dsh plugin --profile web add -w ./packages/dsh-lan-access
dsh web --no-open
```

## Security boundary

This exposes a DSH instance with local file and command capabilities to the
network. Use it only on a trusted LAN or controlled VPN, restrict sources with
a host firewall, and never forward the port directly to the public Internet.

The shim only restores UUID generation. Plain LAN HTTP remains an insecure
browser context, so APIs that require HTTPS remain unavailable.
