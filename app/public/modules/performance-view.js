import {esc,plainMoney,badge,actionButton as button,sectionHead,empty} from '../ui.js';
import {performancePolicy} from './performance-policy.js';

const finite=v=>typeof v==='number'&&Number.isFinite(v);
const num=v=>finite(v)?v.toLocaleString('zh-CN',{maximumFractionDigits:2}):'—';
const percent=v=>finite(v)?(v*100).toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':'—';
const manual=p=>p.adjustment!=null||p.final_score!=null;
const missingTarget=p=>p.eligible!==false&&!(p.monthly_target>0);
const notes=p=>(p.score_ledger||[]).filter(x=>Object.hasOwn(labels,x.category)&&x.counted===false);
const hasHints=p=>notes(p).length>0||p.adjustment_limited||(p.score_ledger||[]).some(x=>x.attribution_unverified);
const quarter=month=>`${month.slice(0,4)}Q${Math.ceil(Number(month.slice(5,7))/3)}`;
const labels={meeting:'线上会议',visit:'现场拜访',quote:'对客报价',funnel:'新增商机'};
const time=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
const statuses=[['all','全部人员',()=>true],['missing-target','缺少目标',missingTarget],['manual','人工设置',manual],['issues','计分提示',hasHints],['locked','已锁定',p=>p.status==='confirmed']];
export const hasManualPerformance=manual;
export function selectPerformanceRows(S,P={}){
  const owner=String(P.performanceOwner??P.owner??''),q=String(P.performanceQ||'').trim().toLocaleLowerCase();
  const status=statuses.find(([key])=>key===P.performanceStatus)?.[2]||statuses[0][2];
  return (S.performance||[]).filter(p=>(S.actor.role==='admin'||p.user_id===S.actor.id)&&(!owner||String(p.user_id)===owner)&&(!q||p.name.toLocaleLowerCase().includes(q))&&status(p));
}

