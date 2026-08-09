# WEL 职业联盟对战平台开发文档

## 1. 项目概览

本项目是 WEL/WE8 对战平台的 Windows 客户端和 OpenVPN TAP 联机方案。

当前技术路线：

- Windows 客户端：Electron + Vue + TypeScript。
- 游戏联机：OpenVPN 2.5.10 TAP，按房间建立独立二层广播域。
- 房间网络：房间 1 到 6 分别使用 `10.80.1.0/24` 到 `10.80.6.0/24`。
- OpenVPN 服务端：Ubuntu + systemd 模板服务。
- 登录和房间业务：复用线上 Laravel/Go API。
- 客户端更新：GitHub Release 主下载源，服务器备用下载源。

SoftEther 已不是当前客户端的主联机方案。修改联机逻辑时，不要重新引入 SoftEther 租约、账号或 `vpncmd` 流程。

## 2. 目录结构

```text
welopenvpn/
├── .github/workflows/windows-client.yml
├── deploy/openvpn/
│   ├── auth/verify-lease.sh
│   ├── systemd/welopenvpn@.service
│   ├── generate-room-configs.sh
│   └── welopenvpn.env.example
├── frontend/
│   ├── build/
│   │   ├── installer.nsh
│   │   ├── cleanup-openvpn-gui.ps1
│   │   ├── remove-wel-openvpn-msi.ps1
│   │   └── tap-windows-9.24.7-I601-Win7.exe
│   ├── electron/
│   │   ├── main.cjs
│   │   ├── preload.cjs
│   │   ├── openvpn.cjs
│   │   ├── network.cjs
│   │   ├── firewall.cjs
│   ├── src/
│   │   ├── App.vue
│   │   ├── api.ts
│   │   └── electron.d.ts
│   ├── resources/openvpn/bin/
│   ├── package.json
│   └── release/
└── docs/
```

## 3. 本地开发环境

建议使用：

- Node.js 18。
- npm 或 pnpm。
- Windows 构建必须在 Windows GitHub Actions 或 Windows 机器上完成。
- macOS 可以运行前端测试和 Vite 构建，但不能实际验证 TAP 网卡、OpenVPN Windows 服务和 WE8。

安装依赖：

```bash
cd frontend
npm install
```

前端开发：

```bash
npm run dev
```

Electron 开发启动：

```bash
npm run electron:dev
```

生产前端构建：

```bash
npm run build
```

## 4. 测试和构建

运行 Electron 辅助模块测试：

```bash
cd frontend
npm run test:electron
```

当前测试覆盖：

- OpenVPN 配置和证书校验。
- 房间虚拟 IP 和网卡识别。
- Windows 网卡跃点和冲突网卡诊断。
- WE8/DirectPlay 进程及 UDP 监听诊断。
- 防火墙命令生成。
- TAP 安装、卸载和连接名清理脚本。
- GitHub/服务器双源更新逻辑。

构建 Windows NSIS 安装包：

```bash
cd frontend
npm run electron:build
```

Windows 构建必须包含：

- `frontend/resources/openvpn/bin/openvpn.exe` 及其依赖 DLL
- `frontend/build/tap-windows-9.24.7-I601-Win7.exe` 官方 TAP 驱动安装包
- `frontend/resources/openvpn/ca.crt`

不要把 `server.key`、CA 私钥或其他服务端密钥放入仓库。

## 5. Windows 客户端工作流

### 5.1 登录和进入房间

客户端调用线上 API 登录，进入房间后获得平台 JWT 和房间租约。OpenVPN 客户端把平台 JWT 作为 OpenVPN 密码发送给对应房间服务端。

服务端的 `verify-lease.sh` 会调用：

```text
GET /api/v1/me/room-session
```

只有用户仍然拥有对应房间的有效租约时，OpenVPN 才会接受连接。

### 5.2 房间端口

房间端口固定映射：

| 房间 | OpenVPN UDP 端口 | 网段 |
|---|---:|---|
| 1 | 12001 | 10.80.1.0/24 |
| 2 | 12002 | 10.80.2.0/24 |
| 3 | 12003 | 10.80.3.0/24 |
| 4 | 12004 | 10.80.4.0/24 |
| 5 | 12005 | 10.80.5.0/24 |
| 6 | 12006 | 10.80.6.0/24 |

OpenVPN 不下发默认网关和 DNS，普通上网流量继续走用户自己的宽带/Wi-Fi。

### 5.3 冲突虚拟网卡

WE8 使用老式 DirectPlay 广播发现主机。Radmin、ZeroTier、其他 TAP/OpenVPN、Gateway NC 等虚拟网卡可能导致：

- 双方虚拟 IP 可以 Ping 通。
- WE8 搜不到对方主机。
- 搜到主机后同意联机但连接失败。

客户端目前只负责检测并提示，不会自动禁用用户的其他网卡。需要用户到：

```text
控制面板 -> 网络和共享中心 -> 更改适配器设置
```

手动禁用提示中的冲突网络连接。不要在设备管理器中卸载驱动，也通常不需要重启电脑。

### 5.4 TAP 网卡命名

安装器会复用已有的 WEL 专用 TAP 网卡，不在普通升级或卸载时反复删除重建。新连接使用 `WEL Virtual LAN`，旧版生成的 `WEL TAP` 或 `WEL TAP 18` 会在客户端启动时复用并尝试重命名。OpenVPN 运行文件由客户端直接携带，Windows 中只安装 TAP 驱动，不安装完整 OpenVPN、GUI 或 Wintun。

相关脚本：

- 安装：`frontend/build/ensure-wel-tap.ps1`
- 卸载：`frontend/build/remove-wel-tap.ps1`

## 6. OpenVPN 服务端工作流

服务端配置目录约定为：

```text
/etc/welopenvpn/
├── rooms/room-1.conf ... room-6.conf
├── pki/ca.crt
├── pki/server.crt
├── pki/server.key
├── auth/verify-lease.sh
└── welopenvpn.env
```

生成房间配置：

```bash
sudo WEL_API_BASE_URL=http://127.0.0.1:8082/api/v1 \
  /etc/welopenvpn/generate-room-configs.sh /etc/welopenvpn/rooms
```

OpenVPN 服务由模板单元管理：

```text
welopenvpn@1.service
welopenvpn@2.service
...
welopenvpn@6.service
```

每个服务都会创建对应的 TAP 接口和 CCD 目录。CCD 文件由 `verify-lease.sh` 按租约写入，使用固定虚拟 IP：

```text
ifconfig-push 10.80.<room>.<host> 255.255.255.0
```

## 7. 修改代码后的发布流程

1. 修改代码。
2. 本地运行：

   ```bash
   cd frontend
   npm run test:electron
   npm run build
   ```

3. 修改 `frontend/package.json` 版本号，并同步 `package-lock.json`。
4. 提交并推送 `main`：

   ```bash
   git add .
   git commit -m "描述本次修改"
   git push
   ```

5. 查看 GitHub Actions。
6. 构建成功后，从 Actions 构建产物下载并测试新安装包。

不要把未验证的安装包直接给玩家，尤其要验证：

- Windows 10/11。
- Windows 7 兼容性。
- 已安装其他虚拟网卡的电脑。
- 覆盖安装和卸载后重新安装。
- 进入/退出房间和重启客户端后的状态。
