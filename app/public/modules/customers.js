import {linkedMinutes} from './minutes.js';
import {
  esc,
  icon,
  plainMoney,
  userName,salesName,
  avatar,
  badge,
  stageBadge,
  actionButton as button,
  sectionHead,
  empty,
  select,
  input,
  textarea,
  formShell,
  isClosedStage,
} from "../ui.js";
import { fieldOwner, filtered, filters, timeline } from "./shared.js";

export function companyProfileDetails(c,canRefresh=false) {
  if(c.shared)return '';
  const p=c.company_profile||{state:'not_read',details:{}},d=p.details||{},job=p.job||{};
  const status=p.state==='not_configured'?'not_configured':p.state==='stale'&&['complete','ready'].includes(job.status)?'stale':job.status||p.state;
  const manualMode=job.manual_only===true||job.error_code==='MANUAL_REQUIRED';
  const busy=status==='running'||!manualMode&&['pending','queued'].includes(status);
  const metadata=p.checked_at?`<span class="muted">读取时间：${esc(profileTime(p.checked_at))}</span>`:'';
  const refresh=canRefresh&&p.can_refresh!==false&&status!=='not_configured'
    ?busy?'<button class="btn ghost" disabled aria-disabled="true">手动查询</button>':button('手动查询','refresh-company-profile',c.id,'ghost','refresh'):'';
  const fields=[['company_name','企业名称'],['credit_code','统一社会信用代码'],['company_description','企业简介'],['company_scale','企业规模'],['employee_scale','人员规模'],['insured_count','参保人数'],['main_business','主营业务'],['main_products','主营产品'],['business_scope','工商经营范围'],['annual_employees','年报从业人数'],['annual_report_year','年报年度'],['industry',['qwen','deepseek'].includes(d._lookup?.field_sources?.industry)?'行业':'企查查行业'],['national_industry','国标行业'],['registered_capital','注册资本'],['registration_status','登记状态'],['established_at','成立时间'],['registered_address','注册地址'],['source_updated_at','来源更新时间']];
  const fieldValue=value=>value===null||value===undefined||value===''?'源接口未提供':Array.isArray(value)?value.join('；'):String(value);
  const sources=(Array.isArray(d._lookup?.sources)?d._lookup.sources:[]).filter(s=>{try{const u=new URL(s.url);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}).slice(0,8);
  const references=sources.length?`<p class="company-profile-meta">查询依据：${sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title||'公开资料')}</a>`).join(' · ')}</p>`:'';
  const hasFacts=fields.some(([key])=>d[key]!==null&&d[key]!==undefined&&d[key]!=='');
  return `<section class="detail-section company-profile" aria-busy="${busy}">${sectionHead('详细信息','',refresh)}${metadata?`<p class="company-profile-meta">${metadata}</p>`:''}${hasFacts?`<dl class="detail-facts">${fields.map(([key,label])=>`<div${['business_scope','company_description','main_products'].includes(key)?' class="wide"':''}><dt>${label}</dt><dd>${esc(fieldValue(d[key]))}${['qwen','deepseek'].includes(d._lookup?.field_sources?.[key])?'<small class="muted"> · AI 整理，待核验</small>':''}</dd></div>`).join('')}</dl>`:''}${references}${hasFacts?'<p class="muted">工商经营范围不等于实际主营业务，参保人数不等于全部员工人数。</p>':''}</section>`;
}

export function companyProfileFeedback(p={}){
  if(['pending','queued','running'].includes(p.job?.status))return {pending:true,message:'正在查询企业资料，完成后会自动更新',error:false};
  if(['qwen','deepseek'].includes(p.details?._lookup?.kind))return {pending:false,message:p.reason||'已转 AI 查询，结果已更新',error:!Object.keys(p.details).some(k=>k!=='_lookup'&&p.details[k]!==null&&p.details[k]!=='')};
  if(p.state==='ready')return {pending:false,message:'企业资料已更新',error:false};
  return {pending:false,message:p.reason||'本次未取得企业资料，请稍后重试',error:true};
}

const profileTime=value=>String(value).replace('T',' ').replace(/(?:\.\d+)?Z$/,' UTC');
const profileCount=value=>Number.isSafeInteger(value)&&value>=0?value:0;

export function companyProfileProgress(S) {
  const p=S.company_profiles;
  if(S.actor?.role!=='admin'||!p)return '';
  const counts=p.counts||{},total=profileCount(counts.total);
  const busy=profileCount(counts.running)>0;
  const action=p.configured&&total>0?(busy?'<button class="btn ghost" disabled aria-disabled="true">手动查询</button>':button('手动查询','query-all-company-profiles','','ghost','refresh')):'';
  return action?`<div class="company-profile-progress">${action}</div>`:'';
}

export function customers(S, P) {
  const list = filtered(S, P, S.customers);
  return `<div class="list-summary customer-list-summary"><span>全部客户 <b>${S.customers.length}</b></span><span>客户主档团队共享，联系信息按归属可见</span>${companyProfileProgress(S)}</div><section class="panel">${filters(S, P, "customers")}${list.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>客户名称</th><th>联系人</th><th>行业 / 地区</th><th>手动等级</th><th>负责人</th><th>客户状态</th><th>进行中商机</th></tr></thead><tbody>${list.map((c) => `<tr class="record-row" tabindex="0" data-action="customer" data-id="${c.id}" aria-label="查看${esc(c.name)}的客户档案"><td><div class="company-cell"><span class="company-symbol">${esc((c.short_name || c.name).slice(0, 1))}</span><div><span class="record-title">${esc(c.name)}</span><span class="record-meta">${esc(c.short_name || "未设置简称")}${c.shared ? " · 共享主档" : ""}</span></div></div></td><td>${c.shared?"按权限可见":S.contacts.filter(p=>p.customer_id===c.id&&!p.archived_at).map(p=>`<span class="customer-contact"><b>${esc(p.name)}</b><small>${esc(p.phone||p.title||"")}</small></span>`).join("")||"—"}</td><td>${esc(c.industry || "未设置")}<span class="record-meta">${esc(c.region || "未设置地区")}</span></td><td>${(S.actor.role==='admin'||c.owner_id===S.actor.id)?`<button class="text-link" data-action="customer-level" data-id="${c.id}">${esc(c.manual_level||'未标注')}</button>`:badge(c.manual_level||'未标注','blue')}</td><td><span class="owner-cell">${avatar(salesName(S,c), true)}${esc(salesName(S,c))}</span></td><td>${badge(c.status, c.status === "成交" ? "success" : c.status === "潜在" ? "blue" : "neutral")}</td><td>${c.shared ? '<span class="muted">按权限可见</span>' : S.opportunities.filter((o) => o.customer_id === c.id && !isClosedStage(o.stage)).length + " 个"}</td></tr>`).join("")}</tbody></table></div>` : empty()}<div class="table-footer">共 ${list.length} 位客户<span></span></div></section>`;
}