function targetButton(p,label='设置对应季度目标'){
  return `<button class="btn secondary" data-action="performance-target" data-id="${esc(p.user_id)}" data-month="${esc(p.month)}" data-quarter="${esc(quarter(p.month))}">${esc(label)}</button>`;
}
function categories(p,rule){
  if(Array.isArray(p.category_scores))return p.category_scores;
  if(p.status==='confirmed'&&!p.calculation_rules)return [];
  const process=p.process||{},opps=p.evidence?.opportunities||[];
  const funnel=opps.reduce((s,o)=>s+((o.initial_amount??o.amount)<980000?rule.funnel_low:(o.initial_amount??o.amount)<=5000000?rule.funnel_mid:rule.funnel_high),0);
  return Object.entries(labels).map(([key,label])=>({key,label,count:key==='funnel'?process.funnelCount||0:process[key]||0,rate:key==='funnel'?null:rule[key],points:key==='funnel'?funnel:(process[key]||0)*rule[key]}));
}
function statusLabel(p,S){
  if(p.status==='confirmed')return '已确认锁定';
  if(p.eligible===false)return '不参与绩效';
  if(missingTarget(p))return '缺少季度目标';
  if(p.month===S.today.slice(0,7))return '本月进行中 · 当前参考等级';
  return manual(p)?'管理员已设置 · 尚未锁定':'自动计分 · 尚未锁定';
}
function evidenceRow(S,p,x,legacyKind){
  const kind=x.kind||(x.activity_type?'activity':legacyKind);
  let id=x.event_id||x.source_id||x.id,action='';
  const existingEvent=kind==='activity'&&!x.event_id&&x.activity_id?(S.activityEvents||[]).find(e=>e.id===x.id&&e.activity_id===x.activity_id):null;
  const legacyId=x.activity_id||x.source_id||x.id;
  const legacy=kind==='activity'&&!x.event_id&&!existingEvent&&(S.activities||[]).some(a=>a.id===legacyId&&!a.event_managed&&!(S.activityEvents||[]).some(e=>e.activity_id===a.id));
  if(kind==='activity'&&(x.event_id||existingEvent)){action='activity-event-detail';id=x.event_id||existingEvent.id;}
  else if(legacy){action='activity-legacy-detail';id=legacyId;}
  else if(kind==='quote')action='performance-quote-detail';
  else if(kind==='contract'&&(S.contracts||[]).some(c=>c.id===id))action='contract';
  else if(kind==='opportunity'&&(S.opportunities||[]).some(o=>o.id===id))action='opportunity';
  const title=x.title||x.name||x.summary||(kind==='quote'?'报价记录':'跟进记录');
  const date=x.date||x.activity_date||x.sign_date||String(x.created_at||'').slice(0,10);
  const names=[x.recorder_name?`登记人 ${x.recorder_name}`:'',x.credited_name?`计分归属 ${x.credited_name}`:''].filter(Boolean).join(' · ');
  return `<div class="performance-evidence-row ${x.counted===false?'is-not-counted':''}"><div class="performance-evidence-main">${action?`<button class="text-link" data-action="${action}" data-id="${esc(id)}" data-user-id="${esc(p.user_id)}">${esc(title)}</button>`:`<span class="performance-evidence-title">${esc(title)}</span>`}<div class="performance-evidence-meta">${date?`<span>${esc(date)}</span>`:''}${x.amount!=null?`<span>${plainMoney(x.amount)}</span>`:''}${x.opportunity_name?`<span>${esc(x.opportunity_name)}${x.opportunity_archived?'（商机已归档）':''}</span>`:''}${names?`<span>${esc(names)}</span>`:''}</div></div><div class="performance-evidence-score">${Object.hasOwn(x,'counted')?`<span>${x.counted?`计入 ${num(x.points)} 分`:'未计分'}</span>`:''}${x.reason?`<small>${esc(x.reason)}</small>`:''}${x.terminated_at?'<small>合同已终止，按现行签约业绩口径保留</small>':''}</div></div>`;
}
function evidence(S,p){
  const ledger=p.score_ledger;
  const groups=Array.isArray(ledger)?[...Object.entries(labels),...(ledger.some(x=>x.category==='other')?[['other','其他跟进（不计过程分）']]:[])].map(([key,label])=>{
    const rows=ledger.filter(x=>x.category===key);
    return `<section class="performance-evidence-group"><h4>${label} <small>${rows.filter(x=>x.counted).length} 次计分 · ${rows.length} 条依据</small></h4>${rows.map(x=>evidenceRow(S,p,x)).join('')||'<p class="performance-empty-inline">本月暂无该类依据</p>'}</section>`;
  }).join(''):[['线上会议','meetings','activity'],['现场拜访','visits','activity'],['对客报价','quotes','quote'],['新增商机','opportunities','opportunity']].map(([name,key,kind])=>{
    const rows=p.evidence?.[key]||[];
    return `<section class="performance-evidence-group"><h4>${name} <small>${rows.length} 条快照依据</small></h4>${rows.map(x=>evidenceRow(S,p,{...x,source_id:x.id},kind)).join('')||'<p class="performance-empty-inline">暂无依据</p>'}</section>`;
  }).join('');
  const contracts=p.evidence?.contracts||[];
  return `<details class="ledger-detail performance-evidence" data-detail-key="evidence"><summary>查看逐条计分与合同依据</summary>${!Array.isArray(ledger)?'<p class="performance-note">旧版快照保留原计分依据，未保存逐条得分；历史总分保持原评定。</p>':''}${groups}<section class="performance-evidence-group"><h4>签约合同 <small>${contracts.length} 份</small></h4>${contracts.map(x=>evidenceRow(S,p,{...x,kind:'contract',source_id:x.id})).join('')||'<p class="performance-empty-inline">本月暂无签约合同</p>'}</section></details>`;
}
function adjustment(p){
  if(!manual(p))return '';
  const system=p.system_total??(p.adjustment==null?p.automatic_total:null),meta=p.review_meta||{};
  const steps=[`系统计算 ${num(system)} 分`];
  if(p.adjustment!=null)steps.push(`采用设置的过程分后 ${num(p.automatic_total)} 分`);
  if(p.final_score!=null)steps.push(`人工最终分 ${num(p.final_score)} 分`);
  return `<section class="performance-adjustment"><strong>管理员评分设置</strong><p>${steps.map(esc).join(' → ')}</p>${p.adjustment!=null?`<p>系统过程分 ${num(p.automatic_raw??p.process?.raw)} → 计入过程分 ${num(p.raw)}</p>`:''}<p>原因：${esc(p.reason||'历史记录未保存原因')}</p>${meta.user_name||meta.updated_at?`<small>${esc([meta.user_name,time(meta.updated_at)].filter(Boolean).join(' · '))}</small>`:''}</section>`;
}
function card(S,p){
  const locked=p.status==='confirmed',rule=performancePolicy(locked?(p.calculation_rules||{}):S.rules.performance),items=categories(p,rule),current=p.month===S.today.slice(0,7)&&!locked;
  const rulesAvailable=!locked||!!p.calculation_rules,gradeRules=locked?p.grade_rules_snapshot:S.rules.performance.grades;
  const achievement=finite(p.achievement)?p.achievement:p.monthly_target>0?p.actual/p.monthly_target:null;
  const uncapped=p.uncapped_raw??items.reduce((s,c)=>s+(c.points||0),0),ignored=notes(p),meta=p.review_meta||{};
  const gradeLabel=p.eligible===false?'不参与绩效':missingTarget(p)?'待设目标':p.grade||'暂未评定';
  const tone=current?'blue':p.grade==='D'?'danger':p.grade==='A'?'success':'blue';
  return `<section class="panel person-panel performance-card" data-performance-user="${esc(p.user_id)}"><div class="person-head"><div class="performance-person-name"><h2>${esc(p.name)} ${p.inactive?badge('已停用','gray'):''}</h2><p>${esc(p.month)} · ${esc(statusLabel(p,S))}</p></div><div class="performance-total"><span>${current?'当前参考总分':'绩效总分'}</span><strong class="person-score">${num(p.total)}<small>分</small></strong>${badge(gradeLabel,tone)}</div></div><section class="performance-target"><div><span>本月签约金额</span><strong>${plainMoney(p.actual)}</strong></div><div><span>月目标</span><strong>${p.monthly_target>0?plainMoney(p.monthly_target):'未设置'}</strong></div><div><span>目标达成率</span><strong>${percent(achievement)}</strong></div>${achievement!=null?`<progress max="100" value="${Math.min(100,Math.max(0,achievement*100))}" aria-label="合同目标达成率 ${esc(percent(achievement))}"></progress><p>${achievement>=1?`已超出月目标 ${plainMoney(Math.max(0,p.actual-p.monthly_target))}`:`距月目标还差 ${plainMoney(Math.max(0,p.monthly_target-p.actual))}`}</p>`:''}</section>${missingTarget(p)?`<div class="performance-alert"><p>缺少 ${esc(quarter(p.month))} 季度目标，等级、工资系数和相关个人提成暂不能确定。</p>${S.actor.role==='admin'?targetButton(p):'<small>请联系管理员补充对应季度目标。</small>'}</div>`:p.eligible===false?'<p class="performance-note">该成员不参与绩效评定。</p>':''}<div class="process-grid performance-score-grid"><div><span>计入过程分</span><b>${num(p.raw)}<small>${rulesAvailable?`/ ${num(rule.cap)}`:''}</small></b></div><div><span>过程折算分</span><b>${num(p.processPoints)}</b></div><div><span>合同结果分</span><b>${num(p.resultPoints)}</b></div><div><span>${current?'当前参考工资系数':'绩效工资系数'}</span><b>${percent(p.salary_factor)}</b></div></div>${items.length?`<div class="performance-category-grid">${items.map(c=>`<div class="performance-category"><span>${esc(c.label)}</span><strong>${num(c.points)} <small>分</small></strong><p>${c.rate==null?`${c.count} 个 · 按初始金额分档`:`${c.count} 次 × ${num(c.rate)} 分`}</p></div>`).join('')}</div>`:''}${rulesAvailable?`<div class="performance-formula"><p>过程：${num(p.raw)} ÷ ${num(rule.cap)} × ${num(rule.process_weight)}＝<b>${num(p.processPoints)} 分</b>${p.adjustment!=null?'（采用管理员设置的过程分）':uncapped>rule.cap?`（自动原始 ${num(uncapped)} 分，按上限 ${num(rule.cap)} 分计入）`:''}</p><p>合同：${achievement==null?'缺少目标，暂不能计算':`${percent(achievement)} × ${num(rule.result_weight)}＝<b>${num(p.resultPoints)} 分</b>`}</p><p>两项合计：${num(p.automatic_total)} 分${p.final_score!=null?`；采用人工最终分 ${num(p.final_score)} 分`:''}</p></div>`:'<p class="performance-note">旧版快照未保存完整计算规则，保留原评分与依据。</p>'}${adjustment(p)}${p.adjustment_limited?`<p class="performance-alert">原手动过程分 ${esc(p.adjustment)} 超过当前上限 ${esc(rule.cap)}，本月按上限计分；确认前请复核过程分。</p>`:''}${ignored.length?`<p class="performance-note">${ignored.length} 条依据未重复计分或已作废，展开明细可查看原因。</p>`:''}${p.consecutive_d&&!current?'<p class="performance-alert">本月等级为 D，且上月已确认等级为 D，请结合工作情况复核。</p>':''}${locked&&meta.confirmed_at?`<p class="performance-note">锁定于 ${esc(time(meta.confirmed_at))}；之后的补录或纠错不会自动改写本月快照。</p>`:''}${evidence(S,p)}<details class="performance-card-rules" data-detail-key="rules"><summary>${locked?'本月评定采用的规则':'本月计算规则'}</summary>${rulesAvailable?`<p>过程权重 ${num(rule.process_weight)}%，原始分上限 ${num(rule.cap)} 分；合同结果权重 ${num(rule.result_weight)}%，结果分按实际达成率计算。</p><p>新增商机：低于 9,800 元 ${num(rule.funnel_low)} 分；9,800–50,000 元 ${num(rule.funnel_mid)} 分；高于 50,000 元 ${num(rule.funnel_high)} 分。</p>`:'<p>此历史快照未保存完整的单项计分规则。</p>'}${Array.isArray(gradeRules)?`<p>${gradeRules.map(g=>`≥${num(g.min)}：${esc(g.grade)} / 工资系数 ${percent(g.factor)}`).join('；')}</p>`:'<p>历史快照未保存当月等级阈值，等级与工资系数以已保存评定为准。</p>'}</details>${S.actor.role==='admin'&&p.eligible&&!locked&&!p.inactive?`<div class="performance-card-actions">${button('设置绩效','performance-review',p.user_id,'secondary','edit')}${targetButton(p,'查看季度目标')}</div>`:''}</section>`;
}
export function performance(S,P={}){
  const rule=performancePolicy(S.rules.performance),admin=S.actor.role==='admin';
  const all=(S.performance||[]).filter(p=>admin||p.user_id===S.actor.id),owner=String(P.performanceOwner??P.owner??'');
  const scoped=selectPerformanceRows(S,{...P,performanceStatus:'all'});
  const status=statuses.some(([key])=>key===P.performanceStatus)?P.performanceStatus:'all',rows=selectPerformanceRows(S,P);
  const updated=time(S.updated_at||S.performance_updated_at||all[0]?.updated_at);
  return `<div class="performance-workspace" data-role="${esc(S.actor.role)}"><section class="panel performance-toolbar">${sectionHead(admin?'团队绩效':'我的绩效',S.period===S.today.slice(0,7)?'本月持续计分，当前等级与工资系数随业务更新。':'按所选月份查看评分、原始依据与评定状态。')}<div class="filterbar performance-filters"><label>考核月份<input id="report-month" type="month" value="${esc(S.period)}" aria-label="考核月份"></label>${admin?`<label>销售成员<select id="performance-owner" aria-label="筛选绩效销售"><option value="">全部销售</option>${all.map(p=>`<option value="${esc(p.user_id)}" ${String(p.user_id)===owner?'selected':''}>${esc(p.name)}${p.inactive?'（已停用）':''}</option>`).join('')}</select></label><label>评定状态<select id="performance-status" aria-label="筛选绩效状态">${statuses.map(([key,label])=>`<option value="${key}" ${key===status?'selected':''}>${label}</option>`).join('')}</select></label><label class="performance-search"><span>搜索成员</span><input id="performance-search" type="search" placeholder="输入销售姓名" value="${esc(P.performanceQ||'')}" autocomplete="off"></label>`:''}${button('刷新绩效','performance-refresh','','secondary','refresh')}${admin?button('调整绩效规则','performance-rules','','secondary','edit'):''}</div><p class="performance-update-status">${updated?`数据更新于 ${esc(updated)}`:'可刷新获取最新业务与评分'}${admin?'':' · 仅展示本人绩效'}</p></section>${admin?`<div class="performance-overview">${statuses.map(([key,label,test])=>`<button class="performance-overview-item ${key===status?'is-selected':''}" data-action="performance-status-filter" data-id="${key}" aria-pressed="${key===status}"><span>${label}</span><strong>${scoped.filter(test).length}<small> 人</small></strong></button>`).join('')}</div><p class="performance-result-count">当前显示 ${rows.length} 位成员${owner?' · 已筛选销售':''}</p>`:''}<div class="team-grid performance-card-grid">${rows.map(p=>card(S,p)).join('')||empty('没有匹配的绩效记录','调整人员、状态或搜索条件后查看。')}</div><details class="panel performance-current-rules" data-detail-key="current-rules"><summary>查看当前配置的规则</summary><p>当前配置用于未锁定月份；历史已锁定月份以各卡片保存的规则与评分为准。</p><p>过程权重 ${num(rule.process_weight)}%，结果权重 ${num(rule.result_weight)}%，过程原始分上限 ${num(rule.cap)} 分。</p><p>新增漏斗：低于 9,800 元 ${num(rule.funnel_low)} 分；9,800–50,000 元 ${num(rule.funnel_mid)} 分；高于 50,000 元 ${num(rule.funnel_high)} 分。线上会议 ${num(rule.meeting)} 分/次，报价 ${num(rule.quote)} 分/次，现场拜访 ${num(rule.visit)} 分/次。</p><p>${(rule.grades||[]).map(g=>`≥${num(g.min)}：${esc(g.grade)} / 工资系数 ${percent(g.factor)}`).join('；')}</p></details></div>`;
}
export function syncPerformanceReviewPreview(form,S){
  if(!form||form.dataset.form!=='performance-review')return;
  const p=(S.performance||[]).find(x=>x.user_id===Number(form.dataset.id)),preview=form.querySelector('[data-performance-review-preview]');
  if(!p||!preview)return;
  const rule=performancePolicy(S.rules.performance),value=form.elements.adjustment.value,final=form.elements.final_score.value;
  const hasManual=value!==''||final!=='',restoring=manual(p)&&!hasManual;
  form.elements.reason.required=hasManual||restoring;
  const raw=value===''?(p.automatic_raw??p.process?.raw):Number(value),enteredFinal=final===''?null:Number(final);
  if(!finite(raw)||raw<0||raw>rule.cap||(final!==''&&(!finite(enteredFinal)||enteredFinal<0||enteredFinal>100))){
    preview.innerHTML=`<strong>请先核对评分范围</strong><p>计入过程分须在 0–${num(rule.cap)} 分之间，人工最终总分须在 0–100 分之间。</p>`;
    return;
  }
  const process=Math.round(Math.min(rule.cap,raw)/rule.cap*rule.process_weight*100)/100;
  const auto=finite(process)&&finite(p.resultPoints)?Math.round((process+p.resultPoints)*100)/100:null;
  const total=p.monthly_target>0?(final===''?auto:Number(final)):null,grade=finite(total)?rule.grades?.find(g=>total>=g.min):null;
  preview.innerHTML=`<strong>保存后的评分预览</strong><p>过程折算 ${num(process)} ＋ 合同结果 ${num(p.resultPoints)}＝${num(auto)} 分</p><p>最终总分 <b>${num(total)} 分</b> · 等级 ${esc(grade?.grade||'待设目标')} · 工资系数 ${grade?percent(grade.factor):'—'}</p><small>${restoring?'恢复自动评分也需填写原因。':hasManual?'人工设置需填写原因。':'当前使用自动评分。'}普通销售的实时提成将按采用的等级更新。</small>`;
}
export function performanceQuoteDetail(S,id,userId){
  const p=(S.performance||[]).find(x=>x.user_id===Number(userId)&&(S.actor.role==='admin'||x.user_id===S.actor.id));
  const row=p?.score_ledger?.find(x=>x.kind==='quote'&&Number(x.source_id)===Number(id))||p?.evidence?.quotes?.find(x=>Number(x.id)===Number(id));
  if(!row)return empty('没有可查看的报价依据','该记录不在当前人员、月份的绩效范围内。');
  return `<section class="performance-quote-detail"><h3>${esc(row.title||row.name||'报价依据')}</h3><dl><dt>发生日期</dt><dd>${esc(row.date||String(row.created_at||'').slice(0,10)||'—')}</dd><dt>报价金额</dt><dd>${row.amount==null?'未保存':plainMoney(row.amount)}</dd><dt>计分结果</dt><dd>${row.counted===false?'未计分':finite(row.points)?`计入 ${num(row.points)} 分`:'历史快照未保存逐条分值'}</dd><dt>依据说明</dt><dd>${esc(row.reason||'按本月报价计分口径计入')}</dd>${row.recorder_name?`<dt>登记人</dt><dd>${esc(row.recorder_name)}</dd>`:''}${row.credited_name?`<dt>计分归属</dt><dd>${esc(row.credited_name)}</dd>`:''}</dl>${(S.opportunities||[]).some(o=>o.id===row.opportunity_id)?button('查看关联商机','opportunity',row.opportunity_id,'secondary'):''}</section>`;
}
