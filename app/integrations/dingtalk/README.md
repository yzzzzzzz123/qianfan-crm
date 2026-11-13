# 钉钉赢单战报接入

当前只接入“四两拨万金（千帆）”，另设独立测试群。已取消的“千帆逐苍穹”不配置、不投递。机器人复用企业应用；应用密钥由服务器现有私密配置提供，不进入模板或源码。

## 模板和机器人

1. 应用启用企业机器人，开通 `Card.Instance.Write`。模板在[钉钉卡片平台](https://open-dev.dingtalk.com/fe/card)管理，入口为开发者平台顶部“开放能力 → 卡片平台”。新建“恭喜成单”模板并关联“千帆CRM”，在编辑器“更多 → 导入”中选择本目录的 [win-report-template.json](win-report-template.json)，保存、核对预览后发布，并记录正式模板 ID。应用权限目录未提供 `Card.Template.ReadWrite.All` 时，不将它作为手动发布模板或本项目发送卡片的前置条件。
2. 模板以“恭喜成单”为标题，正文依次显示“恭喜 @负责人”“销售内容：实际销售内容”“销售金额：¥7,380.00”和“笃行致远，终有收获，再接再厉！”。负责人、销售内容和金额取首次赢单快照，金额使用千分位和两位小数；测试标题明确标注“【测试】”。它没有按钮、交互回调或真实客户样例。
3. 将同一机器人分别加入独立测试群和“四两拨万金（千帆）”。使用有权账号核对群名、机器人编码及 `openConversationId`，不能用普通会话 ID 代替。

复用已发布模板的变量及节点顺序：`title` 为标题，`amount_text` 为恭喜负责人，`owner_text` 为销售内容，`customer_text` 为销售金额，`sales_text` 为鼓励语；`contract_text`、`date_text` 传空，不再展示客户、合同编号和日期。保留变量名以兼容现有模板，本次文案调整无需重新发布模板。卡片适配器同时提供原始字符串字段，金额从整数分转换为两位小数。正文中的 @姓名以蓝色显示，实际 @ 提醒仍通过负责人已经核验的企业钉钉 `ding_user_id` 投递，不按姓名猜绑。

导入文件采用消息卡片格式：外层 `type="im"`、`mode="card"`，`editorData` 为 JSON 字符串，内层 `schemaVersion="3.0.0"`、根组件为 `Card`。它与平台实际导出的消息卡片结构一致，不混用 `standard` / `StdCard` 标准卡片。变量、模拟富文本、组件树和 `widgetInfo` 的字段及节点标识同步；在现有“恭喜成单”消息模板中重新导入即可。

## 配置与测试

只在 Linux 正式服务器真实投递。运行入口及执行器共同检查生产模式、服务器身份和 HTTPS 来源，本地开关不能解除限制；本地测试使用隔离数据库和模拟发送器。

机器人与模板配置保存在数据库 `settings.win_report` 中，初次迁移默认关闭。也可用 `.env.example` 所列环境变量提供默认值。应用凭证复用 `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET`；独立战报应用必须成对提供 `DINGTALK_WIN_REPORT_CLIENT_ID` / `DINGTALK_WIN_REPORT_CLIENT_SECRET`，不与原凭证混用。

管理员通过既有登录会话、CSRF 和幂等请求头调用以下接口。正式路径由 Nginx 加 `/qf-crm/` 前缀。示例中的 ID 全为占位符，应替换为实际核验值。

```http
PATCH /api/win-reports/config
Content-Type: application/json

{
  "enabled": false,
  "robot_code": "应用机器人编码",
  "template_id": "已发布模板ID",
  "test_conversation_id": "cid-test-group",
  "groups": [{"key": "wanjin", "conversation_id": "cid-formal-group"}]
}
```

先 `POST /api/win-reports/test`，请求 `{"group_key":"test","owner_id":123}`；测试负责人可选当前管理员本人或已核验的在用业务成员。只有测试群回执成功后，才允许用 `{"group_key":"wanjin","owner_id":123}` 向正式群发测试卡片。所有测试使用明确标注的示例客户、100 元示例金额，不创建商机、合同或业绩，也不改变测试人的业务成员身份。

`GET /api/state` 的管理员字段 `win_reports` 提供实际配置、测试结果和近期回执；商机的 `win_report` 提供首次赢单快照和投递状态。普通销售不能读取这些字段或修改战报配置。

两群的接口回执成功后，仍须由实际接收人在手机、电脑核对显示和 @ 提醒；确认后再单独提交：

```http
PATCH /api/win-reports/config
Content-Type: application/json

{"enabled":true,"confirmed":true}
```

配置变更会关闭自动推送，必须按新配置重新测试。测试成功记录须与当前机器人、模板及目标群一致。

## 投递与补发

首次已签署合同保存及商机赢单状态、阶段历史、战报事件在同一事务中提交，后台随后投递；业务事务回滚时不会遗留发送任务。快照固定为首次赢单时的负责人、销售内容及有效已签署合同总额。后续追加合同、重复保存及补传签章件不会再次发布首次战报。

每笔赢单及每个目标群分别去重，重试沿用同一个 `outTrackId`。只有匹配目标群的成功回执才记录为“已发送”；卡片创建成功但投放失败时，补发复用已创建实例。明确限流或取凭证网络失败最多尝试五次；发送超时、无法解释的回执或发送中服务中断均标为“待核对”，先核对群内实际结果再补发。

管理员在商机详情点击“补发本群”，仅重试失败记录。结果不确定时，必须确认群内未收到卡片；已成功记录不可重复发送。接口为 `POST /api/opportunities/:id/win-report/:deliveryId/retry`，普通失败请求 `{}`，待核对记录请求 `{"confirmed_not_delivered":true}`。自动推送关闭或目标群已变更时暂停补发。

开关关闭期间的赢单记录为“当时未开启自动推送”，开启后不会补发这批记录或历史赢单。不要通过删除阶段历史或投递记录模拟首次赢单。

## 部署验收

先备份生产数据库，在服务器最新库的隔离副本上验证迁移 37；它只增加战报事件、群投递两张表及相关索引与触发器，不回填历史战报。保留原配置、密钥、身份、附件和业务数据，部署默认关闭的战报功能。

完成测试群、正式群测试卡片及显示/@验收后启用。下一笔真实赢单检查“四两拨万金（千帆）”只收到一张，负责人、销售内容、签约金额与首次赢单快照一致。不要在正式库新建测试商机验收。发布后按项目部署流程将实际发布代码和迁移同步 GitHub 基线，完整验收记录保存在源码工作区之外。

本地验证：`npm run check`、`npm test`；专项测试：`node --test tests/win-reports.test.mjs`。真实钉钉投递与手机 @ 验收必须另行记录，模拟测试通过不能代替真实投递。

官方接口：[创建并投放卡片](https://open.dingtalk.com/document/development/create-and-deliver-cards)、[投放已有卡片](https://open.dingtalk.com/document/development/delivery-card-interface)、[卡片搭建与发布](https://open.dingtalk.com/document/development/card-template-building-and-publishing)。
