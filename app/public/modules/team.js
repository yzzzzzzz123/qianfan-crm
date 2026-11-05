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

export { performance as team } from './incentives.js';

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
