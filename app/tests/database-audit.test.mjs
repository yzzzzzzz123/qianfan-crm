import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './helpers/fixture.mjs';

test('结构审计将历史cash/分类缺失列作提示，但新增写入保护缺失仍判失败',async t=>{
  const f=await fixture(t),folder=mkdtempSync(path.join(tmpdir(),'qf-history-audit-'));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const names=['opportunities_required_cash_update','opportunities_required_classification_update'];
  const ddl=names.map(name=>f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name).sql);
  f.db.exec('BEGIN');for(const name of names)f.db.exec('DROP TRIGGER '+name);
  f.db.exec('UPDATE opportunities SET product_amount=NULL,sale_type=NULL,order_type=NULL WHERE id=1');
  for(const sql of ddl)f.db.exec(sql);f.db.exec('COMMIT');
  const filename=path.join(folder,'retained-history.sqlite'),reportFile=path.join(folder,'report.json');
  f.db.prepare('VACUUM INTO ?').run(filename);
  const script=fileURLToPath(new URL('../scripts/audit-database-structure.mjs',import.meta.url));
  const audit=()=>spawnSync(process.execPath,['--no-warnings',script,'--database',filename,'--out',reportFile],{encoding:'utf8'});
  const accepted=audit();assert.equal(accepted.status,0,accepted.stderr+accepted.stdout);
  const report=JSON.parse(readFileSync(reportFile,'utf8'));
  assert.deepEqual(report.unexplained,[]);
  for(const name of ['customer_profiles','contract_attachment_analyses','company_profile_jobs','company_profile_queue_control']){
    const table=report.tables.find(table=>table.name===name);assert.ok(table?.purpose,name);
    assert.ok(table.columns.every(column=>typeof column.purpose==='string'&&column.purpose.length>0),name);
  }
  for(const field of ['renewal_tag','payment_type','project_status','delivery_staff','project_note'])assert.ok(report.tables.find(table=>table.name==='contracts').columns.find(column=>column.name===field)?.purpose,field);
  assert.deepEqual(report.historical_missing_fields,{'opportunities.sale_type':1,'opportunities.order_type':1,'opportunities.product_amount':1,'customers.owner_id':0});
  assert.equal(report.required_cash_write_triggers,true);assert.equal(report.required_classification_write_triggers,true);
  const db=new DatabaseSync(filename);try{db.exec('DROP TRIGGER opportunities_required_cash_insert');}finally{db.close();}
  const rejected=audit();assert.equal(rejected.status,1,rejected.stderr+rejected.stdout);
  assert.equal(JSON.parse(readFileSync(reportFile,'utf8')).required_cash_write_triggers,false);
});
