import {esc,badge,empty} from '../ui.js';
export function minuteArtifact(kind,input,recordId,canManage,selected,fallback){
  const a=input||{state:'unavailable',reason:'',content:''};
  const labels={ready:'已同步',empty:kind==='transcript'?'源平台暂未返回逐字稿':kind==='summary'?'源平台暂未返回总结':'暂无可分析正文',pending:kind==='quality'?'会议质检生成中':kind==='transcript'?'逐字稿生成或读取中':kind==='speaker_insights'?'发言人观点准备中':'总结生成或读取中',unavailable:'当前来源暂未提供',unsupported_shape:'返回格式待核验',failed:'本次读取未完成'};
  const fallbackText=kind==='transcript'&&!a.content&&fallback?.state==='ready'?fallback.content:'';
  const legacyPlaceholder=a.state==='unavailable'&&/未自动创建源平台分析任务|接口尚未核验|接入未提供会议质检接口/.test(a.reason||'');
  const checked=!legacyPlaceholder&&a.checked_at&&Number.isFinite(Date.parse(a.checked_at))?`<span class="minutes-hint">最近读取 ${esc(new Date(a.checked_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</span>`:'';
  const unsupported=a.state==='unavailable'&&/不支持|未提供|不提供|接口受限|不可用/.test(a.reason||'');
  const retry=canManage&&a.state!=='ready'&&!unsupported;
  return `<section data-minute-artifact="${kind}" ${kind!==selected?'hidden':''} class="minutes-artifact"><div class="minutes-artifact-status">${badge(labels[a.state]||'状态待核验',a.state==='ready'?'success':a.state==='failed'||a.state==='unsupported_shape'?'warning':'neutral')}${checked}${retry?`<button type="button" class="btn secondary" data-action="minutes-artifact-retry" data-id="${kind}" data-record-id="${esc(recordId)}">${a.state==='pending'?'再次检查状态':'重新读取本项'}</button>`:''}</div>${a.reason?`<p class="minutes-hint">${esc(a.reason)}</p>`:''}${a.content?`<div class="minutes-text">${a.state!=='ready'?'<p class="text-warning">以下为上次成功读取的正文，本次状态以提示为准。</p>':''}${esc(a.content)}</div>`:fallbackText?`<p class="minutes-hint">逐字稿尚未返回，以下为已同步的 AI 总结。</p><div class="minutes-text">${esc(fallbackText)}</div>`:empty(a.state==='pending'?'正在处理，可稍后再次检查':unsupported?'当前来源暂未提供此项内容':'此项暂无可展示正文','')}</section>`;
}
