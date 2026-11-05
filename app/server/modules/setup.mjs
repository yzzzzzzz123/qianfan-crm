import { all, one, run } from '../database.mjs';
import { assert, text, quarter } from '../domain.mjs';
import { handleTeam } from './team.mjs';

const emptyDocuments = { issuer: '', quote: '', contract: '', confirmed: false };
export function integrationSettings(db) {
  const saved = JSON.parse(one(db, "SELECT value FROM settings WHERE key='integrations'")?.value || '{}');
  return { documents: { ...emptyDocuments, ...saved.documents } };
}
const placeholders = new Set(['document_no','customer_name','seller_name','issuer','amount','date','valid_until','items','scope','note']);
export function validateTemplate(value, label) {
  const result = text(value, label, 30000, false);
  for (const match of result.matchAll(/\{\{([^{}]+)\}\}/g)) assert(placeholders.has(match[1].trim()), `模板占位符不支持：${match[1]}`);
  return result;
}
export function handleSetup(ctx) {
  const { path, method, b, actor, db, admin, audit } = ctx;
  if (path === '/api/integrations/config' && method === 'PATCH') {
    admin(actor);
    assert(b.ppl===undefined,'PPL在线连接已停用，请在CRM维护客户和商机',410);
    assert(b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).every(k => ['ppl','documents'].includes(k)), '连接配置包含未知字段');
    const saved = integrationSettings(db);
    if (b.documents !== undefined) {
      assert(b.documents && typeof b.documents === 'object' && !Array.isArray(b.documents), '模板配置格式无效');
      assert(Object.keys(b.documents).every(k => Object.hasOwn(emptyDocuments,k)), '模板包含未知字段');
      const changed = ['issuer','quote','contract'].some(k => b.documents[k] !== undefined && b.documents[k] !== saved.documents[k]);
      if (changed) saved.documents.confirmed = false;
      for (const key of ['issuer','quote','contract']) if (b.documents[key] !== undefined) saved.documents[key] = key === 'issuer' ? text(b.documents[key],'签约主体',200,false) : validateTemplate(b.documents[key], '模板正文');
      if (b.documents.confirmed !== undefined) { assert(typeof b.documents.confirmed === 'boolean','模板确认标记无效'); saved.documents.confirmed = b.documents.confirmed; }
      assert(!saved.documents.confirmed || saved.documents.issuer && saved.documents.quote && saved.documents.contract, '确认正式模板前须填写签约主体及两份正文');
    }
    run(db, "INSERT INTO settings(key,value) VALUES('integrations',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(saved));
    audit(actor, '保存系统连接与模板', 'settings', null, { sections: Object.keys(b) });
    return { message: '公司模板已保存' };
  }
  if (path === '/api/targets/bulk' && method === 'POST') {
    admin(actor);
    const lines = text(b.text, '销售目标清单', 10000).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    assert(lines.length > 0 && lines.length <= 100, '每次支持1至100条目标');
    const seen = new Set();
    for (const line of lines) {
      const parts = line.split(/[,，\t\s]+/);
      assert(parts.length === 2, '每行格式：姓名或账号,季度目标金额（元）');
      const matches = all(db, "SELECT id FROM users WHERE (name=? OR username=?) AND role='sales' AND active=1 AND business_member=1 AND developer_admin=0", parts[0], parts[0]);
      assert(matches.length === 1, `销售无法唯一定位：${parts[0]}`);
      assert(!seen.has(matches[0].id), '同一销售不能重复填写'); seen.add(matches[0].id);
      handleTeam({ ...ctx, path: '/api/targets', b: { user_id: matches[0].id, quarter: b.quarter, amount: parts[1] } });
    }
    return { message: `已保存${lines.length}位销售的季度目标` };
  }
}
