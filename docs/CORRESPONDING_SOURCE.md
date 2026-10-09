# 对应源码及重新构建

本定制分支的对应源码：https://github.com/ishidadao/KAMUCL_Update ，开发分支为 `main`。基础项目来自 https://github.com/kamubaba-i/KAMUCL ，保留其原作者署名、MIT 许可及第三方许可说明。

Windows CI 的每次构建对应其实际 Git 提交；CI 产物不等同于正式发行，也不会自动创建 Release。正式发行应附带 `KAMUCL-版本-source.zip`，明确对应同名版本标签和提交。源码包包含应用源码、LGPL 部分、桥接 MOD、原生辅助程序、视觉资产、脚本、锁文件及许可，不包含账户、游戏缓存、服务器签名私钥或玩家数据。
1. 安装 Node.js 24、npm、完整 JDK 17 或更新版本；JAVA_HOME 和 PATH 指向 JDK，
   确认 javac 与 jar 可用。完整构建会编译桥接和离线皮肤组件。
2. 在源码根目录运行 npm ci。
3. node scripts/build-bridge.cjs 从 Fabric Maven 和 Maven Central 获取固定版本
   编译依赖并校验 SHA256。离线可用 KAMUCL_BUILD_LIBS 指向同坐标 Maven 目录。
4. 修改 src/main/core/voxlink 或其他源码，运行 npm run build。
   Windows 原生程序由系统 .NET Framework csc.exe 编译；Mac 不需要它。
5. npm start 启动修改版。Windows 用 npm run dist:win；本批 Windows 使用 Electron 44.3.0。
   Mac 构建使用 package.json 固定的 Electron 版本及 npm run dist:mac，
   与 Windows 共用界面与业务代码。本批目标为 Windows x64 和 Mac ARM64；
   原生构建、实际验收范围和未覆盖项以本版交付记录为准，不能以同源推断通过。
6. .github/workflows/mac-build.yml 描述原生构建、签名、APP ZIP 与 DMG 验证。
   npm test、npx tsc --noEmit 与 npm run license:check 提供本地检查。
7. scripts/build-offline-skin-agent.cjs 使用 javac --release 8 构建原创
   GPL-3.0-or-later 离线皮肤提供器；npm run build 自动构建并复制该 JAR。
   authlib-injector 由游戏首次使用时从官方来源校验下载，不包含在成品中。

## 重新构建

1. 安装 Node.js 24、npm 和 JDK 17；令 `JAVA_HOME` 指向 JDK。
2. 在源码根目录运行 `npm ci`。
3. 运行 `node scripts/build-bridge.cjs`。脚本从 Fabric Maven 和 Maven Central 获取固定编译依赖，并校验 SHA-256；离线可用 `KAMUCL_BUILD_LIBS` 指向同坐标 Maven 目录。
4. 运行 `npx tsc --noEmit`、`npm test` 和 `npm run license:check`。许可检查失败时不得绕过门禁出包。
5. 运行 `npm run build`，再用 `npm start` 启动修改版。Windows 的原生辅助程序由系统 .NET Framework `csc.exe` 编译。
6. 在 Windows x64 上运行 `npm run dist:win`，生成便携 EXE、内含相同 EXE 的紧凑 ZIP 和直接解压的备用 ZIP。本批运行库为 Electron 44.3.0；`.github/workflows/windows-managed-build.yml` 记录对应 Windows 构建、许可检查、启动探测及 SHA-256 步骤。
7. 提交完整、干净的源码后，运行 `node scripts/pack-source.cjs`，从实际 Git 提交生成含逐文件哈希的源码包。Windows CI 还运行 `node scripts/verify-source-archive.cjs`，检查成员、凭据模式、实际提交身份并在独立解压目录重新构建，需额外空间及网络。该源码包包含已提交的工作流、文档和测试，不包含 `.git` 登录状态或生成的产物。

源码归档唯一的历史证据排除规则是 `docs/validation-<数字版本号>/evidence/**`（例如 `docs/validation-1.1.15/evidence/`）：这些目录存放生成的验收产物，不是重新构建输入，仍完整保留在 Git 中。`SOURCE-MANIFEST.json` 的 `excludedNonBuildFiles` 列出该提交中每一个被排除的路径，审计要求与提交中的规则结果逐项一致。其他源码、资产、脚本、测试、许可和文档不因这个规则被排除；排除目录中已跟踪文件的未提交改动同样会使打包失败。审计仍拒绝源码包中的缓存、产物目录及潜在凭据，并核对其余文件的原始 Git 字节后进行干净重建。

macOS 与 Linux 保留现有原生构建脚本及工作流；本批不把 Windows CI 构建成功作为这些平台的原生验收。修改后的应用可自行编译及 ad-hoc 签名，无需 KAMUCL 私有签名密钥。

## 本分支服务器同步改动

服务器协议校验、隔离实例、增量同步和界面由本分支以 TypeScript/Vue 独立实现。兼容既有《愚者》清单及通用 KAMUCL/PCL 签名发布协议属于互操作，不包含私人 PCL 仓库源代码的复制或再分发。通用服务器首次连接须核对管理员指纹并明确确认，然后按服务器固定公钥，拒绝自动接受密钥改变。功能范围与备份行为见 [服务器同步说明](https://github.com/ishidadao/KAMUCL_Update/blob/main/docs/managed-server-sync.md)。

LGPL 部分提供完整源码，可修改并重新编译组合应用；不禁止为调试修改进行逆向工程。第三方代码仍适用自己的许可，参见 `THIRD_PARTY_NOTICES.md`、`licenses/` 和 `docs/license-status.json`。本说明不追溯确认历史版本授权，也不将尚未执行的源码审计或发行步骤标记为已完成。
