import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
import {auditIntakeStorage} from '../scripts/audit-intake-storage.mjs';
import {intakeStorage,intakeItemStorage} from '../public/modules/intake-schema.js';
import {businessTableCatalog,intakeStorageMatches} from '../server/modules/intake-fields.mjs';

test('真实库字段审计区分物理表、AI字段和系统列，读取不修改数据',()=>{
  const db=openDatabase(':memory:');
  try {
    const before=db.prepare('SELECT total_changes() n').get().n,report=auditIntakeStorage(db);
    assert.equal(report.ok,true,JSON.stringify(report.problems));assert.equal(report.table_count,41);
    for(const name of ['customer_profiles','contract_attachment_analyses','company_profile_jobs','company_profile_queue_control']){
      const table=report.tables.find(t=>t.name===name);assert.ok(table,name);
      assert.deepEqual(table.ai_mapped_columns,[]);assert.deepEqual(table.not_directly_written_by_ai,table.columns);
    }
    for(const field of ['renewal_tag','payment_type','project_status','delivery_staff','project_note'])assert.ok(report.tables.find(t=>t.name==='contracts').ai_mapped_columns.includes(field),field);
    assert.equal(report.operation_count,17);assert.ok(report.field_count>100);
    assert.equal(report.item_field_count,15);
    const marginRate=report.operations.find(o=>o.type==='contract').items.find(f=>f.field==='margin_rate');
    assert.equal(marginRate.kind,'derived');assert.equal(marginRate.targets[0].table,'contract_items');assert.equal(marginRate.targets[0].column,'margin');
    const quoteKind=report.operations.find(o=>o.type==='quote').items.find(f=>f.field==='kind');
    assert.deepEqual({table:quoteKind.targets[0].table,column:quoteKind.targets[0].column,jsonPath:quoteKind.targets[0].jsonPath,array:quoteKind.targets[0].array},{table:'quotes',column:'items',jsonPath:'kind',array:true});
    assert.ok(report.tables.find(t=>t.name==='opportunities').not_directly_written_by_ai.includes('reference'));
    assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
  } finally {db.close();}
});

test('明细映射也核实真实列，实际结构变化同时影响目录与入库检查',()=>{
  const db=openDatabase(':memory:');
  try {
    const items=structuredClone(intakeItemStorage);items.contract.margin_rate.targets[0].column='margin_rate';
    const report=auditIntakeStorage(db,{items});assert.equal(report.ok,false);assert.ok(report.problems.some(p=>p.includes('contract.items[].margin_rate: missing contract_items.margin_rate')));
    assert.equal(businessTableCatalog(db,'admin').contracts.inputs.contract.items.margin_rate.valid,true);
    assert.equal(intakeStorageMatches(db,'contract',{project_note:'原字段可用'}),true);
    db.exec('ALTER TABLE contracts DROP COLUMN project_note');
    assert.equal(businessTableCatalog(db,'admin').contracts.inputs.contract.fields.project_note.valid,false);
    assert.equal(intakeStorageMatches(db,'contract',{project_note:'缺列不得写入'}),false);
    assert.equal(intakeStorageMatches(db,'contract',{items:[{margin_rate:0.3}]}),true);
    assert.equal(businessTableCatalog(db,'pm').contracts.inputs.contract.items.margin_rate,undefined);
  } finally {db.close();}
});

test('业务字段目录读取真实表列，按角色限制范围且不包含任何业务记录或凭据值',()=>{
  const db=openDatabase(':memory:');
  try {
    const catalog=businessTableCatalog(db,'admin');
    assert.deepEqual(catalog.contacts.columns.map(c=>c.name),db.prepare('PRAGMA table_info(contacts)').all().map(c=>c.name));
    assert.ok(catalog.opportunities.columns.some(c=>c.name==='product_amount'&&c.description.includes('cash')));
    for(const name of ['sessions','audit','ding_identities','ai_uploads'])assert.equal(catalog[name],undefined);
    assert.deepEqual(Object.keys(businessTableCatalog(db,'pm')).sort(),['activities','contracts']);
    assert.equal(businessTableCatalog(db,'sales').users,undefined);
    assert.ok(!JSON.stringify(catalog).includes('"rows"'));
    db.exec('ALTER TABLE contacts ADD COLUMN verification_only TEXT');
    assert.ok(businessTableCatalog(db,'admin').contacts.columns.some(c=>c.name==='verification_only'));
  } finally {db.close();}
});

test('真实库字段审计拒绝不存在列及无映射字段，不能用用途文案冒充对齐',()=>{
  const db=openDatabase(':memory:');
  try {
    const storage=structuredClone(intakeStorage);
    storage.opportunity.product_amount.targets[0].column='cash_not_a_real_column';
    delete storage.contact.phone;
    const report=auditIntakeStorage(db,{storage});
    assert.equal(report.ok,false);
    assert.ok(report.problems.some(p=>p.includes('opportunity.product_amount: missing opportunities.cash_not_a_real_column')));
    assert.ok(report.problems.some(p=>p.includes('contact.phone: no persistence contract')));
  } finally {db.close();}
});
