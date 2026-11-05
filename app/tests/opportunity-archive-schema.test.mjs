import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrateOpportunityArchive} from '../server/opportunity-archive-schema.mjs';

function oldSchema(){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(27);
 CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO workspace_revision VALUES(1,5);
 CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO users VALUES(1,'已核验原成员');
 CREATE TABLE opportunities(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL REFERENCES users(id),name TEXT);INSERT INTO opportunities VALUES(9,1,'原商机');
 CREATE TABLE contracts(id INTEGER PRIMARY KEY AUTOINCREMENT,opportunity_id INTEGER REFERENCES opportunities(id),owner_id INTEGER NOT NULL REFERENCES users(id),amount INTEGER);INSERT INTO contracts VALUES(18,9,1,12345);
 CREATE TABLE activities(id INTEGER PRIMARY KEY,opportunity_id INTEGER REFERENCES opportunities(id),summary TEXT);INSERT INTO activities VALUES(7,9,'原跟进不删除');
 CREATE INDEX original_owner_index ON opportunities(owner_id);
 CREATE TRIGGER original_activity_trigger AFTER INSERT ON activities BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1;END;
 CREATE VIEW original_contract_view AS SELECT c.id,o.name FROM contracts c JOIN opportunities o ON o.id=c.opportunity_id;`);
 return db;
}
test('schema28保留原主键、全部旧值、跟进、视图、触发器和自增序列；日常新增仍要求负责人',()=>{
 const db=oldSchema();try{
  const before=Object.fromEntries(['opportunities','contracts','activities'].map(t=>[t,db.prepare('SELECT * FROM '+t).all()])),seq=db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
  migrateOpportunityArchive(db);
  for(const table of ['opportunities','contracts','activities'])for(const [i,row] of before[table].entries())for(const [k,v] of Object.entries(row))assert.equal(db.prepare('SELECT * FROM '+table).all()[i][k],v);
  assert.deepEqual(db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),seq);
  assert.equal(db.prepare('SELECT archived_at FROM opportunities').get().archived_at,null);
  assert.equal(db.prepare('SELECT name FROM original_contract_view').get().name,'原商机');
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name='original_activity_trigger'").get());
  assert.throws(()=>db.prepare("INSERT INTO opportunities(owner_id,name) VALUES(NULL,'不允许普通空负责人')").run(),/owner is required/);
  assert.throws(()=>db.prepare('UPDATE contracts SET owner_id=NULL').run(),/cannot be cleared/);
  const revision=db.prepare('SELECT revision FROM workspace_revision').get().revision;migrateOpportunityArchive(db);assert.equal(db.prepare('SELECT revision FROM workspace_revision').get().revision,revision);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 }finally{db.close();}
});
test('schema28失败时列重建、归档列、视图和原数据整体回滚，并恢复外键校验',()=>{
 const db=oldSchema();try{
  db.exec("CREATE TRIGGER fail28 BEFORE INSERT ON schema_version WHEN NEW.version=28 BEGIN SELECT RAISE(ABORT,'forced28');END;");
  assert.throws(()=>migrateOpportunityArchive(db),/forced28/);
  assert.equal(db.prepare('PRAGMA table_info(opportunities)').all().some(c=>c.name==='archived_at'),false);
  assert.equal(db.prepare('PRAGMA table_info(contracts)').all().find(c=>c.name==='owner_id').notnull,1);
  assert.equal(db.prepare('SELECT name FROM original_contract_view').get().name,'原商机');assert.equal(db.prepare('SELECT summary FROM activities').get().summary,'原跟进不删除');assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 }finally{db.close();}
});
