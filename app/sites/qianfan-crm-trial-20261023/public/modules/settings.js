import {
  esc,
  icon,
  avatar,
  badge,
  stageBadge,
  actionButton as button,
  sectionHead,
  select,
  input,
  textarea,
  formShell,
} from "../ui.js";

export function settings(S, P) {
  const tabs = [
    ["members", "团队成员"],
    ["rules", "阶段与动作"],
    ["integrations", "系统连接"],
  ];
  return `<div class="list-summary"><div class="segment">${tabs.map(([id, label]) => `<button data-action="settings-tab" data-id="${id}" class="${P.tab === id ? "selected" : ""}">${label}</button>`).join("")}</div></div>${P.tab === "members" ? `<section class="panel">${sectionHead("团队成员", "仅保留管理员与销售两种角色", button("添加成员", "new-user", "", "primary", "plus"))}<div class="table-scroll"><table class="data-table"><thead><tr><th>成员</th><th>账号</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${S.users.map((u) => `<tr><td><span class="owner-cell">${avatar(u.name, true)}${esc(u.name)}${u.id === S.actor.id ? badge("当前账号") : ""}</span></td><td>${esc(u.username)}</td><td>${u.role === "admin" ? "管理员" : "销售"}</td><td>${badge(u.active ? "使用中" : "已停用", u.active ? "success" : "neutral")}</td><td>${u.id !== S.actor.id ? `<button class="text-link" data-action="toggle-user" data-id="${u.id}">${u.active ? "停用" : "启用"}</button>` : "—"}</td></tr>`).join("")}</tbody></table></div><div class="table-footer">${S.users.length} 位成员<span>停用后登录会话立即失效</span></div></section>` : P.tab === "rules" ? `<section class="panel">${sectionHead("阶段停滞阈值与动作", "超过阈值进入风险队列，跟进承诺逾期也会触发提醒", button("编辑规则", "edit-rules", "", "primary", "edit"))}<div class="table-scroll"><table class="data-table rules-table"><thead><tr><th>销售阶段</th><th>停滞阈值</th><th>建议动作 · 管理员维护</th></tr></thead><tbody>${S.stages.map((s) => `<tr><td>${stageBadge(s)}</td><td>${S.rules.thresholds[s] ? S.rules.thresholds[s] + " 天" : "已结束"}</td><td>${esc(S.rules.sop[s])}</td></tr>`).join("")}</tbody></table></div></section>` : `<section class="panel">${sectionHead("系统连接", "外部能力以实际联调结果为准")}<div class="integrations">${S.integrations.map((i) => `<div class="integration-row"><span class="integration-icon">${icon(i.id === "templates" ? "contracts" : i.id === "llm" ? "chart" : "link")}</span><div><h3>${esc(i.name)}</h3><p>${esc(i.description)}</p></div>${badge(i.status, "neutral")}</div>`).join("")}</div></section><div class="notice spaced">${icon("shield")}<div><b>服务器和凭据就绪后再配置连接</b><span>本地核心流程可以独立使用。当前不会向钉钉发送消息、同步数据或调用大模型。</span></div></div>`}`;
}

export function formSettings(S, type, id, options) {
  if (type === "user")
    return formShell(
      "添加团队成员",
      "本地账号可独立登录，后续可映射到钉钉身份。",
      input("name", "姓名") +
        input(
          "username",
          "登录账号",
          "",
          "text",
          true,
          'pattern="[a-zA-Z0-9_.-]{3,60}" autocomplete="off"',
        ) +
        select("role", "角色", [
          ["sales", "销售"],
          ["admin", "管理员"],
        ]) +
        input(
          "password",
          "初始密码（至少12位）",
          "",
          "password",
          true,
          'minlength="12" maxlength="128" autocomplete="new-password"',
        ),
      type,
      id,
      "添加成员",
    );
  if (type === "rules")
    return formShell(
      "编辑阶段与动作",
      "规则保存后立即用于停滞提醒与阶段建议。",
      S.stages
        .map(
          (s) =>
            `<div class="rule-edit wide"><h3>${esc(s)}</h3>${S.rules.thresholds[s] ? input("threshold:" + s, "停滞阈值（天）", S.rules.thresholds[s], "number", true, 'min="1" max="90"') : ""}${textarea("sop:" + s, "阶段动作", S.rules.sop[s], true)}</div>`,
        )
        .join(""),
      type,
      id,
      "保存规则",
    );
}
