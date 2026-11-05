# 企业资料私密配置

此入口只加载运行凭据，不查询企业、不打开业务数据库、不启动后台任务。Key 不进入页面、业务表或日志；保存在独立运行配置中，不提交版本库。

## 加载顺序与启用

- `CRM_COMPANY_PROFILE_PROVIDER=qcc-mcp` 明确选择企查查；同时提供 `QCC_MCP_API_KEY` 时优先使用环境凭据，不读取私密文件。
- 仅提供 `QCC_MCP_API_KEY` 不会自动选择 provider。独立文件中的 `provider: "qcc-mcp"` 也属于明确启用。
- `CRM_COMPANY_PROFILE_PROVIDER=qcc` 保留原有传统企查查 API 适配，以原 `QCC_APP_KEY`、`QCC_SECRET_KEY` 判断配置状态，不读取 MCP 私密文件、不覆盖原 provider 或凭据。
- `CRM_COMPANY_PROFILE_PROVIDER=none`（或 `off`、`disabled`）优先关闭，不读取文件。其余不支持的 provider 值会以固定错误提示拒绝。
- 未配置文件或未提供 Key 时返回 `configured: false`；不把缺失凭据当作成功配置，也不回退到测试 Key。
- `local/run.mjs` 读取项目 `.private/company-profile.json`；`deploy/server-entry.mjs` 读取 `QF_DEPLOY_CONFIG` 所在目录的 `company-profile.json`，不改动 `application.json`、`ai.json` 或 systemd unit。

## Windows 安全录入

在项目目录使用以下命令。Key 在隐藏提示中输入，不作为命令行参数，也不放进 PowerShell 历史或聊天消息。

```powershell
powershell.exe -NoProfile -File local/save-company-profile-key.ps1
```

更新已存在的文件时显式增加 `-Replace`。需要程序化传输时，可用 `-FromStdin` 并由上游进程通过标准输入传入；不要用含明文 Key 的 shell 命令构造管道。`-ConfigPath` 仅用于明确指定配置文件路径／隔离测试。

保存采用 DPAPI `CurrentUser`，文件仅含 `provider`、`protection: "dpapi-current-user"` 与 `protected_key` 密文。新文件和临时文件 ACL 限制为当前 Windows 用户与 SYSTEM；覆盖要求显式 `-Replace`。文件不得复制到其他用户或 Linux 使用。

`read-company-profile-key.ps1` 是 Node 启动器的内部管道辅助脚本，不是人工查看凭据入口。通过以下命令只查看是否配置，不显示 Key，也不调用外部接口：

```powershell
node local/company-profile-config.mjs --status
```

返回字段只有 `provider`、`configured` 和 `source`。保存后须在下一次明确授权的预览重启时加载；本工具本身不重启服务。

## Linux 运行配置

优先由服务运行环境安全提供上述两项环境变量。若需要独立文件，其 JSON 使用 `provider: "qcc-mcp"`、`protection: "file-permissions"` 和 `apiKey`，不沿用 Windows 密文。

私密文件通常为 `0600`、父目录为 `0700`；文件与直接父目录须归当前服务用户或 root，不能包含任何组／其他用户权限，也不能是符号链接。服务进程还须实际具有文件读取权限。加载器会在读取内容前检查这些条件，拒绝权限过宽、无效 JSON、无效 Key 或不支持的配置。不要把 Key 写到发布包或普通配置模板中。

当前服务器私密目录为 `/srv/qianfan-crm/private/`，实际加载文件与 `QF_DEPLOY_CONFIG` 同目录。后续发布必须保留服务器原配置，不把 Windows `.private/` 上传或覆盖服务器。各环境凭据独立录入，保存本地凭据不代表已配置或发布服务器。

## 隔离验证

### 企查查优先与 Qwen 回退（2026-11-02）

明确启用 `qcc-mcp` 后，企业资料查询默认先走企查查 MCP。运行时复用工作台现有 `PPIO_API_KEY` 和固定的 `qwen/qwen3.8-max`，不增加另一套 AI 凭据。企查查额度不足、授权不可用、限流、连接或协议错误，以及无匹配时，回退至 PPIO Web Search (`https://api.ppio.com/v3/web-search`) + Qwen；主体冲突/不唯一及调用方的身份或租约校验失败仍停止，不能被 AI 绕过。两通道均不可用时明确反馈，保留旧资料。

已知企查查额度暂停期间，已获准的查询直接走 Qwen；恢复后下一次查询仍优先企查查。Qwen 只摘录搜索结果中与完整企业名称/信用代码相符、有真实来源和原文依据的字段，未找到则留空。Qwen 内容以 `partial` 保存并展示实际来源及待核验标记，不作为已核验企查查资料提供给阶段分析；既有企查查事实保留。工商检查点继续复用，不重复消耗已完成步骤。搜索结果、模型输出均不能指定任意网络请求或修改业务主体。

这不改变任务授权：121 家历史余项仍须明确手动启动，新增客户保留现行自动查询资格，本地自动执行仍受独立项目授权及运行时校验限制。回退成功/无结果不安排自动无限重试，不自动购买企查查积分。页面只保留手动查询入口，通过即时提示和完成后的提示反馈，保留来源、读取时间和真实字段，不恢复队列计数或积分说明。

`prepareCompanyProfile --status` 仅反映企查查凭据状态；运行服务 `/api/health` 的 `companyProfile.fallback` 为 `qwen` 时表示已加载回退配置。真实验证记录在 `runtime/company-profile-fallback-20261102/`，调用真实企业资料查询，未向业务库写测试结果。此轮仅本地，未发布服务器。

```powershell
cd app
node --test tests/company-profile-config.test.mjs
```

测试只使用临时目录和明确的假 Key，Windows 下实际验证 DPAPI 往返及原子替换；Linux 权限校验在所有平台都有逻辑覆盖。测试不会读取真实私密文件、业务库或调用企查查。
