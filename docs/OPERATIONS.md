# WEL 职业联盟对战平台运维手册

本文用于 Ubuntu 服务器异常时的检查、重启和恢复。命令默认需要 `sudo` 权限。

## 1. 服务组成

当前服务分为两部分：

1. Docker 中运行的平台业务服务，例如 Laravel、Go API、数据库等。
2. Ubuntu systemd 管理的 OpenVPN 房间服务：

   ```text
   welopenvpn@1.service
   welopenvpn@2.service
   welopenvpn@3.service
   welopenvpn@4.service
   welopenvpn@5.service
   welopenvpn@6.service
   ```

OpenVPN 服务端配置目录：

```text
/etc/welopenvpn/
```

服务器公网地址当前为：

```text
8.133.189.9
```

## 2. 先做无损检查

查看系统资源：

```bash
free -h
df -h
uptime
```

查看 Docker 容器：

```bash
docker ps
docker ps -a
docker stats --no-stream
```

查看 OpenVPN 服务：

```bash
sudo systemctl status 'welopenvpn@*' --no-pager
```

查看监听端口：

```bash
sudo ss -lunp | grep -E '1200[1-6]'
sudo ss -ltnp | grep -E '8082|80|443'
```

查看 TAP 接口：

```bash
ip -br addr show | grep -E 'tap[1-6]'
```

查看最近的系统错误：

```bash
sudo journalctl -p err -b --no-pager -n 100
```

## 3. 重启 Docker 业务

先找到 Docker Compose 项目目录。进入包含 `docker-compose.yml` 或
`compose.yml` 的目录后执行：

查看服务状态：

```bash
docker compose ps
```

查看最近日志：

```bash
docker compose logs --tail=100
docker compose logs --tail=100 platform-api
docker compose logs --tail=100 soccer-app
```

重启全部 Compose 服务：

```bash
docker compose restart
```

只重启某个服务：

```bash
docker compose restart <service-name>
```

例如：

```bash
docker compose restart platform-api
```

如果容器已经退出，重新启动：

```bash
docker compose up -d
```

如果代码或 Dockerfile 已更新，需要重新构建：

```bash
docker compose up -d --build
```

不要在玩家正在对战时随意执行 `down`。如果必须完全重建容器，先确认没有正在进行的比赛：

```bash
docker compose down
docker compose up -d
```

查看单个容器日志：

```bash
docker logs --tail=200 <container-name>
docker logs -f <container-name>
```

直接重启单个容器：

```bash
docker restart <container-name>
```

如果 Docker 引擎本身异常：

```bash
sudo systemctl status docker --no-pager
sudo systemctl restart docker
sudo systemctl enable docker
```

重启 Docker 引擎会影响所有容器，优先使用 `docker compose restart <service-name>`。

## 4. 重启 OpenVPN 房间服务

### 4.1 查看单个房间

```bash
sudo systemctl status welopenvpn@1 --no-pager
sudo journalctl -u welopenvpn@1 -n 100 --no-pager
```

### 4.2 重启单个房间

```bash
sudo systemctl restart welopenvpn@1
sudo systemctl status welopenvpn@1 --no-pager
```

把房间号替换成 `1` 到 `6`：

```bash
sudo systemctl restart welopenvpn@2
sudo systemctl restart welopenvpn@3
sudo systemctl restart welopenvpn@4
sudo systemctl restart welopenvpn@5
sudo systemctl restart welopenvpn@6
```

### 4.3 重启全部房间

```bash
for room in 1 2 3 4 5 6; do
  sudo systemctl restart "welopenvpn@${room}"
done
```

检查全部状态：

```bash
for room in 1 2 3 4 5 6; do
  sudo systemctl is-active "welopenvpn@${room}"
done
```

### 4.4 服务没有安装或模板改过

```bash
sudo systemctl daemon-reload
sudo systemctl enable welopenvpn@1 welopenvpn@2 welopenvpn@3 welopenvpn@4 welopenvpn@5 welopenvpn@6
sudo systemctl start welopenvpn@1 welopenvpn@2 welopenvpn@3 welopenvpn@4 welopenvpn@5 welopenvpn@6
```

