# 自建签名客户端更新源

此工具是本分支独立的 Node.js 24 实现，不需要 npm 依赖，不是 Minecraft 服务端，也不会改动游戏世界或开关服务器。它发布**管理员已经准备、检查过的客户端目录**，由 Caddy 提供 HTTPS 静态文件。启动器发现后会展示并要求首次确认公钥指纹；首次确认后变更公钥会被拦截。

## 初始化与准备

在不公开的工作目录运行：

```sh
node /opt/kamucl-publisher/managed-publisher.cjs init --config /srv/kamucl-sync/config.json
```

命令生成 `config.json` 和私有 RSA 3072 位签名密钥；已有配置或密钥不会覆盖。保管、离线备份密钥。丢失密钥不能冒充旧更新源；轮换密钥需要玩家重新明确建立信任。Linux/macOS 要求密钥不对组或其他用户开放（例如 `chmod 600`）。Windows 初始化会通过系统 PowerShell 设置并在发布时校验私有 ACL，只允许当前用户、Administrators、SYSTEM。

编辑生成的配置，参照 [config.example.json](config.example.json)：填写准确的 `minecraft`、`loader.type`、`loader.version`、`packId`、`packName`、`packVersion`、`serverAddress`、`publicBaseUrl`。所有本地相对路径以**配置文件所在目录**解析，不依赖运行命令的当前目录。`publicBaseUrl` 必须是与游戏地址相同主机的有效 HTTPS 地址，例如 `https://mc.example.com/managed/` 或 `https://mc.example.com:4443/managed/`；这里的 HTTPS 端口不是 Minecraft 的 TCP 25565 端口。

配置目录、私钥、客户端材料、输出目录以及它们的所有祖先必须是真实目录，不允许符号链接或 Windows junction；即使链接目标在同一磁盘也会被拒绝。macOS 上 `/var`、`/tmp` 通常是链接，应使用实际的 `/private/var`、`/private/tmp` 或用户目录路径。不要通过放宽权限或关闭校验绕过这个限制。

`client-ready` 只能包含独立的客户端材料：

- 管理员判断哪些模组同时需要在客户端运行；保留必需的客户端专用模组，去掉仅服务端使用的模组。工具不凭 JAR 文件名推断兼容性。
- 只放需要统一的公共配置、KubeJS、资源包等。不要复制 `world`、玩家文件、账号、个人设置、服务器配置、API 密钥。
- 发布允许的根为 `mods/config/defaultconfigs/kubejs/emotes/resourcepacks/shaderpacks`；可用 `allowRoots` 缩小范围，不能扩大为存档、账号或任意路径。
- `exclude` 只支持安全的 `*`、`**`、`?` 路径模式，不执行表达式。已知女仆站点、Spotify 私密配置默认排除；未排除的密钥/凭据路径会拒绝发布。文件名检查无法识别任意文件内的秘密，管理员必须人工核查客户端材料。

核查完成后才将 `clientPrepared` 设为 `true`。存在 `world`、`server.properties`、OP 或白名单文件的原始服务端目录会被拒绝。不要把工具直接指向运行中的服务端。

Linux 示例将私有工作目录保留在 `/srv/kamucl-sync/`，把配置中的 `outputRoot` 改为 `/var/www/kamucl-sync`，与 Caddy 示例一致。发布用户必须有权创建/写入该专用公开目录；不要把网站根指向私有工作目录。初始化默认的 `./public` 只是路径模板，采用它时必须相应修改 Caddy 根目录并处理父目录穿越权限。

Windows 可在 PowerShell 中运行：

```powershell
node C:/Tools/kamucl-publisher/managed-publisher.cjs init --config C:/ProgramData/KAMUCL-sync/config.json
```

在生成的配置中使用正斜杠路径（避免 JSON 中反斜杠转义），例如以下路径字段；其他身份、版本、审核确认字段仍须按前文填写：

```json
{
  "clientRoot": "C:/ProgramData/KAMUCL-sync/client-ready",
  "outputRoot": "C:/inetpub/KAMUCL-sync",
  "privateKey": "C:/ProgramData/KAMUCL-sync/private/managed-signing-key.pem"
}
```

