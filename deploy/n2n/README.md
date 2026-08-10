# WEL n2n 部署

WEL 客户端统一连接 n2n supernode 的 UDP `22222`。阿里云安全组和服务器防火墙都必须放行该 UDP 端口。

`supernode` 必须使用与 Windows `edge.exe` 相同的官方 n2n 3.0 源码构建。安装到 `/usr/local/bin/supernode` 后：

```bash
sudo cp weln2n.env.example /etc/weln2n.env
sudo cp systemd/weln2n-supernode.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now weln2n-supernode
sudo systemctl status weln2n-supernode
```

检查监听：

```bash
sudo ss -lunp | grep 22222
```

所有房间共用同一个 supernode 端口，房间隔离由客户端使用的 n2n `community` 与平台分配的虚拟 IP 完成。当前客户端默认 community 为 `wel-room-<房间ID>`。
