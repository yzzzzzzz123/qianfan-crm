import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,one} from '../server/database.mjs';
import {startDailyRefresh,refreshDailyReport} from '../server/scheduler.mjs';

test('local background entry never generates a report even when production is requested',()=>{
 const db=openDatabase(':memory:');const previous=process.env.CRM_LOCAL_PRODUCTION;
 try{
  const stopDefault=startDailyRefresh(db);stopDefault();
  assert.equal(one(db,'SELECT count(*) AS n FROM daily_reports').n,0);
  process.env.CRM_LOCAL_PRODUCTION='true';
  const stopExplicit=startDailyRefresh(db,console,{deployment:'production'});stopExplicit();
  assert.equal(one(db,'SELECT count(*) AS n FROM daily_reports').n,0);
 }finally{if(previous===undefined)delete process.env.CRM_LOCAL_PRODUCTION;else process.env.CRM_LOCAL_PRODUCTION=previous;db.close();}
});

test('production background entry is retired and preserves historical reports',()=>{
 const db=openDatabase(':memory:');const previous=process.env.CRM_LOCAL_PRODUCTION;
 try{
  delete process.env.CRM_LOCAL_PRODUCTION;
  refreshDailyReport(db,new Date('2020-01-01T12:00:00Z'));
  const history=db.prepare('SELECT * FROM daily_reports').all();
  const stop=startDailyRefresh(db,console,{deployment:'production'});stop();
  assert.deepEqual(db.prepare('SELECT * FROM daily_reports').all(),history);
 }finally{if(previous===undefined)delete process.env.CRM_LOCAL_PRODUCTION;else process.env.CRM_LOCAL_PRODUCTION=previous;db.close();}
});
