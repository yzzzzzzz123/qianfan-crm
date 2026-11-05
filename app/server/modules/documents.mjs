import { one, all } from '../database.mjs';
import { assert, code } from '../domain.mjs';
import { integrationSettings } from './setup.mjs';
import { createWordDocument } from '../word-document.mjs';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function renderDocument(ctx, path, actor) {
  const match = path.match(/^\/api\/documents\/(quote|contract)\/(\d+)$/);
  if (!match) return undefined;
  const { db, scoped } = ctx, kind = match[1], id = Number(match[2]);
  let record, customer, owner, items = '';
  if (kind === 'quote') {
    assert(actor.role !== 'pm', '协作PM不能导出报价', 403);
    record = one(db, 'SELECT * FROM quotes WHERE id=?', id); assert(record, '报价不存在', 404);
    const o = scoped('opportunities', record.opportunity_id, actor);
    customer = one(db, 'SELECT * FROM customers WHERE id=?', o.customer_id); owner = o.owner_id;
    let lines=[];try{lines=JSON.parse(record.items||'[]');}catch{}
    items=lines.map(i=>`${i.name}（${i.kind}） 数量 ${i.quantity}，原单价 ${money(i.list_price)} 元，折后比例 ${Number(i.discount_rate)*100}%，金额 ${money(i.amount)} 元`).join('\n');
  } else {
    record = scoped('contracts', id, actor);
    customer = one(db, 'SELECT * FROM customers WHERE id=?', record.customer_id); owner = record.owner_id;
    items = all(db, 'SELECT name,kind,amount FROM contract_items WHERE contract_id=? ORDER BY id', id).map(i => `${i.name}（${i.kind}）：人民币 ${money(i.amount)} 元`).join('\n');
  }
  const docs = integrationSettings(db).documents;
  const official = !!(docs.confirmed && docs.issuer && docs[kind]);
  const missingSignDate = kind === 'contract' && !record.sign_date?.trim();
  const documentDate = kind === 'contract' ? record.sign_date?.trim() || '未提供' : record.created_at.slice(0,10);
  const dateNotice = missingSignDate ? ' 签约日期未提供，须核实后再填写。' : '';
  const values = { document_no: record.contract_no || code(kind === 'quote' ? 'BJ' : 'HT', id, record.created_at), customer_name: customer.name, seller_name: one(db,'SELECT name FROM users WHERE id=?',owner)?.name || '', issuer: docs.issuer || '签约主体待填写', amount: money(record.amount), date: documentDate, valid_until: record.valid_until || '未设置', items, scope: record.scope || '', note: record.note || '' };
  const fallback = '{{issuer}}\n客户：{{customer_name}}\n编号：{{document_no}}\n日期：{{date}}\n金额：人民币 {{amount}} 元\n有效期：{{valid_until}}\n{{items}}\n{{scope}}\n{{note}}';
  const content = (docs[kind] || fallback).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => values[key] ?? '');
  const title = kind === 'quote' ? '报价单' : '合同';
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(values.document_no)} ${title}</title><style>body{max-width:820px;margin:48px auto;padding:0 32px;font:16px/1.9 "Microsoft YaHei",sans-serif;color:#182230}h1{text-align:center}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.status{padding:12px;border:1px solid #b4becd;background:#f5f7fa}.hint{font-size:12px;color:#667085}@media print{body{margin:0;max-width:none}.hint{display:none}}</style><h1>${esc(title)}</h1><p class="status">${official ? '使用管理员已确认的公司模板；签署生效仍以实际签约流程为准。' : '内部核对稿 · 公司模板尚未确认，不作为正式签署文件。'}${dateNotice}</p><pre>${esc(content)}</pre><p class="hint">可通过浏览器“打印”保存为PDF。导出依据当前已保存业务数据，请核对后使用。</p></html>`;
  const document=createWordDocument({title,content,status:(official?'公司模板填写稿，签署以双方实际确认内容为准。':'内部核对稿，公司模板尚未确认。')+dateNotice});
  return { filename: `${values.document_no.replace(/[^a-zA-Z0-9_.-]/g,'_')}.docx`, mime_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',base64:document.toString('base64'),html,official };
}
