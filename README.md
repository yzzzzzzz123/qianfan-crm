# 千帆 CRM

面向销售团队的 CRM 源码，包含客户、商机、跟进、报价、合同、回款、绩效、提成及钉钉听记接入。

主工程位于 `app/`，使用 Node.js、SQLite 和原生 JavaScript 模块；日期选择组件使用 React 与 Arco Design，并通过 Vite 构建。

## 环境与运行

- Node.js 24 或更新版本，使用内置 `node:sqlite`。
- npm 随 Node.js 安装。
- 文档解析涉及的可选 Python 依赖见 `local/requirements-intake.txt` 和 `deploy/requirements-intake.txt`。

```bash
git clone https://github.com/yzzzzzzz123/qianfan-crm.git
cd qianfan-crm/app
npm ci
npm run demo
```

打开 `http://127.0.0.1:3100/`。演示模式创建独立示例数据库，适合本地体验。正式团队服务使用钉钉身份认证、独立数据库及环境配置。

## 功能与源码

| 目录 | 内容 |
| --- | --- |
| `app/server/` | HTTP 服务、身份权限、SQLite 结构与迁移、业务模块及外部接口适配 |
| `app/public/` | 页面、样式、前端模块和已构建的日期选择组件 |
| `app/widgets/` | 日期选择组件的 React 源码与 Vite 配置 |
| `app/scripts/` | 初始化、备份、导入、数据结构核查与源码检查工具 |
| `app/tests/` | 使用隔离数据库、示例身份及接口替身的自动化测试 |
| `local/` | Windows 服务管理、私密配置读取及本地开发工具 |
| `deploy/` | Linux 服务入口、systemd、Nginx、备份及远程 SQLite 工具 |
| `skill/sync-local-to-server/` | 发布计划、业务数据合并工具及目标配置模板 |

业务主链路为客户与联系人 → 商机 → 跟进与报价 → 合同及行项 → 回款。权限、来源记录、事务、幂等与审计贯穿业务写入。企业资料、AI 文档接收和听记需要各自配置对应接口。

## 配置

`app/.env.example` 提供环境变量示例。配置通过环境变量或受控私密配置加载；程序不会自动读取 `.env`，需要时可使用 Node.js 的 `--env-file` 参数。

正式环境自行配置钉钉应用、回调地址、模型接口和企业资料接口。示例与测试凭据只用于隔离测试。发布工具的目标配置以 `skill/sync-local-to-server/profile.example.json` 为模板，按自己的环境创建未跟踪的 `profile.json`。

本仓库只发布源码及配置示例，运行数据库、账号会话、密钥、客户上传附件、听记正文、历史导入资料和内部验收记录保留在各自运行环境。

## 检查与测试

```bash
cd app
npm run check
npm test
npm run test:module -- contracts
```

重建日期选择组件：

```bash
npm run build:widgets
```

## 部署与数据

Linux 部署参考 `deploy/` 中的服务入口、systemd 与 Nginx 模板。运行目录和域名应按实际环境配置，真实密钥在服务器单独提供。发布升级从目标环境自身最新备份迁移并保留业务数据；本地开发和隔离测试不自动运行正式同步、通知或外发任务。

第三方组件声明见 `app/widgets/THIRD_PARTY_NOTICES.txt`。
