import {esc,badge,empty} from '../ui.js';
export function minuteArtifact(kind,input,recordId,canManage,selected,fallback){
 const a=input||{state:'unavailable',reason:'',content:''};
 const automatic=['speaker_insights','quality','transcript'].includes(kind);
 const oldPlaceholder=automatic&&a.state==='unavailable'&&(!a.reason||/未自动创建源平台分析任务|接口尚未核验|接入未提供会议质检接口/.test(a.reason));
 const labels={ready:'已同步',empty:kind==='transcript'?'钉钉未返回逐字稿':'暂无可分析正文',pending:kind==='quality'?'正在生成会议质检':kind==='transcript'?'正在读取逐字稿':'正在准备发言人观点',unavailable:automatic?'正在读取':'尚未返回',unsupported_shape:'返回格式待核验',failed:'本次读取未完成'};
 const fallbackText=kind==='transcript'&&!a.content&&fallback?.state==='ready'?fallback.content:'';
 const reason=oldPlaceholder?'':a.reason;
 const checked=a.checked_at&&!oldPlaceholder?`<span class="minutes-hint"> 最近读取 ${esc(new Date(a.checked_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</span>`:'';
 return `<section data-minute-artifact="${kind}" ${kind!==selected?'hidden':''} class="minutes-artifact">${badge(labels[a.state]||'尚未返回',a.state==='ready'?'success':'neutral')}${checked}${reason?`<p class="minutes-hint">${esc(reason)}</p>`:''}${a.content?`<div class="minutes-text">${a.state!=='ready'?'<p class="text-warning">以下为上次成功读取的正文，本次状态以提示为准。</p>':''}${esc(a.content)}</div>`:fallbackText?`<p class="minutes-hint">以下为已同步的 AI 总结</p><div class="minutes-text">${esc(fallbackText)}</div>`:automatic?'':empty('该项尚无可展示正文','')}</section>`;
}
