import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {intakeSchema,intakeDestinations,operationFields} from '../public/modules/intake-schema.js';
import {visibleGuideGroups,guideFields} from '../public/modules/intake-guide.js';
import {renderPage} from '../public/views.js';
test('资料指南逐业务表覆盖允许类型，字段映射真实列并区分新增与修改',async t=>{
  const groups=visibleGuideGroups('admin'),types=groups.flatMap(g=>g.types);
  assert.deepEqual([...types].sort(),Object.keys(intakeSchema).filter(type=>type!=='member').sort());assert.equal(new Set(types).size,types.length);
  assert.equal(groups.length,11);assert.equal(groups.find(g=>g.id==='payments').types.length,4);
  assert.ok(!groups.some(g=>g.id==='members'));
  assert.deepEqual(groups.find(g=>g.id==='contacts').types,['contact']);
  assert.deepEqual(groups.find(g=>g.id==='quotes').types,['quote']);
  assert.ok(groups.find(g=>g.id==='attachments').types.includes('contract_attachment'));
  assert.ok(groups.find(g=>g.id==='contracts').types.includes('contract_archive'));
  assert.ok(!types.some(type=>type.startsWith('ppl_')||type.startsWith('change_request')));
  for(const type of types) {
    assert.ok(intakeDestinations[type].table);
    for(const k of guideFields(type).required)assert.ok(operationFields(type,type==='contract_item'?'update':'create').includes(k));
  }
  assert.ok(!guideFields('customer').optional.includes('status'));assert.ok(guideFields('customer').update.includes('status'));
  assert.ok(guideFields('opportunity').required.includes('product_amount'));
  assert.ok(!guideFields('opportunity').optional.includes('product_amount'));
  assert.deepEqual(guideFields('contact').conditional,[['phone','wechat','dingtalk']]);
  assert.ok(!guideFields('contact').optional.includes('phone'));
  assert.ok(!visibleGuideGroups('sales').some(g=>g.id==='members'));
  const f=await fixture(t),actor=await f.login(1),s=(await f.request('/state',{actor})).body,html=renderPage(s,{view:'intake'});
  for(const group of groups)assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(group.table),group.table);
  assert.match(html,/业务字段/);assert.match(html,/for="ai-guide-table">业务表<select id="ai-guide-table" aria-controls="ai-guide-fields">/);
  assert.match(html,/<option value="customers" selected>客户<\/option>/);assert.equal((html.match(/data-guide="/g)||[]).length,1);assert.match(html,/data-guide="customers"/);
  assert.doesNotMatch(html,/<option[^>]*>全部/);
  assert.match(html,/ai-business-grid/);assert.match(html,/<th>字段<\/th>/);assert.match(html,/<th>要求<\/th>/);assert.match(html,/<th>数据库列<\/th>/);
  for(const group of groups){
    assert.ok(html.includes(`<option value="${group.id}"${group.id==='customers'?' selected':''}>${group.title}</option>`));
    const selected=renderPage(s,{view:'intake',guideTable:group.id});
    assert.equal((selected.match(/data-guide="/g)||[]).length,1);
    assert.ok(selected.includes(`data-guide="${group.id}"`));assert.ok(selected.includes(`<code>${group.table}</code>`));
    assert.match(selected,/最近入库/);assert.doesNotMatch(selected,/系统字段|完整列说明|ai-system-fields|<code>created_at<\/code>/);
  }
  assert.match(html,/历史缺值保留/);
  assert.match(renderPage(s,{view:'intake',guideTable:'opportunities'}),/<code>product_amount<\/code>/);
  const quoteGuide=renderPage(s,{view:'intake',guideTable:'quotes'});
  assert.match(quoteGuide,/items → \[\]\.kind/);assert.match(quoteGuide,/items → \[\]\.discount_rate/);assert.match(quoteGuide,/明细必填/);assert.match(quoteGuide,/明细选填/);
  const contractGuide=renderPage(s,{view:'intake',guideTable:'contracts'});
  assert.match(contractGuide,/data-item-field="margin_rate"[^]*?<code>contract_items\.margin<\/code>/);
  assert.doesNotMatch(contractGuide,/items\[\]\.margin_rate|<code>margin_rate<\/code>|recurring_amount|auto_renew|合同订单与回款/);
  const paymentGuide=renderPage(s,{view:'intake',guideTable:'payments'});
  assert.match(paymentGuide,/合同整体回款状态/);assert.match(paymentGuide,/未回款\/部分回款\/已结清/);assert.doesNotMatch(paymentGuide,/回款与续约|合同订单与回款/);
  const drift=structuredClone(s);drift.ai.businessTables.contracts.inputs.contract.items.margin_rate.valid=false;
  assert.match(renderPage(drift,{view:'intake',guideTable:'contracts'}),/data-item-field="margin_rate"[^]*?<code>字段待核对<\/code>/);
  assert.match(renderPage(s,{view:'intake',guideTable:'unknown-table'}),/data-guide="customers"/);
  const sales=renderPage({...s,actor:{...s.actor,role:'sales'}},{view:'intake',guideTable:'members'});
  assert.doesNotMatch(sales,/<option value="members"|data-guide="members"/);assert.match(sales,/data-guide="customers"/);
  assert.doesNotMatch(html,/ai-guide-download|ai-guide-group|ai-file-recipe|支持：|商机清单.xlsx|销售季度目标.xlsx|下载本组资料清单|仅新建：/);
});

test('AI明细预览使用业务中文字段，不把产品类型标成提成类型或显示裸字段',async t=>{
  const f=await fixture(t),actor=await f.login(1),S=(await f.request('/state',{actor})).body;
  const batch={id:10,state:'cancelled',summary:'报价字段核对',created_at:'2026-10-29T01:00:00Z',files:[],errors:[],questions:[],operations:[{type:'quote',action:'create',data:{opportunity_id:S.opportunities[0].id,valid_until:'2026-12-31',items:[{name:'测试服务',kind:'实施',quantity:2,list_price:100,discount_rate:0.9}]}}]};
  const html=renderPage(S,{view:'intake',batch});
  assert.match(html,/类型：实施/);assert.match(html,/数量：2/);assert.match(html,/原单价（元）：100/);assert.match(html,/折后比例：0.9/);
  assert.doesNotMatch(html,/提成类型：实施|quantity：|list_price：|discount_rate：/);
});
