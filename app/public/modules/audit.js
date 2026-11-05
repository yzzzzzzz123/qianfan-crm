import { esc, icon, sectionHead, empty } from "../ui.js";

export function auditView(S) {
  const userName=id=>S.users.find(user=>user.id===id)?.name||`用户 #${id}`;
  const rows=S.audit.map(a=>{
    let detail={};try{detail=JSON.parse(a.detail||'{}');}catch{}
    const names={'developer.identity_selected':detail.simulation?'切换模拟身份':'返回本人身份','developer.test_request':'模拟身份操作尝试'};
    const identity=detail.operator_user_id?`<small class="audit-identity">实际登录者：${esc(a.operator_name||userName(detail.operator_user_id))}${detail.acting_as_user_id!==detail.operator_user_id?` · 当前模拟：${esc(a.acting_as_name||userName(detail.acting_as_user_id))}`:''}</small>`:'';
    const request=detail.request_id?`<small class="audit-request" title="请求编号">${esc(detail.request_id)}</small>`:'';
    return `<tr><td><span class="audit-action">${icon('check')}${esc(names[a.action]||a.action)}</span>${detail.stage==='attempt'?`<small class="audit-identity">${esc(detail.method)} ${esc(detail.path)}</small>`:''}${request}</td><td>${esc(a.user_name||'系统')}${identity}</td><td>${esc({customer:'客户',opportunity:'商机',contract:'合同',user:'成员',settings:'规则',system:'系统'}[a.entity]||a.entity)}${a.entity_id?' #'+a.entity_id:''}</td><td class="muted">${new Date(a.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</td></tr>`;
  }).join('');
  return `<section class="panel">${sectionHead('关键操作记录','最近200条；模拟操作记录实际登录者、当前用户和请求编号')}<div class="table-scroll"><table class="data-table"><thead><tr><th>操作</th><th>执行人</th><th>关联对象</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table></div>${S.audit.length?'':empty('还没有操作记录','创建客户或记录跟进后会在这里留下记录。')}</section>`;
}
