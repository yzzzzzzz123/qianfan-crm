import {
  esc,
  icon,
  plainMoney,
  avatar,
  badge,
  actionButton as button,
  sectionHead,
  empty,
  select,
  input,
  formShell,
} from "../ui.js";

export function team(S) {
  return `<div class="notice">${icon("shield")}<div><b>当前只展示过程绩效</b><span>按既定口径统计，原始分封顶 50 分，折算后满分 70 分。提成、结果分和绩效等级暂不展示。</span></div>${badge(S.period, "blue")}</div><div class="team-grid">${
    S.team
      .map(
        (u) =>
          `<section class="panel person-panel"><div class="person-head">${avatar(u.name)}<div><h2>${esc(u.name)}</h2><p>销售 · 最近 7 天 ${u.followCount} 条跟进</p></div><span class="person-score">${u.process.raw}<small>/ 50</small></span></div><div class="score-scale"><meter min="0" max="50" value="${u.process.raw}" aria-label="${esc(u.name)}过程得分"></meter></div><div class="process-grid">${[
            ["线上会议", u.process.meeting, "次"],
            ["新增漏斗", u.process.funnelCount, "个"],
            ["对客报价", u.process.quote, "次"],
            ["现场拜访", u.process.visit, "次"],
          ]
            .map(
              ([t, n, unit]) =>
                `<button data-action="person-evidence" data-id="${u.id}" data-kind="${t}"><span>${t}</span><b>${n}<small>${unit}</small></b></button>`,
            )
            .join(
              "",
            )}</div><div class="person-bottom"><span>折算过程分 <b>${u.process.weighted} / 70</b></span><span>${u.riskCount ? badge(`${u.riskCount} 个商机需关注`, "warning") : badge("推进正常", "success")}</span></div><div class="person-target"><span>本季度合同目标 <b>${plainMoney(u.target)}</b></span>${S.actor.role === "admin" ? `<button class="text-link" data-action="target" data-id="${u.id}">调整目标 ${icon("edit")}</button>` : ""}</div></section>`,
      )
      .join("") || empty("暂无销售成员", "请先在设置中添加销售账号。")
  }</div><section class="panel scoring-panel">${sectionHead("过程计分口径", "业务规则取自交接资料，后续按确认后的制度调整")}<div class="scoring-rules"><div><b>线上会议</b><span>每次 0.5 分</span></div><div><b>新增漏斗</b><span>低于 9,800 元：0.5 分<br>9,800–50,000 元：2 分<br>超过 50,000 元：3 分</span></div><div><b>对客报价</b><span>每次 0.5 分</span></div><div><b>现场拜访</b><span>每次 1 分</span></div></div></section>`;
}

export function formTeam(S, type, id, options) {
  if (type === "target") {
    const users = S.users.filter((u) => u.role === "sales" && u.active);
    const target = S.team.find((u) => u.id === Number(id));
    return formShell(
      "设置季度合同目标",
      "系统将季度目标 ÷ 3，折算为月度合同目标。",
      select(
        "user_id",
        "销售",
        users.map((u) => [u.id, u.name]),
        id || users[0]?.id,
      ) +
        input("quarter", "考核季度", S.quarter) +
        input(
          "amount",
          "季度合同额目标（元）",
          target ? target.target / 100 : "",
          "number",
          true,
          'min="0" step="0.01"',
        ),
      type,
      id,
      "保存目标",
    );
  }
}
