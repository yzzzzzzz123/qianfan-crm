import { api, setCsrf } from "./api.js";
import {
  esc,
  icon,
  avatar,
  plainMoney,
  empty,
  actionButton as button,
} from "./ui.js";
import {
  shell,
  renderPage,
  pages,
  customerDetail,
  opportunityDetail,
  contractDetail,
  formContent,
  contractItemRow,
  filtered,
  timeline,
} from "./views.js";

let S = null;
let current = "workbench";
const routeState = {};
let panel = null;
let formReturn = null;
let searchTimer;
let toastTimer;
const dialog = document.querySelector("#dialog");
const getP = () =>
  routeState[current] ||
  (routeState[current] = {
    view: current,
    q: "",
    owner: "",
    stage: "",
    level: "",
    risk: "",
    source: "",
    sort: "",
    desc: false,
    tab: "members",
  });
const toast = (msg, error = false) => {
  const el = document.querySelector("#toast");
  el.className = error ? "error visible" : "visible";
  el.innerHTML = icon(error ? "alert" : "check") + `<span>${esc(msg)}</span>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 4500);
};
function content() {
  document.querySelector("#content").innerHTML = renderPage(S, getP());
  document.title = `千帆 CRM · ${pages[current][0]}`;
}
function render() {
  document.querySelector("#app").innerHTML = shell(S, current);
  content();
}
async function reload() {
  S = await api("/state");
  render();
}
function openHtml(html, drawer = false) {
  dialog.className = drawer ? "drawer" : "form-dialog";
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function openPanel(type, id) {
  panel = { type, id: Number(id) };
  formReturn = null;
  const html = {
    customer: customerDetail,
    opportunity: opportunityDetail,
    contract: contractDetail,
  }[type](S, id);
  openHtml(html, true);
}
function openForm(type, id = "") {
  formReturn = panel;
  openHtml(formContent(S, type, id), false);
}
function close() {
  if (formReturn) {
    const p = formReturn;
    formReturn = null;
    openPanel(p.type, p.id);
  } else {
    dialog.close();
    panel = null;
  }
}
function navigate(view, filters = {}) {
  if (current !== view) {
    current = view;
    getP();
  }
  Object.assign(getP(), filters);
  if (location.hash.slice(1) !== view) location.hash = view;
  else render();
}
async function showLogin(message = "") {
  panel = null;
  formReturn = null;
  if (dialog.open) dialog.close();
  const options = await api("/auth/options");
  S = null;
  document.querySelector("#app").innerHTML =
    `<main class="login-screen"><section class="login-story"><span class="login-brand"><span class="brand-crop"><img src="/assets/brand.png" alt="千帆创科"></span><b>CRM</b></span><div class="login-story-copy"><h1>客户与销售工作，<br>在这里有序推进。</h1><p>从客户建档到合同回款，<br>保留每一次沟通，明确每一步行动。</p><div class="login-process"><span>客户</span>${icon("arrow")}<span>商机</span>${icon("arrow")}<span>合同</span>${icon("arrow")}<span>回款</span></div></div><span class="login-caption">千帆创科 · 销售协同工作区</span></section><section class="login-main"><div class="login-box"><h2>进入千帆 CRM</h2><p>${options.demo ? "选择演示身份，体验完整业务流程。" : "请使用管理员分配的账号登录。"}</p>${message ? `<p class="form-error">${esc(message)}</p>` : ""}${options.demo ? `<div class="demo-logins">${options.users.map((u) => `<button data-action="demo-login" data-id="${u.id}">${avatar(u.name)}<span><b>${esc(u.name)}</b><small>${u.role === "admin" ? "管理员 · 团队业务全览" : "销售 · 本人客户与商机"}</small></span>${icon("arrow")}</button>`).join("")}</div><div class="login-note">${icon("shield")}<span>独立浏览器试用，数据保存在当前浏览器。<br>示例客户和金额不代表真实业务。</span></div><details class="local-login"><summary>使用账号密码登录</summary>` : ""}<form data-form="login"><label class="field">账号<input name="username" required autocomplete="username" placeholder="输入登录账号"></label><label class="field">密码<input name="password" type="password" required autocomplete="current-password" placeholder="输入密码"></label><p class="form-error" role="alert"></p><button class="btn primary full-width" type="submit">登录工作区 ${icon("arrow")}</button></form>${options.demo ? "</details>" : ""}<p class="login-bottom">钉钉身份登录待应用配置后接入</p></div></section></main>`;
}
async function login(body) {
  const a = await api("/auth/login", { method: "POST", body });
  setCsrf(a.csrf);
  current = Object.hasOwn(pages, location.hash.slice(1))
    ? location.hash.slice(1)
    : "workbench";
  await reload();
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action,
    id = el.dataset.id;
  if (action === "noop") return;
  try {
    if (action === "demo-login") {
      el.disabled = true;
      try {
        await login({ demo_user_id: Number(id) });
      } finally {
        el.disabled = false;
      }
      return;
    }
    if (action === "close") {
      close();
      return;
    }
    if (action === "menu") {
      document.querySelector("#sidebar").classList.toggle("open");
      return;
    }
    if (action === "reload") {
      el.disabled = true;
      await reload();
      toast("数据已刷新");
      return;
    }
    if (["customer", "opportunity", "contract"].includes(action)) {
      openPanel(action, id);
      return;
    }
    const forms = {
      "new-customer": "customer",
      "edit-customer": "edit-customer",
      "new-contact": "contact",
      "new-opportunity": "opportunity",
      "edit-opportunity": "edit-opportunity",
      "new-activity": "activity",
      "new-quote": "quote",
      "new-contract": "contract",
      convert: "convert",
      "new-payment": "payment",
      "edit-contract": "edit-contract",
      "edit-item": "edit-item",
      "receive-payment": "receive-payment",
      target: "target",
      "new-user": "user",
      "edit-rules": "rules",
    };
    if (forms[action]) {
      openForm(forms[action], id);
      return;
    }
    if (action === "stage-filter") {
      navigate("opportunities", { stage: id, risk: "", q: "", owner: "" });
      return;
    }
    if (action === "due-filter") {
      navigate("opportunities", { risk: "today", stage: "", q: "", owner: "" });
      return;
    }
    if (action === "risk-filter") {
      getP().risk = id;
      content();
      return;
    }
    if (action === "reset-filters") {
      Object.assign(getP(), {
        q: "",
        owner: "",
        stage: "",
        level: "",
        risk: "",
        sort: "",
      });
      content();
      return;
    }
    if (action === "source-filter") {
      getP().source = id;
      content();
      return;
    }
    if (action === "settings-tab") {
      getP().tab = id;
      content();
      return;
    }
    if (action === "sort") {
      const P = getP();
      P.desc = P.sort === id ? !P.desc : true;
      P.sort = id;
      content();
      return;
    }
    if (action === "add-item") {
      const rows = dialog.querySelectorAll(".item-row");
      if (rows.length >= 30) {
        toast("最多添加30个行项", true);
        return;
      }
      dialog
        .querySelector("#contract-items")
        .insertAdjacentHTML("beforeend", contractItemRow(S, rows.length));
      return;
    }
    if (action === "remove-item") {
      if (dialog.querySelectorAll(".item-row").length <= 1) {
        toast("至少保留一个合同行项", true);
        return;
      }
      el.closest(".item-row").remove();
      return;
    }
    if (action === "account") {
      panel = null;
      openHtml(
        `<header class="dialog-head"><div><h2>当前账号</h2><p>${esc(S.actor.name)} · ${S.actor.role === "admin" ? "管理员" : "销售"}</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="dialog-body"><p>这是浏览器内的演示身份，可切换角色检查业务流程。</p>${S.demo ? '<p class="muted">退出后可以选择其他演示身份，检查不同角色的数据范围。</p>' : ""}</div><footer class="dialog-footer">${button("关闭", "close", "", "ghost")}${button(S.demo ? "退出并切换身份" : "退出登录", "logout", "", "secondary", "logout")}</footer>`,
      );
      return;
    }
    if (action === "logout") {
      await api("/auth/logout", { method: "POST", body: {} });
      setCsrf("");
      await showLogin();
      return;
    }
    if (action === "export") {
      exportList();
      return;
    }
    if (action === "toggle-user") {
      const u = S.users.find((u) => u.id === Number(id));
      panel = null;
      openHtml(
        `<form data-form="toggle-user" data-id="${u.id}" data-key="${crypto.randomUUID()}"><header class="dialog-head"><div><h2>${u.active ? "停用" : "启用"} ${esc(u.name)}</h2><p>${u.active ? "停用后，该成员的现有登录会话立即失效，业务记录保留。" : "启用后，该成员可以再次登录。"}</p></div><button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="dialog-body"><p class="form-error" role="alert"></p></div><footer class="dialog-footer"><button type="button" class="btn ghost" data-action="close">取消</button><button class="btn ${u.active ? "danger" : "primary"}" type="submit">确认${u.active ? "停用" : "启用"}</button></footer></form>`,
      );
      return;
    }
    if (action === "person-evidence") {
      const u = S.users.find((u) => u.id === Number(id));
      const kind = el.dataset.kind;
      const ownOpp = S.opportunities.filter((o) => o.owner_id === u.id);
      const oppIds = new Set(ownOpp.map((o) => o.id));
      const rows =
        kind === "新增漏斗"
          ? ownOpp.filter((o) => o.created_at.startsWith(S.period))
          : kind === "对客报价"
            ? S.quotes.filter(
                (q) => q.user_id === u.id && q.created_at.startsWith(S.period),
              )
            : S.activities.filter(
                (a) =>
                  oppIds.has(a.opportunity_id) &&
                  a.activity_type === kind &&
                  a.activity_date.startsWith(S.period),
              );
      panel = null;
      openHtml(
        `<header class="dialog-head"><div><h2>${esc(u.name)} · ${esc(kind)}</h2><p>${S.period} · ${rows.length} 条计分依据</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="drawer-body">${
          kind === "线上会议" || kind === "现场拜访"
            ? timeline(S, rows)
            : rows
                .map((r) => {
                  const o =
                    kind === "新增漏斗"
                      ? r
                      : S.opportunities.find((o) => o.id === r.opportunity_id);
                  return `<button class="linked-record" data-action="opportunity" data-id="${o.id}"><span><b>${esc(o.name)}</b><small>${plainMoney(r.amount)}</small></span>${icon("chevron")}</button>`;
                })
                .join("") ||
              empty("本月暂无该项记录", "真实业务记录会自动进入过程统计。")
        }</div>`,
        true,
      );
      return;
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const type = form.dataset.form,
    id = Number(form.dataset.id);
  const b = Object.fromEntries(new FormData(form));
  const submit = form.querySelector("[type=submit]");
  const label = submit.innerHTML;
  const error = form.querySelector(".form-error");
  error.textContent = "";
  submit.disabled = true;
  submit.innerHTML = '<span class="loader mini"></span> 正在保存…';
  try {
    if (type === "login") {
      await login(b);
      return;
    }
    let path = "",
      method = "POST",
      body = b;
    let returnTo = formReturn;
    if (type === "customer") path = "/customers";
    if (type === "edit-customer") {
      path = "/customers/" + id;
      method = "PATCH";
    }
    if (type === "contact") {
      path = "/contacts";
      body.customer_id = id;
    }
    if (type === "opportunity") path = "/opportunities";
    if (type === "edit-opportunity") {
      path = "/opportunities/" + id;
      method = "PATCH";
    }
    if (type === "activity") path = "/activities";
    if (type === "quote") {
      path = "/quotes";
      body.opportunity_id = id;
    }
    if (type === "contract" || type === "convert") {
      path = "/contracts";
      if (type === "convert") body.opportunity_id = id;
      body.items = [...form.querySelectorAll(".item-row")].map((row) =>
        Object.fromEntries(
          [...row.querySelectorAll("[data-field]")].map((i) => [
            i.dataset.field,
            i.value,
          ]),
        ),
      );
    }
    if (type === "payment") {
      path = "/payments";
      body.contract_id = id;
    }
    if (type === "receive-payment") path = "/payments/" + id + "/receive";
    if (type === "edit-contract") {
      path = "/contracts/" + id;
      method = "PATCH";
    }
    if (type === "edit-item") {
      path = "/items/" + id;
      method = "PATCH";
      const i = S.contracts.flatMap((c) => c.items).find((i) => i.id === id);
      if (Number(body.margin) === i.margin / 100) delete body.margin;
    }
    if (type === "target") path = "/targets";
    if (type === "user") path = "/users";
    if (type === "toggle-user") {
      path = "/users/" + id;
      method = "PATCH";
      body = { active: !S.users.find((u) => u.id === id).active };
    }
    if (type === "rules") {
      path = "/rules";
      method = "PATCH";
      body = { thresholds: {}, sop: {} };
      for (const [k, v] of Object.entries(b)) {
        if (k.startsWith("threshold:"))
          body.thresholds[k.slice(10)] = Number(v);
        if (k.startsWith("sop:")) body.sop[k.slice(4)] = v;
      }
    }
    const result = await api(path, { method, body, key: form.dataset.key });
    dialog.close();
    panel = null;
    formReturn = null;
    try {
      await reload();
    } catch (err) {
      toast("保存已成功，但列表刷新失败；请点击刷新重新读取。", true);
      return;
    }
    if (type === "customer") returnTo = { type: "customer", id: result.id };
    if (type === "opportunity")
      returnTo = { type: "opportunity", id: result.id };
    if (type === "contract" || type === "convert")
      returnTo = { type: "contract", id: result.id };
    if (returnTo) openPanel(returnTo.type, returnTo.id);
    toast(result.message || "已保存");
  } catch (err) {
    error.textContent = err.message;
    error.scrollIntoView({ block: "nearest" });
  } finally {
    submit.disabled = false;
    submit.innerHTML = label;
  }
});

document.addEventListener("change", (e) => {
  if (!S) return;
  const map = {
    "filter-owner": "owner",
    "filter-stage": "stage",
    "filter-level": "level",
  };
  if (map[e.target.id]) {
    getP()[map[e.target.id]] = e.target.value;
    content();
  }
});
document.addEventListener("input", (e) => {
  if (!S) return;
  if (e.target.id === "list-search") {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => {
      getP().q = value;
      content();
      const input = document.querySelector("#list-search");
      input.focus();
      input.setSelectionRange(value.length, value.length);
    }, 180);
  }
  if (e.target.id === "global-search") {
    const q = e.target.value.trim().toLowerCase();
    const area = document.querySelector("#search-results");
    if (!q) {
      area.hidden = true;
      return;
    }
    const records = [
      ...S.customers.map((c) => ({
        type: "customer",
        label: "客户",
        id: c.id,
        name: c.name,
        meta: c.industry,
      })),
      ...S.opportunities.map((o) => ({
        type: "opportunity",
        label: "商机",
        id: o.id,
        name: o.name,
        meta: o.code,
      })),
      ...S.contracts.map((c) => ({
        type: "contract",
        label: "合同",
        id: c.id,
        name: c.name,
        meta: c.code,
      })),
    ]
      .filter((r) => (r.name + r.meta).toLowerCase().includes(q))
      .slice(0, 9);
    area.hidden = false;
    area.innerHTML = records.length
      ? records
          .map(
            (r) =>
              `<button data-action="${r.type}" data-id="${r.id}"><span class="search-type">${r.label}</span><span><b>${esc(r.name)}</b><small>${esc(r.meta)}</small></span>${icon("chevron")}</button>`,
          )
          .join("")
      : '<p class="search-empty">没有找到匹配记录</p>';
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".global-search")) {
    const results = document.querySelector("#search-results");
    if (results) results.hidden = true;
  }
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) &&
    !dialog.open
  ) {
    e.preventDefault();
    document.querySelector("#global-search")?.focus();
  }
  if (e.key === "Escape") {
    const r = document.querySelector("#search-results");
    if (r) r.hidden = true;
  }
});
dialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  close();
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      close();
  }
});
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  current = Object.hasOwn(pages, view) ? view : "workbench";
  if (S) {
    if (dialog.open) dialog.close();
    panel = null;
    formReturn = null;
    render();
    window.scrollTo(0, 0);
  }
});

function exportList() {
  const P = getP();
  const type = P.view;
  let rows;
  if (type === "customers")
    rows = [
      ["客户名称", "简称", "行业", "地区", "等级", "负责人", "状态"],
      ...filtered(S, P, S.customers).map((c) => [
        c.name,
        c.short_name,
        c.industry,
        c.region,
        c.level,
        S.users.find((u) => u.id === c.owner_id)?.name,
        c.status,
      ]),
    ];
  else if (type === "contracts")
    rows = [
      [
        "合同编号",
        "合同名称",
        "合同金额(元)",
        "已到账(元)",
        "待回款(元)",
        "签约日期",
      ],
      ...filtered(S, P, S.contracts).map((c) => [
        c.code,
        c.name,
        c.amount / 100,
        c.collected / 100,
        c.outstanding / 100,
        c.sign_date,
      ]),
    ];
  else return;
  const cell = (v) => {
    let value = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(value)) value = "'" + value;
    return '"' + value.replaceAll('"', '""') + '"';
  };
  const blob = new Blob(
    ["\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `千帆CRM-${pages[type][0]}-${S.today}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("台账已导出");
}

try {
  const me = await api("/auth/me");
  setCsrf(me.csrf);
  current = Object.hasOwn(pages, location.hash.slice(1))
    ? location.hash.slice(1)
    : "workbench";
  await reload();
} catch (e) {
  try {
    await showLogin(e.status === 401 ? "" : e.message);
  } catch (err) {
    document.querySelector("#app").innerHTML =
      `<main class="boot">${icon("alert")}<h2>暂时无法连接工作区</h2><p>${esc(err.message)}</p><button class="btn primary" data-action="reload-app">重新连接</button></main>`;
    document
      .querySelector("[data-action=reload-app]")
      .addEventListener("click", () => location.reload());
  }
}
