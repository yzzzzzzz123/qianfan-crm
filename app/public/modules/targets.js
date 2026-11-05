import {esc,plainMoney,badge,sectionHead,select,input,empty,formShell} from '../ui.js';

export const quarterOf=month=>/^\d{4}-(0[1-9]|1[0-2])$/.test(month||'')?`${month.slice(0,4)}Q${Math.ceil(Number(month.slice(5,7))/3)}`:'';
const sales=S=>S.users.filter(u=>u.active&&u.role==='sales');
export function targetForm(S,id,selectedQuarter) {
  if(S.actor.role!=='admin')return empty('无权设置季度目标','仅管理员可以设置季度目标。');
  const users=sales(S);if(!users.length)return empty('暂无在用销售成员','添加销售成员后再设置目标。');
  const userId=users.some(u=>u.id===Number(id))?Number(id):'';
  const q=selectedQuarter||quarterOf(S.period)||S.quarter;
  return formShell('设置季度目标','月目标 = 季度目标 ÷ 3。',
    `<div class="wide">${select('user_id','销售成员',[['','请选择销售'],...users.map(u=>[u.id,u.name])],userId,'required')}</div>`+
    input('quarter','季度',q,'text',true,'pattern="[0-9]{4}Q[1-4]" maxlength="6" placeholder="2026Q4"')+
    input('amount','季度合同额目标（元）','','number',true,'min="0.01" max="9999999999" step="0.01"')+
    '<p class="wide form-context" data-target-hint aria-live="polite">已有目标会自动带出；修改后保存即可。</p>', 'target',userId,'保存目标');
}
export function syncTargetForm(form,S) {
  const userId=Number(form.elements.user_id.value),q=form.elements.quarter.value.trim().toUpperCase();
  form.elements.quarter.value=q;
  const row=(S.targets||[]).find(t=>t.user_id===userId&&t.quarter===q),locked=!!row?.locked;
  form.elements.amount.value=row?String(row.amount/100):'';
  form.elements.amount.disabled=locked;
  form.querySelector('[type="submit"]').disabled=locked;
  form.querySelector('[data-target-hint]').textContent=locked?`该季度 ${row.locked_months.join('、')} 的绩效已确认，目标已锁定。`:!userId?'请选择销售成员。':row?'已带出该销售本季度的目标，修改金额后保存。':'该销售本季度尚未设置目标，请填写实际目标金额。';
}
export function targetsPanel(S,P) {
  if(S.actor.role!=='admin')return '';
  const options=new Set([S.quarter,...(S.targets||[]).map(t=>t.quarter).filter(q=>/^\d{4}Q[1-4]$/.test(q)&&q<=S.quarter)]);
  const year=Number(S.quarter.slice(0,4));
  // 保留原有的 2024 年起历史范围，跨年时只追加季度。
  for(let y=Math.min(2024,year);y<=year;y++)for(let q=1;q<=4;q++) {
    const quarter=`${y}Q${q}`;
    if(quarter<=S.quarter)options.add(quarter);
  }
  const selected=options.has(P.targetQuarter)?P.targetQuarter:S.quarter;
  const users=sales(S).filter(u=>!P.owner||u.id===Number(P.owner));
  const rows=users.map(u=>{
    const target=(S.targets||[]).find(t=>t.user_id===u.id&&t.quarter===selected);
    return `<tr><td data-label="销售"><b>${esc(u.name)}</b></td><td data-label="季度目标">${target?plainMoney(target.amount):'未设置'}</td><td data-label="折算月目标">${target?plainMoney(Math.round(target.amount/3)):'—'}</td><td data-label="状态">${target?.locked?badge('已锁定'):target?badge('已设置','success'):badge('待设置','warning')}</td><td data-label="操作">${target?.locked?'<span class="muted">绩效已确认</span>':`<button class="btn secondary" data-action="target" data-id="${u.id}" data-quarter="${esc(selected)}">${target?'修改':'设置'}</button>`}</td></tr>`;
  }).join('');
  return `<section class="panel target-settings">${sectionHead('季度目标','已确认绩效的季度目标不可修改。')}<div class="target-toolbar"><label>季度<select id="target-quarter" aria-label="目标季度">${[...options].sort().reverse().map(q=>`<option value="${q}" ${q===selected?'selected':''}>${q}</option>`).join('')}</select></label></div><div class="table-scroll"><table class="data-table"><thead><tr><th>销售</th><th>季度合同额目标</th><th>折算月目标</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows||'<tr><td colspan="5">暂无在用销售成员</td></tr>'}</tbody></table></div></section>`;
}