确认配置存在：

```bash
ls -l /etc/welopenvpn/rooms/room-*.conf
ls -l /etc/welopenvpn/pki/
ls -l /etc/welopenvpn/auth/verify-lease.sh
```

如果房间配置改过，重新生成后再重启：

```bash
sudo WEL_API_BASE_URL=http://127.0.0.1:8082/api/v1 \
  /etc/welopenvpn/generate-room-configs.sh /etc/welopenvpn/rooms
sudo systemctl daemon-reload
for room in 1 2 3 4 5 6; do
  sudo systemctl restart "welopenvpn@${room}"
done
```

## 5. OpenVPN 日志和状态

查看房间日志：

```bash
sudo journalctl -u welopenvpn@1 -f
```

查看房间状态文件：

```bash
sudo tail -f /var/log/welopenvpn/room-1.status
```

查看所有房间状态文件：

```bash
sudo ls -lh /var/log/welopenvpn/
```

常见错误判断：

- `AUTH_FAILED`：平台 JWT、房间租约、API 地址或租约已过期。
- `TLS handshake failed`：证书、端口、防火墙或客户端配置问题。
- 服务 active 但没有客户端：检查 UDP 端口和云安全组。
- 客户端拿到 IP 但互相 Ping 不通：检查 TAP 接口、OpenVPN `client-to-client` 和
  防火墙。
- 能 Ping 但 WE8 搜不到：优先检查客户端是否启用了 Radmin、ZeroTier 或其他
  虚拟网卡。

## 6. 端口和防火墙

OpenVPN 房间使用：

```text
UDP 12001 房间 1
UDP 12002 房间 2
UDP 12003 房间 3
UDP 12004 房间 4
UDP 12005 房间 5
UDP 12006 房间 6
```

检查 Ubuntu UFW：

```bash
sudo ufw status verbose
```

如果使用 UFW，放行房间端口：

```bash
for port in 12001 12002 12003 12004 12005 12006; do
  sudo ufw allow "${port}/udp"
done
sudo ufw reload
```

云服务器安全组也必须放行相同的 UDP 端口。只改 Ubuntu 防火墙而没有改云安全组，
外部客户端仍然无法连接。

如果确认 SoftEther 已经停用并且当前完全使用 OpenVPN，可以检查旧端口后再决定
是否删除。不要因为 OpenVPN 故障临时删除未知端口：

```bash
sudo ss -lntup
```

## 7. 常见恢复顺序

### API 登录失败

```bash
docker compose ps
docker compose logs --tail=200 platform-api
docker compose restart platform-api
```

### 所有人进不了房间

```bash
sudo systemctl status welopenvpn@1 --no-pager
sudo ss -lunp | grep -E '1200[1-6]'
sudo journalctl -u welopenvpn@1 -n 100 --no-pager
```

必要时只重启对应房间，不要先重启全部：

```bash
sudo systemctl restart welopenvpn@1
```

### 某个房间服务异常

```bash
sudo systemctl restart welopenvpn@<room>
sudo journalctl -u welopenvpn@<room> -n 100 --no-pager
```

### 服务器整体异常

按以下顺序处理：

1. `free -h`、`df -h`、`uptime`。
2. `docker ps -a`，检查业务容器。
3. `docker compose restart` 或只重启异常服务。
4. 检查 `welopenvpn@1..6`。
5. 检查 UDP `12001..12006` 是否监听。
6. 检查云安全组和 UFW。
7. 最后才考虑重启服务器：

   ```bash
   sudo reboot
   ```

重启服务器前要确认当前没有正在进行的比赛。

## 8. 安全注意事项

- 不要把 `server.key`、数据库密码、JWT 密钥提交 Git。
- 不要把包含密码的 `welopenvpn.env` 发到群里。
- 生产操作前先记录当前状态和日志。
- 重启 Docker 引擎、OpenVPN 全部房间或服务器都会影响在线玩家。
- 优先重启单个异常服务，避免扩大影响范围。
