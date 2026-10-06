<div align="center">

<img src="build/icon-512.png" width="128" alt="KAMUCL Logo">

# KAMUCL

### ✦ 简约、开箱即用的 Minecraft Java 启动器 ✦

<p>
  <img src="https://img.shields.io/github/package-json/v/ishidadao/KAMUCL_Update?filename=package.json&color=c77dff&style=flat-square" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-8ecae6?style=flat-square" alt="platform">
  <img src="https://img.shields.io/badge/license-MIT-ffb4a2?style=flat-square" alt="license">
  <img src="https://img.shields.io/badge/Electron-44.3.0-9be564?style=flat-square" alt="electron">
  <a href="https://space.bilibili.com/9596327"><img src="https://img.shields.io/badge/Bilibili-作者主页-00AEEC?style=flat-square&logo=bilibili&logoColor=white" alt="Bilibili 作者主页"></a>
</p>

<p>把账号、实例、模组和启动按钮，收进一个清爽的小窗口里。<br>
愿每一次启动，都像打开一扇通往方块世界的传送门。</p>

</div>

本仓库是 [ishidadao/KAMUCL_Update](https://github.com/ishidadao/KAMUCL_Update) 定制分支，基于 [KAMUCL 上游](https://github.com/kamubaba-i/KAMUCL)，保留原作者署名与第三方许可。新增通用服务器整合包同步；自更新只接收本分支的构建，不用上游安装包覆盖定制功能。

## 服务器整合包同步：部署与配置

玩家在 **服务器 → 从服务器同步** 输入 Minecraft 的 `域名:游戏端口`，即可预览并安装服务器指定的 Minecraft、Forge/NeoForge/Fabric/Quilt 精确版本及客户端文件，无需先手动选择游戏版本。下载显示真实字节进度、当前文件和阶段；每次启动重新核对 SHA-256，同名且大小相同的魔改 JAR 也会更新。

**这需要管理员部署更新发布服务。** 普通 Minecraft 状态接口无法提供完整的客户端整合包；启动器不会直接复制服务端全部文件，也不会同步存档、账号、服务器密码或 AI API Key。签名提供内容来源校验，不保证模组代码安全；玩家首次使用新服务器时必须核对管理员公布的公钥指纹并明确确认信任，之后密钥变化会阻止同步。

### 管理员准备

1. 安装 Node.js 24，下载本仓库的 `publisher/` 目录。发布器只使用 Node 内置模块，不需要安装启动器、Electron、数据库或 npm 依赖。
2. 准备一个**专门的客户端分发目录**，从官方客户端整合包整理 `mods/`、`config/`、`defaultconfigs/`、`kubejs/`、`emotes/`、`resourcepacks/`、`shaderpacks/`。不要把正在运行的服务器目录或整个 `.minecraft` 当作客户端包；客户端与服务端专用 Mod 不一定相同。移除凭据，并确认模组允许再分发。
3. 准备 Minecraft 地址（例如 `mc.example.com:25565`）和可被玩家访问的 HTTPS 域名。推荐更新接口 `https://mc.example.com` 的 443 端口；已有部署可用 4443。**Minecraft 游戏 TCP 与 HTTPS 下载是两条独立链路，不把玩家游戏连接送入 HTTP 代理。**

### 初始化与配置

在服务器上将发布器放到 `/opt/kamucl-publisher/`，数据和签名私钥放到单独的 `/srv/kamucl-sync/`，不要放进公开网站根目录：

```bash
node /opt/kamucl-publisher/managed-publisher.cjs init --config /srv/kamucl-sync/config.json
```

初始化不覆盖现有配置或密钥。按照生成的配置以及 [配置示例](publisher/config.example.json) 设置：

- 整合包的稳定 `packId`、显示名称和版本。
- **精确** Minecraft 版本与加载器类型/版本；不要填 `latest`。
- 玩家连接的 Minecraft 地址，以及 HTTPS 发布基地址。
- 已整理的客户端目录、独立的发布输出目录和私钥路径。
- 允许分发的根目录和额外排除规则；确认客户端目录确实已去除服务器专用内容。

路径按配置文件所在目录解析，Linux、macOS 和 Windows 都可使用。配置、私钥、客户端材料和公开目录及其祖先必须是真实目录，不能经由符号链接或 Windows junction。macOS 的 `/var` 和 `/tmp` 通常是别名，请使用真实的 `/private/var`、`/private/tmp` 或用户目录。实际字段、Windows 写法、Caddy 权限及故障处理见 [发布器部署指南](publisher/README.md)。

例如，审核完成后可使用以下配置（域名、目录和版本必须替换成自己的实际值）：

```json
{
  "schema": 1,
  "clientPrepared": true,
  "clientRoot": "./client-ready",
  "outputRoot": "/var/www/kamucl-sync",
  "privateKey": "./private/managed-signing-key.pem",
  "publicBaseUrl": "https://mc.example.com/managed/",
  "serverAddress": "mc.example.com:25565",
  "packId": "my-server",
  "packName": "我的服务器客户端",
  "packVersion": "1.0.0",
  "minecraft": "1.20.1",
  "loader": { "type": "forge", "version": "47.4.12" },
  "allowRoots": ["mods", "config", "defaultconfigs", "kubejs", "emotes", "resourcepacks", "shaderpacks"],
  "exclude": ["**/.DS_Store", "config/touhou_little_maid/sites/**", "config/netmusic-spotify-audio-bridge.properties"],
  "removeFiles": []
}
```

`clientPrepared: true` 是管理员审核确认，不是让工具自动识别服务端/客户端 Mod。私钥和配置目录保持私有；公开输出目录可放在单独的 `/var/www/kamucl-sync`。发布用户需要写权限，Caddy 用户需要只读和目录遍历权限。不要为解决 Caddy 403 而递归公开整个私钥工作目录。

### 发布与 Caddy HTTPS

```bash
node /opt/kamucl-publisher/managed-publisher.cjs publish --config /srv/kamucl-sync/config.json
```

发布器以 SHA-256 生成不可变内容对象和签名清单；文件同名但内容变化也会产生新对象，未变化的对象复用。先完整生成并校验对象，再逐个原子替换清单与发现入口。跨文件替换不是数据库事务：如果进程被硬中断而使入口身份不一致，客户端会拒绝同步，管理员重新发布即可修复。私钥应保持仅发布用户可读；备份私钥并通过可信渠道公布输出的公钥指纹。**不要把私钥、配置凭据或原始客户端目录暴露给 Caddy。**

Caddy 只需为生成的 **公开输出目录** 提供 HTTPS 静态服务，不需要开放远程写入或发布 API。参照 [Caddy 配置示例](publisher/Caddyfile.example)，修改域名及网站根目录，验证配置后平滑重载。标准入口为 `/.well-known/kamucl-managed.json`；发布器还提供 PCL 兼容发现入口。DNS 必须指向此服务，防火墙放行对应 HTTPS 端口；使用自定义 HTTPS 端口时请按部署指南限定的发现端口配置。

已有 Caddy 网站时，将示例中的三个匹配路由合并进该域名站点，**保留原有 MCSManager 等路由**；不要用示例覆盖整份现有 Caddyfile。以 Linux systemd 部署为例，管理员审核合并结果后执行：

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl --fail https://mc.example.com/.well-known/kamucl-managed.json
curl --fail https://mc.example.com/managed/manifest.json
```

先确认 `validate` 成功，再重载；`curl` 地址应替换为实际域名、HTTPS 端口和发布路径。路由行为可查阅 [Caddy 官方 handle 说明](https://caddyserver.com/docs/caddyfile/directives/handle) 和 [静态文件服务说明](https://caddyserver.com/docs/caddyfile/directives/file_server)。

发布后分别检查标准发现文档、清单和其中一个内容对象可通过 HTTPS 访问，并让测试玩家核对公钥指纹、完成同步和登录。不要仅凭发布命令成功就认为客户端能加入；需验证客户端专用配置、必要资源和握手兼容性。

`manifest.json` 是签名信封，不是直接的文件列表。在发布主机上可读取仅供本地排查的 `manifest.payload.json` 取出首个对象地址（空包无对象可测），然后检查下载；无需在 Caddy 中公开这个辅助文件：

```bash
object_url="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("/var/www/kamucl-sync/manifest.payload.json","utf8")); if(!p.files.length) throw Error("No content objects"); console.log(p.files[0].url)')"
curl --fail --output /dev/null "$object_url"
```

应使用实际的 `outputRoot` 路径。HTTPS 可达只是连通性验收，签名及对象 SHA-256 仍由启动器完整校验。

### 后续更新与保留规则

维护客户端分发目录，修改相应版本配置，再执行一次 `publish` 即可。Minecraft/加载器版本变化会创建新的隔离实例并保留旧实例；仅文件内容变化则增量下载，不重新下载所有 Mod。玩家个人存档、账户和 `options.txt` 不属于受管范围。受管实例中多出的活动 `.jar` 会先备份隔离，不是允许任意自装 Mod 的模式。

发布器没有定时自动修改客户端目录、自动删对象或自动轮换密钥；可在现有“停服 → 同步 → 快照 → 发布”流程末尾调用发布命令。为其他服务器部署时使用**各自独立的签名密钥**，不要共用《愚者》的私钥。已有《愚者》发布接口保持兼容，本仓库功能升级不会自行替换 NAS 线上配置。

完整规则见 [客户端同步说明](docs/managed-server-sync.md) 和 [服务端部署指南](publisher/README.md)。

## 🌸 功能一览

| 模块 | 说明 |
| --- | --- |
| 🎮 游戏实例 | 创建、删除、重命名、隔离实例，单独设置 Java 与启动参数 |
| 🧩 版本安装 | 安装原版、Fabric、Forge、NeoForge、Quilt |
| 🪪 账号中心 | 微软账号、离线账号、Yggdrasil 自定义认证 |
| 📦 资源管理 | 管理模组、资源包、光影、世界和服务器 |
| 🛠️ 实例管理中心 | 复制、备份、恢复实例，并查看运行诊断 |
| 🔎 社区资源 | 搜索并导入 Modrinth / CurseForge 资源 |
| 🧁 皮肤衣柜 | 角色预览、皮肤与披风上传、历史记录 |
| 🤝 联机 | FRP、VoxLink、Terracotta 和好友直连 |
| 🛠️ MOD 面板 | 通过 KAMUCL Bridge 实时读取与修改 MOD 参数 |
| ✨ 个性化 | 主题、背景、快捷键、插件和启动页缩略图 |
| 🩺 诊断 | 下载任务、日志导出、启动诊断、更新与回滚 |
| 🔄 服务器同步 | 地址发现、精确运行环境、签名信任与 SHA-256 增量更新、实时下载进度 |

> 完整的页面与业务模块关系见[功能树](docs/FEATURE_TREE.md)，开发流程见[开发指南](docs/DEVELOPMENT.md)。
> 好友直连的网络边界见 [`docs/features/friend-direct-connect.md`](docs/features/friend-direct-connect.md)。

## 📚 文档导航

| 文档 | 适合阅读时机 |
| --- | --- |
| [功能树](docs/FEATURE_TREE.md) | 想了解页面、功能和代码模块的对应关系 |
| [开发指南](docs/DEVELOPMENT.md) | 第一次搭建环境、开发功能或提交代码 |
| [提交规范](docs/CONTRIBUTING.md) | Commit 标题、正文、类型前缀和 Pull Request |
| [好友直连说明](docs/features/friend-direct-connect.md) | 调试联机、端口映射和邀请流程 |
| [Yggdrasil 提供商格式](docs/auth/yggdrasil-provider-card.md) | 接入或排查外置认证服务器 |
| [诊断记录](docs/diagnostics/) | 排查启动器、整合包和运行时问题 |
| [发布验收记录](docs/releases/) | 查看历史版本变更与回归结果 |
| [对应源码](docs/CORRESPONDING_SOURCE.md) | 从发布包重建并核对源码 |
| [第三方许可](THIRD_PARTY_NOTICES.md) | 查看依赖许可证与源码说明 |
| [更新发布服务部署](publisher/README.md) | 管理员部署、配置和更新客户端分发服务 |
| [客户端同步规则](docs/managed-server-sync.md) | 玩家首次信任、备份与故障恢复 |

## 🚀 快速开始

### 直接运行（Windows）

Windows 便携版是单个 EXE，文件名会跟随 `package.json` 的版本号：

```text
release/KAMUCL-<version>.exe
```

首次启动 Minecraft 前，请准备 Windows 10/11 64 位或支持的 macOS、与目标 Minecraft 版本匹配的 Java（现代版本通常需要 Java 17+）和网络连接。Windows ZIP 包解压后需保留同目录下的全部文件。

### 从源码运行

```powershell
git clone https://github.com/ishidadao/KAMUCL_Update.git
cd KAMUCL_Update
npm ci
npm run dev
```

## 🧰 开发与构建

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发模式 |
| `npm run build` | 构建应用文件到 `out/` |
| `npm test` | 运行自动化测试 |
| `npm run dist` | 构建 Windows 便携版与 ZIP |
| `npm run dist:win` | 构建 Windows 便携版与 ZIP |
| `npm run dist:mac` | 构建 macOS ZIP |
| `npm run dist:all` | 构建全部已配置平台 |
| `npm run license:check` | 校验第三方依赖许可证文件 |

只生成 Windows 单文件 EXE：

```powershell
npm install
npm run build
npx electron-builder --win portable
```

产物输出到 `release/`。构建配置已启用最大压缩、仅保留中英文语言包，并排除 source map。

## 🤝 参与开发

代码协作采用 Fork、功能分支和 Pull Request。提交标题、正文、类型前缀与检查要求见[提交规范](docs/CONTRIBUTING.md)；开发检查清单见[开发指南](docs/DEVELOPMENT.md#9-提交前检查清单)。

### 🌉 构建 KAMUCL Bridge

Bridge 是给 Fabric 实例使用的本机桥接 MOD。需要 JDK 17+，并且本机已下载 Fabric Loader 与 Gson 依赖：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'
node scripts/build-bridge.cjs
```

成功后会生成 `bridge/dist/kamucl-bridge-1.0.1.jar`。构建脚本会从固定的 Fabric Maven 和 Maven Central 地址下载并校验编译依赖；完整应用构建需要先生成此文件。单独使用服务器发布器无需 Bridge。

## 🗂️ 项目地图

```text
src/main/       Electron 主进程、Minecraft 管理与 IPC
src/preload/    渲染进程安全桥接 API
src/renderer/   Vue 页面、组件与主题
src/shared/     共用类型、协议和常量
bridge/         KAMUCL Bridge MOD（Fabric）
native/         Windows 原生辅助程序（材质、聚焦、启动反馈）
scripts/        构建、发布与回归测试脚本
tests/          自动化测试
docs/           功能说明、构建说明与版本验证记录
publisher/      通用签名更新发布器与 Caddy 部署示例
```

## 💾 数据、日志与隐私

启动器运行数据默认保存在 Windows 的 `%APPDATA%\KAMUCL`（macOS 为 `~/Library/Application Support/KAMUCL`），包括账号、设置、缓存和日志。反馈问题时，请先隐藏账号令牌、个人路径和公网 IP。

## ❓ 常见问题

<details>
<summary><b>提示「electron-vite 未找到」</b></summary>

在项目根目录执行 `npm install`，再重新运行命令。

</details>

<details>
<summary><b>构建时提示 Bridge JAR 缺失</b></summary>

设置 `JAVA_HOME` 指向 JDK 17 后，执行 `node scripts/build-bridge.cjs`，再重新构建。

</details>

<details>
<summary><b>Windows SmartScreen 提示未知发布者</b></summary>

默认构建未配置商业代码签名证书。确认文件来源后即可运行；正式发布建议配置 Windows 代码签名证书。

</details>

<details>
<summary><b>Minecraft 无法启动</b></summary>

检查实例 Java 路径、Minecraft 版本和加载器是否匹配，然后在“设置 → 诊断”中查看日志。

</details>

## 💌 许可证

本项目基于 [MIT License](LICENSE) 开源。

<div align="center">

`Made with Vue · TypeScript · Electron`  ✦  `祝你游戏愉快！`

</div>
