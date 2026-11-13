import {esc,plainMoney,dateLabel,formShell} from '../ui.js';

export function winReportPanel(S,o){
  if(S.actor.role!=='admin'||!o.win_report&&o.stage!=='赢单')return '';
  const report=o.win_report;
  return `<link rel="stylesheet" href="./modules/win-reports.css"><section class="win-report-panel" aria-label="赢单战报"><div class="section-head"><div><h3>赢单战报</h3><p>${S.win_reports?.enabled?'自动推送已开启':'自动推送已关闭'}</p></div></div>${report?`<p class="win-report-snapshot">${esc(report.snapshot.owner_name)} · ${plainMoney(report.snapshot.amount)}<span>赢单时的签约信息</span></p><ul class="win-report-groups">${report.groups.map(g=>`<li><div><b>${esc(g.group_name)}</b><span class="win-report-status win-report-${esc(g.status)}">${esc(g.status_label)}</span>${g.sent_at?`<small>${esc(dateLabel(g.sent_at))}</small>`:''}${g.error_message?`<p>${esc(g.error_message)}</p>`:''}</div>${g.can_retry?`<button type="button" class="btn secondary" data-action="win-report-retry" data-id="${g.id}" data-opportunity-id="${o.id}">${g.needs_verification?'核对后补发':'补发本群'}</button>`:''}</li>`).join('')}</ul>`:'<p class="muted">此商机暂无战报记录，历史赢单不会自动补发。</p>'}</section>`;
}

export function winReportRetryForm(S,opportunityId,deliveryId){
  const o=S.opportunities.find(o=>o.id===Number(opportunityId));
  const delivery=o?.win_report?.groups.find(g=>g.id===Number(deliveryId));
  if(S.actor.role!=='admin'||!delivery?.can_retry)throw new Error('该战报当前不可补发');
  return formShell(`补发至${delivery.group_name}`,'仅补发本群，使用首次赢单时的负责人、销售内容和签约金额。',
    `<input type="hidden" name="opportunity_id" value="${o.id}">${delivery.needs_verification?'<p class="wide text-warning">上次投放结果不确定，请先查看该群是否已收到卡片。</p><label class="wide"><input type="checkbox" name="confirmed_not_delivered" required> 我已核对该群，确认没有收到这张卡片</label>':'<p class="wide">已成功发送的记录不会重复投放。</p>'}`,'win-report-retry',delivery.id,'安排补发');
}
