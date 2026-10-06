# 项目默认交付流程

本仓库是用户指定的 KAMUCL 定制分支：https://github.com/ishidadao/KAMUCL_Update 。后续源码提交目标为该仓库的 `main` 分支。上游 https://github.com/kamubaba-i/KAMUCL 仅用于参考和保留原作者署名，**不得向上游仓库推送、创建 Release 或上传本分支产物**。

- 每批功能或修复递增版本尾号，同步 package.json、package-lock.json 根包版本及 src/shared/updateNotes.ts。更新日志时间采用 Asia/Shanghai，格式 YYYY-MM-DD HH:mm。
- 版本号每百进一：尾号从 0 到 99，下一版向前一位进一并将尾号归零（例如 1.0.99 → 1.1.0）。
- 运行与改动相关的验证、类型检查、测试及构建。Windows 出包使用 `npm run dist:win`，验证便携 EXE、ZIP、启动及 SHA-256；未实际完成的原生验收必须明确标注。
- 打包前必须通过 `npm run license:check`。许可不明或对应源码交付不完整时保留诊断，禁止跳过许可门禁或声称已可发行。
- 提交前核对远端地址和当前分支，默认提交并推送 `ishidadao/KAMUCL_Update` 的 `main`；不沿用上游的 master/main 双历史流程，不强制推送、不覆盖远端更新，不合并或推送 wuhui 分支。
- GitHub Actions 仅构建和上传 CI 验收产物，不自动发布 Release。公开发行、打标签及 Release 上传按用户当次明确授权执行，且只能发布到本定制分支仓库。
- 本分支自更新的 GitHub 来源必须保持为 `ishidadao/KAMUCL_Update`，不得由上游安装包自动替换定制功能。保留原项目和第三方版权、许可及来源说明，不把上游交流群称为本分支官方分发渠道。
- 服务器同步逻辑为本分支独立的 TypeScript/Vue 实现，只兼容已有签名协议；不复制私人 PCL 源码。不得提交账号、令牌、签名私钥、AI API Key、服务器私密配置或玩家数据。
- 保留现有用户改动、普通游戏实例及个人存档，不结束他人的游戏或服务进程。服务器/NAS 写入必须在用户当次请求范围内。
- 如当次用户明确要求只分析、暂不执行、暂不提交或有其他限制，以当次指令为准。验证、打包或发布失败须准确报告失败环节并保留可恢复结果。
