import {
  icon,
  actionButton as button,
  select,
  input,
  textarea,
  formShell,
} from "../ui.js";
import { timeline } from "./shared.js";

export function activities(S, P) {
  const list = S.activities.filter((a) => !P.source || a.source === P.source);
  return `<div class="activity-layout"><section class="panel"><div class="filterbar"><div class="segment">${[
    ["", "全部记录"],
    ["手动跟进", "手动跟进"],
    ["线上会议", "线上会议"],
    ["现场拜访", "现场拜访"],
    ["晚会复盘", "晚会复盘"],
    ["系统里程碑", "系统"],
  ]
    .map(
      ([id, label]) =>
        `<button data-action="source-filter" data-id="${id}" class="${P.source === id ? "selected" : ""}">${label}</button>`,
    )
    .join(
      "",
    )}</div></div><div class="timeline-padding">${timeline(S, list)}</div></section><aside class="activity-aside"><h3>让跟进形成闭环</h3><p>沟通说清进展，行动写清下一步，约定具体跟进时间。</p><ul><li>同一商机、同一天、同类型的跟进会归并保存。</li><li>线上会议和现场拜访会进入过程绩效统计。</li><li>人工记录、系统里程碑与规则建议明确区分。</li></ul><div class="connection-note">${icon("link")}<b>钉钉 AI 听记待接入</b><p>应用配置完成后，再联调自动采集。</p></div></aside></div>`;
}

export function formActivities(S, type, id, options) {
  const { oppOptions } = options;
  if (type === "activity") {
    const o = S.opportunities.find((o) => o.id === Number(id));
    return formShell(
      "记录一次跟进",
      "写清进展与结论，再约定下一步。",
      select(
        "opportunity_id",
        "关联商机",
        oppOptions,
        id || oppOptions[0]?.[0],
      ) +
        select("activity_type", "跟进类型", [
          "手动跟进",
          "线上会议",
          "现场拜访",
          "晚会复盘",
        ]) +
        input(
          "activity_date",
          "发生日期",
          S.today,
          "date",
          true,
          `max="${S.today}"`,
        ) +
        textarea("summary", "沟通内容与结论", "", true) +
        textarea("action", "下一步动作", o?.next_action || "") +
        input(
          "follow_date",
          "下次跟进日期",
          o?.follow_date || S.today,
          "date",
          false,
        ),
      type,
      id,
      "保存跟进",
    );
  }
}