这是配置片段，不是完整配置。Windows Caddy 的公开根目录应同步改为 `C:/inetpub/KAMUCL-sync`。完成客户端材料审核后执行 `node C:/Tools/kamucl-publisher/managed-publisher.cjs publish --config C:/ProgramData/KAMUCL-sync/config.json`，不要共享 `C:/ProgramData/KAMUCL-sync/private`。

## 发布与 Caddy

```sh
node /opt/kamucl-publisher/managed-publisher.cjs publish --config /srv/kamucl-sync/config.json
```

输出中可取得公钥 SHA-256/SPKI 指纹，使用可信的渠道提供给玩家。每次都读取实际文件内容：同名、同长度魔改 JAR 也会产生新 SHA-256。文件以流式方式校验/复制，单文件最大 512 MiB、总量最大 20 GiB、最多 20,000 个文件；不会把大型整合包整体读入内存。已经存在且正确的不可变内容对象不重新生成，内容、版本、配置均未变化时不重签清单。

按照 [Caddyfile.example](Caddyfile.example) 配置有效 TLS、DNS 和必要的 HTTPS 端口放行，检查配置后再由管理员加载。将 `publicBaseUrl` 的 `/managed/` 路径对应到配置中的 `outputRoot`，并暴露同主机的 `/.well-known/kamucl-managed.json`。工具同时生成 `pcl-managed.json` 旧协议入口，但旧客户端是否支持某整合包还取决于其原有信任策略。已有同域名的 MCSManager 或其他站点须保留原来的路由，合并这些明确入口，而不是覆盖整个现有站点或加入阻断原服务的兜底规则。

改好现有 Caddy 配置后，先验证（不要未经审核覆盖其他站点）：

```sh
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Windows 对应命令为 `caddy.exe validate --config C:/Caddy/Caddyfile --adapter caddyfile`。验证通过后由管理员按当前服务管理方式平滑加载。发现支持 HTTPS **443 或 4443**，不是任意端口；同一游戏主机仅服务一个标准发现入口，Minecraft 端口仍独立使用签名配置的地址。

只公开示例列出的清单、发现文件及 `objects`，不要公开整个工作目录、私钥或锁文件。工具不提供 Node 公网管理 API，不改动既有 NAS/Caddy，也不代理玩家的 Minecraft TCP 连接。

工具只将公开输出目录及其子目录设为 `0755`、公开文件设为 `0644`；不会递归放宽工作目录或密钥权限。推荐使用独立、可穿越的 `/var/www/kamucl-sync`。如果保留默认私有工作目录内的 `./public`，Caddy 还需要**穿越父目录**的权限；Linux 可以只授予 Caddy 穿越权限，例如管理员核对精确目录后执行 `setfacl -m u:caddy:--x /srv/kamucl-sync`。不要用递归 `chmod 777` 解决访问问题，密钥仍须私有。Windows 需向 Caddy 服务账号授予公开目录读取/穿越 ACL，不能顺带授予私钥读取权限。

## 更新、删除和恢复

再次准备客户端材料并发布即可。新增/改变对象写完、校验和签名全部完成后才原子替换清单，再替换发现信息。中途失败可能留下无人引用的对象，但不会自动删除它们；发布器也不删除客户端个人存档。跨文件替换不是数据库事务，进程硬中断期间发现/清单身份不一致时启动器应拒绝启动，重新发布后恢复。

`removeFiles` 是管理员明确迁移旧文件的规则，格式为 `{"path":"mods/old.jar","sha256":"旧文件的64位SHA256"}`。必须不与新文件重复；不是随意删除客户端文件的通配符。启动器会将额外的活动 JAR、已撤销的受管内容先备份/隔离，个人存档、选项、非受管配置不接管。

发布锁防止并行写入。锁即使进程已经退出也**不会自动删除**：确认相关发布进程确实不存在、保留旧清单和完整对象后，管理员再删除配置的 `outputRoot` 中明确的 `.managed-publisher.lock` 文件并重试。不要删除工作目录或签名密钥。工具没有定时任务；管理员可在审核完成的发布流程中调用它，不能以未经审核的正在写入目录作为来源。
