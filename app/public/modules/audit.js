import { esc, icon, sectionHead, empty, plainMoney } from "../ui.js";
import {fieldNames} from './intake-schema.js';

const labels={...fieldNames,customer_id:'关联客户',owner_id:'销售归属',product_amount:'产品回款金额',pay_date:'实际到账日期',promise_date:'预计回款日期',created_at:'创建时间',contract_id:'关联合同',lifecycle:'合同阶段'};
const moneyKeys=new Set(['amount','product_amount','margin']);
function valueLabel(S,key,value){
 if(value===null||value===undefined||value==='')return '未填写';
 if(moneyKeys.has(key)&&typeof value==='number')return plainMoney(value);
 if(['owner_id','collaborator_pm','user_id'].includes(key))return S.users.find(u=>u.id===Number(value))?.name||`成员 #${value}`;
 if(key==='customer_id')return S.customers?.find(c=>c.id===Number(value))?.name||`客户 #${value}`;
 if(key==='contract_id'){const c=S.contracts?.find(c=>c.id===Number(value));return c?`${c.contract_no||c.code} · ${c.name}`:`合同 #${value}`;}
 return typeof value==='object'?JSON.stringify(value):String(value);
}
export function auditChanges(S,detail){
 const changes=[];
 const normalized=value=>value===undefined||value===''?null:value;
 const compare=(before,after,prefix='')=>{
  if(!after||typeof after!=='object')return;
  for(const [key,value] of Object.entries(after)){
   if(!Object.hasOwn(labels,key)||key==='reason'||value!==null&&typeof value==='object'||JSON.stringify(normalized(before?.[key]))===JSON.stringify(normalized(value)))continue;
   changes.push(`<li><b>${esc(prefix+(labels[key]||key))}</b><span>${esc(valueLabel(S,key,before?.[key]))} → ${esc(valueLabel(S,key,value))}</span></li>`);
  }
 };
 const prefix=detail.payment_id?`回款 #${detail.payment_id} · `:detail.item_id?`明细 #${detail.item_id} · `:'';
 if(detail.before||detail.after)compare(detail.before,detail.after||detail,prefix);
 for(const item of Array.isArray(detail.items)?detail.items:[])compare(item.before,item.after,`明细 #${item.id} · `);
 if(!changes.length&&!detail.reason)return '';
 return `<details class="audit-detail"><summary>查看修改${changes.length?`（${changes.length}项）`:''}</summary>${detail.reason?`<p><b>变更原因：</b>${esc(detail.reason)}</p>`:''}${changes.length?`<ul>${changes.join('')}</ul>`:''}</details>`;
}

export function auditView(S) {
  const userName=id=>S.users.find(user=>user.id===id)?.name||`用户 #${id}`;
  const rows=S.audit.map(a=>{
    let detail={};try{const parsed=JSON.parse(a.detail||'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))detail=parsed;}catch{}
    const names={'developer.identity_selected':detail.simulation?'切换模拟身份':'返回本人身份','developer.test_request':'模拟身份操作尝试'};
    const identity=detail.operator_user_id?`<small class="audit-identity">实际登录者：${esc(a.operator_name||userName(detail.operator_user_id))}${detail.acting_as_user_id!==detail.operator_user_id?` · 当前模拟：${esc(a.acting_as_name||userName(detail.acting_as_user_id))}`:''}</small>`:'';
    const request=detail.request_id?`<small class="audit-request" title="请求编号">${esc(detail.request_id)}</small>`:'';
    return `<tr><td><span class="audit-action">${icon('check')}${esc(names[a.action]||a.action)}</span>${detail.stage==='attempt'?`<small class="audit-identity">${esc(detail.method)} ${esc(detail.path)}</small>`:''}${request}${auditChanges(S,detail)}</td><td>${esc(a.user_name||'系统')}${identity}</td><td>${esc({customer:'客户',opportunity:'商机',contract:'合同',user:'成员',settings:'规则',system:'系统'}[a.entity]||a.entity)}${a.entity_id?' #'+a.entity_id:''}</td><td class="muted">${new Date(a.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</td></tr>`;
  }).join('');
  return `<section class="panel">${sectionHead('关键操作记录','最近200条，包含销售合同与回款修改；展开查看变更原因及修改前后内容')}<div class="table-scroll"><table class="data-table"><thead><tr><th>操作 / 修改内容</th><th>执行人</th><th>关联对象</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table></div>${S.audit.length?'':empty('还没有操作记录','创建客户或记录跟进后会在这里留下记录。')}</section>`;
}
