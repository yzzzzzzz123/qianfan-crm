import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {visibleGuideGroups,guideFields} from '../public/modules/intake-guide.js';
import {renderPage} from '../public/views.js';

test('AI字段指南按实际角色及新增修改字段区分，不给PM展示无权创建的数据',()=>{
  assert.deepEqual(visibleGuideGroups('pm').flatMap(g=>g.types),['activity','contract']);
  const contract=guideFields('contract','pm');
  assert.equal(contract.action,'update');assert.deepEqual(contract.required,[]);
  assert.deepEqual(contract.optional,['scope','project_status','delivery_staff','project_note']);
  for(const field of ['owner_id','renewal_tag','payment_type','sale_type','order_type'])assert.ok(!contract.optional.includes(field),field);
  assert.ok(visibleGuideGroups('sales').flatMap(g=>g.types).includes('contract'));
  assert.ok(guideFields('contact').update.includes('active'));
  assert.ok(!guideFields('contact').update.includes('customer_id'));
});

test('AI字段位置仅作说明，批次详情唯一且最近入库按确认日期排序',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const customer=f.db.prepare('SELECT id FROM customers LIMIT 1').get();
  const operations=JSON.stringify([{type:'customer',ref:'c',action:'update',source_file:'核对.md',data:{note:'已核对'}}]);
  const result=JSON.stringify([{type:'customer',ref:'c',id:customer.id}]);
  const insert=f.db.prepare(`INSERT INTO ai_import_batches(id,user_id,source_hash,state,summary,questions,operations,errors,model,usage,base_revision,created_at,confirmed_at,result,source_role) VALUES(?,1,?,'confirmed','核对完成','[]',?,'[]','test','{}',0,?,?,?,'admin')`);
  for(const [id,time] of [[20,'2026-10-29T01:00:00Z'],[10,'2026-10-29T09:00:00Z']])insert.run(id,'guide-date-'+id,operations,time,time,result);
  const S=(await f.request('/state',{actor})).body;
  assert.deepEqual(S.ai.batches.map(b=>b.id),[20,10]);
  assert.equal(S.ai.importHistory.find(record=>record.type==='customer').imported_at,'2026-10-29T09:00:00Z');
  const html=renderPage(S,{view:'intake'}),guide=html.split('class="panel ai-field-list"')[1].split('class="panel ai-history"')[0];
  assert.doesNotMatch(guide,/data-action=/);
  assert.match(guide,/17:00:00/);assert.doesNotMatch(guide,/9:00:00/);
  assert.equal((html.match(/data-action="ai-batch"/g)||[]).length,2);
  const contacts=renderPage(S,{view:'intake',guideTable:'contacts'});
  assert.match(contacts,/仅修改/);assert.match(contacts,/启用状态/);
  assert.match(contacts,/aria-label="仅新建时填写"/);
  assert.doesNotMatch(html,/仅新建：/);
  const paymentsGuide=renderPage(S,{view:'intake',guideTable:'payments'});
  const payments=paymentsGuide.match(/<article[^>]*data-guide="payments">[^]*?<\/article>/)[0];
  assert.equal((payments.match(/data-field="pay_date"/g)||[]).length,1);
  assert.equal((payments.match(/data-field="checkpoint_date"/g)||[]).length,1);
  assert.doesNotMatch(paymentsGuide+renderPage(S,{view:'intake',guideTable:'templates'}),/<strong>确认到账<\/strong>|<strong>催办检查点<\/strong>|<strong>批准公司模板<\/strong>/);
});

test('客户联系人和报价合同分别展示真实入库时间，空对象不继承关联表时间',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  f.db.prepare('DELETE FROM contacts').run();f.db.prepare('DELETE FROM quotes').run();
  const customer=f.db.prepare('SELECT id FROM customers LIMIT 1').get(),contract=f.db.prepare('SELECT id FROM contracts LIMIT 1').get();
  const insert=f.db.prepare(`INSERT INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES('test',?,?,?,?,'{}','fixture.xlsx',?,1,?,?,'imported','')`);
  insert.run('customers','c1','customer',customer.id,'customers','2026-10-20T02:00:00Z','customer-import');
  insert.run('contracts','ct1','contract',contract.id,'contracts','2026-10-22T04:00:00Z','contract-import');
  const S=(await f.request('/state',{actor})).body;
  const row=id=>renderPage(S,{view:'intake',guideTable:id}).match(new RegExp('<article[^>]*data-guide="'+id+'">[^]*?</article>'))[0];
  assert.match(row('customers'),/2026\/10\/20 10:00:00/);assert.match(row('contracts'),/2026\/10\/22 12:00:00/);
  for(const id of ['contacts','quotes','attachments','payments']){
    assert.match(row(id),/最近入库 <span>暂无/);
    assert.doesNotMatch(row(id),/<time>/);
  }
});
