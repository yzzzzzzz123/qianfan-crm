import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareProduction} from '../../local/production-config.mjs';
import {openDatabase,one,run} from '../server/database.mjs';

test('正式入口重复启动不覆盖成员维护、不恢复已撤销的绑定、不使待确认草稿无故过期',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'crm-production-restart-'));fs.mkdirSync(path.join(root,'.private'));
  const developer={name:'余志政',userId:'isolated-developer-user',unionId:'isolated-developer-union'};
  fs.writeFileSync(path.join(root,'.private/application.json'),JSON.stringify({clientId:'isolated-app',clientSecret:'isolated-secret',corpId:'isolated-corp',redirectUri:'http://127.0.0.1:3100/api/auth/dingtalk/callback',developer,members:[{name:'王宏',username:'wanghong',role:'admin',userId:'isolated-manager',unionId:'isolated-manager-union'},{name:'祝天',username:'zhutian',role:'sales',userId:'isolated-sales',unionId:'isolated-sales-union'},{...developer,role:'admin',developer:true}]}));
  const old={...process.env};t.after(()=>{for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('crm-production-restart-'));fs.rmSync(root,{recursive:true,force:true});});
  const prepared=prepareProduction(root);let db=openDatabase(prepared.filename);
  const revision=one(db,'SELECT revision FROM workspace_revision').revision;db.close();prepareProduction(root);db=openDatabase(prepared.filename);assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,revision);
  const sales=one(db,"SELECT id FROM users WHERE username='zhutian'");
  run(db,"UPDATE users SET role='pm',performance_enabled=0,ding_user_id=NULL WHERE id=?",sales.id);run(db,'DELETE FROM ding_identities WHERE user_id=?',sales.id);
  const changed=one(db,'SELECT revision FROM workspace_revision').revision;db.close();prepareProduction(root);db=openDatabase(prepared.filename);
  assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,changed);const retained=one(db,'SELECT * FROM users WHERE id=?',sales.id);assert.equal(retained.role,'pm');assert.equal(retained.performance_enabled,0);assert.equal(retained.ding_user_id,null);assert.equal(one(db,'SELECT 1 FROM ding_identities WHERE user_id=?',sales.id),undefined);db.close();
});
