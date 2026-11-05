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
  const matchingEvents=new Set((S.activityEvents||[]).filter(e=>e.activity_type===P.source||e.source===P.source).map(e=>e.activity_id));
  const list = S.activities.filter(a=>!P.source||a.source===P.source||a.sources?.includes(P.source)||a.activity_type===P.source||matchingEvents.has(a.id));
  return `<div class="activity-layout"><section class="panel"><div class="filterbar"><div class="segment">${[
    ["", "全部记录"],
    ["AI听记", "AI听记"],
    ["手动", "手动采集"],
    ["手动跟进", "手动跟进"],
    ["线上会议", "线上会议"],
    ["现场拜访", "现场拜访"],
    ["对客报价", "对客报价"],
    ["晚会复盘", "晚会复盘"],
    ["系统里程碑", "系统"],
  ]
    .map(
      ([id, label]) =>
        `<button data-action="source-filter" data-id="${id}" class="${P.source === id ? "selected" : ""}">${label}</button>`,
    )
    .join(
      "",
    )}</div></div><div class="timeline-padding">${timeline(S, list)}</div></section><aside class="activity-aside"><h3>跟进说明</h3><ul><li>同一人同日对同一商机的记录合并展示，原始记录保留。</li><li>会议、拜访按原始记录计入过程绩效。</li></ul></aside></div>`;
}

export function formActivities(S, type, id, options) {
  const { oppOptions } = options;
  if (type === "activity") {
    const o = S.opportunities.find((o) => o.id === Number(id));
    return formShell(
      "记录一次跟进",
      "",
      select(
        "opportunity_id",
        "关联商机",
        [["", "请选择关联商机"], ...oppOptions],
        id || "",
        "required",
      ) +
        select("activity_type", "跟进类型", [
          "手动跟进",
          "线上会议",
          "现场拜访",
          "对客报价",
          "晚会复盘",
        ]) +
        select('source','内容来源',['手动','AI听记','晚会复盘'],'手动')+
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