export function customerDetail(S, id) {
  const c = S.customers.find((c) => c.id === Number(id));
  if (!c) return empty("客户不存在");
  const own = S.actor.role === "admin" || c.owner_id === S.actor.id;
  const contacts = S.contacts.filter((x) => x.customer_id === c.id);
  const opps = S.opportunities.filter((o) => o.customer_id === c.id);
  return `<header class="dialog-head"><div><span class="detail-type">客户档案 ${badge(c.manual_level || "未标注", "blue")}</span><h2>${esc(c.name)}</h2><p>${esc(c.industry || "未分类")} · ${esc(c.region || "未设置地区")}</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon("close")}</button></header><div class="drawer-body"><div class="detail-actionbar">${own ? button("编辑画像", "edit-customer", c.id, "secondary", "edit") + button("新建商机", "new-opportunity", c.id, "primary", "plus") : badge("共享主档 · 联系信息按归属可见")}</div><dl class="detail-facts"><div><dt>负责人</dt><dd>${esc(salesName(S,c))}</dd></div><div><dt>母公司 / 集团</dt><dd>${esc(c.parent_company||"未填写")} / ${esc(c.group_name||"未填写")}</dd></div><div><dt>客户状态</dt><dd>${badge(c.status, c.status === "成交" ? "success" : "blue")}</dd></div>${!c.shared ? `<div><dt>客户规模</dt><dd>${esc(c.scale || "待补充")}</dd></div><div><dt>信用代码</dt><dd>${esc(c.credit_code || "待补充")}</dd></div>` : ""}</dl>${companyProfileDetails(c,own)}${c.shared ? "" : `<section class="detail-section">${sectionHead("联系人与决策链", "", S.actor.role!=="pm"?button("添加联系人", "new-contact", c.id, "ghost", "plus"):"")}<div class="contact-list">${contacts.map((p) => `<div class="contact-item">${avatar(p.name, true)}<div><b>${esc(p.name)} <span>${esc(p.title)}</span></b><p>${esc(p.phone || "未填写电话")}</p><p>${esc([p.wechat&&"微信："+p.wechat,p.dingtalk&&"钉钉："+p.dingtalk,p.last_contact&&"最近联系："+p.last_contact].filter(Boolean).join(" · "))}</p></div>${p.archived_at?badge("已停用"):badge(p.role,p.role==="决策人"?"blue":"neutral")}${badge(p.attitude,p.attitude==="支持"?"success":"neutral")}${own?button("维护","edit-contact",p.id,"ghost","edit"):""}</div>`).join("") || '<p class="muted">暂无联系人。</p>'}</div></section>`}<section class="detail-section">${sectionHead("关联商机", `${opps.length} 个商机`)}${opps.map((o) => `<button class="linked-record" data-action="opportunity" data-id="${o.id}"><span><b>${esc(o.name)}</b><small>${plainMoney(o.amount)} · ${esc(o.next_action)}</small></span>${stageBadge(o.stage)}${icon("chevron")}</button>`).join("") || '<p class="muted">暂无可见的关联商机。</p>'}</section>${!c.shared&&S.actor.role!=='pm'?linkedMinutes('customer',c.id):''}${!c.shared ? `<section class="detail-section"><h3>客户备注</h3><p class="prose">${esc(c.note || "暂无备注")}</p></section><section class="detail-section">${sectionHead("客户沟通记录")}${timeline(S, S.activities.filter((a) => opps.some((o) => o.id === a.opportunity_id)).slice(0, 12), false)}</section>` : ""}</div>`;
}

