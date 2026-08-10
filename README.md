# WEL 职业联盟对战平台

WEL Windows 客户端通过 `n2n edge + TAP-Windows` 建立 WE8 虚拟局域网。进入房间后，客户端从平台 API 获取房间、虚拟 IP 和服务器地址，再连接 WEL 的 n2n supernode（UDP `22222`）。

## Windows 客户端

安装包和安装后的目录都包含以下联机运行文件：

- `resources/n2n/edge.exe`: 从官方 ntop/n2n 3.0 源码构建的 Windows x64 客户端。
- `resources/n2n/tapctl.exe`: TAP 网卡检测工具。
- `resources/n2n/tap-windows-9.21.2.exe`: 官方 TAP-Windows 驱动安装器。

首次启动平台会检查系统的 `tap0901` 驱动：已经有 TAP-Windows 网卡时直接复用，绝不删除、重装或修改网卡名；只有完全没有该驱动时，才会安装目录自带的 TAP 驱动。安装完成后的整个 WEL 目录可以复制给其他玩家作为绿色版使用，绿色版同样执行这套检查。

卸载 WEL 不会删除 TAP 网卡，也不会修改其他平台的 OpenVPN、n2n 或开机启动项。

## 结构

- `frontend/`: Electron/Vue Windows 客户端及 NSIS 安装包配置。
- `deploy/n2n/`: Ubuntu n2n supernode 的 systemd 配置与部署说明。
- `third_party/n2n/`: 固定的官方 n2n 3.0 源码归档，GitHub Actions 从此源码编译 `edge.exe`。
- `.github/workflows/windows-client.yml`: Windows x64 版本构建、测试和安装包上传。

## 构建与测试

```bash
cd frontend
npm install --legacy-peer-deps --ignore-scripts
npm run test:electron
npm run build
```

推送到 `main` 会在 GitHub Actions 的 Windows Server 2022 镜像上使用 Visual Studio x64 编译 n2n，再构建 NSIS 安装包。安装包 artifact 名称为 `wel-windows-win7-nsis`。

## 服务端

服务端运行一个 n2n `supernode`，客户端和阿里云安全组均使用 UDP `22222`。部署步骤见 [deploy/n2n/README.md](deploy/n2n/README.md)。