export function formCustomers(S, type, id, options) {
  if(type==='customer-level') {const c=S.customers.find(c=>c.id===Number(id));if(!c)return empty('客户不存在');return formShell('标注客户等级',c.name,select('manual_level','手动等级',[['','未标注'],...[...new Set([...(S.rules.customer_levels||[]),...(c.manual_level?[c.manual_level]:[])])].map(v=>[v,v])],c.manual_level||'',false),type,id,'保存等级');}
  if (type === "customer" || type === "edit-customer") {
    const c = S.customers.find((c) => c.id === Number(id)) || {};
    return formShell(
      type === "customer" ? "新建客户" : "编辑客户档案",
      "",
      input("name", "客户全称", c.name || "") +
        (type==='customer'?'<div class="wide" id="duplicate-hints"></div><label class="wide field-help"><input type="checkbox" name="duplicate_ack"> 已核对疑似同名档案，确为不同企业时允许新建</label>':'')+
        input('parent_company','母公司',c.parent_company||'','text',false)+
        input('group_name','所属集团',c.group_name||'','text',false)+
        input('tags','企业标签',c.tags||'','text',false)+
        input('compliance_flag','流程 / 风险标记',c.compliance_flag||'','text',false)+
        input("short_name", "客户简称", c.short_name || "", "text", false) +
        input("industry", "行业", c.industry || "", "text", false) +
        input("region", "地区", c.region || "", "text", false) +
        select("manual_level", "客户等级（手动标注）", [["","未标注"],...[...new Set([...(S.rules.customer_levels||["A","B","C"]),...(c.manual_level?[c.manual_level]:[])])].map(v=>[v,v])], c.manual_level || "", false) +
        (S.actor.role === "admin" ? fieldOwner(S, c.owner_id, type==='edit-customer' && c.owner_id===null) : `<input type="hidden" name="owner_id" value="${S.actor.id}"><p class="wide form-context">负责人：${esc(S.actor.name)}</p>`) +
        input("scale", "客户规模", c.scale || "", "text", false) +
        input(
          "credit_code",
          "统一社会信用代码",
          c.credit_code || "",
          "text",
          false,
        ) +
        (type === "edit-customer"
          ? select(
              "status",
              "客户状态",
              ["潜在", "成交", "流失", "冻结"],
              c.status,
            )
          : "") +
        (type === "edit-customer" && S.actor.role === "admin"
          ? input("reason", "调整归属原因（改负责人时必填）", "", "text", false)
          : "") +
        textarea("note", "客户备注", c.note || ""),
      type,
      id,
      type === "customer" ? "创建客户" : "保存档案",
    );
  }
  if (type === "contact" || type === 'edit-contact') {
    const p = type==='edit-contact' ? S.contacts.find(p=>p.id===Number(id)) || {} : {};
    return formShell(
      type==='edit-contact' ? '维护联系人' : "添加联系人",
      "",
      (type==='contact'?select('customer_id','关联客户',[['','请选择客户'],...options.customerOptions],id||'','required'):'')+
      input("name", "姓名",p.name||'') +
        input("title", "职位",p.title||'', "text", false) +
        input("phone", "电话",p.phone||'', "tel", false) +
        input('wechat','微信',p.wechat||'','text',false)+input('dingtalk','钉钉',p.dingtalk||'','text',false)+'<p class="wide field-help">电话、微信、钉钉至少填写一项。</p>'+input('last_contact','最近触达',p.last_contact||'','date',false)+
        select("role", "决策角色", ["决策人", "影响者", "使用人", "把关人", '我方PM'],p.role||'使用人') +
        select("attitude", "当前态度", ["中立", "支持", "反对"],p.attitude||'中立') +
        (type==='edit-contact'?select('active','联系状态',[['true','在用'],['false','停用（保留历史）']],p.archived_at?'false':'true'):'')+
        textarea("note", "备注",p.note||''),
      type,
      id,
      type==='edit-contact' ? '保存联系人' : "添加联系人",
    );
  }
}
