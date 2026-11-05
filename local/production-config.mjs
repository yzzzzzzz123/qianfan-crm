import fs from 'node:fs';
import path from 'node:path';
import { openDatabase,one,run,transaction } from '../app/server/database.mjs';
import { now } from '../app/server/domain.mjs';
export function prepareProduction(root) {
  const file=path.join(root,'.private/application.json');
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const key of ['clientId','clientSecret','corpId','redirectUri'])if(typeof config[key]!=='string'||!config[key])throw new Error('私有钉钉配置不完整：'+key);
  if(config.redirectUri!=='http://127.0.0.1:3100/api/auth/dingtalk/callback')throw new Error('本机生产回调地址不一致');
  if(!config.developer?.unionId||!config.developer?.userId||config.developer.name!=='余志政')throw new Error('指定开发者身份尚未核验');
  const filename=path.join(root,'app/data/crm.sqlite');
  const db=openDatabase(filename);
  try {
    if(one(db,"SELECT value FROM settings WHERE key='workspace_mode'")?.value==='demo')throw new Error('正式运行禁止使用演示数据库');
    transaction(db,()=>{
      const initialized=!!one(db,"SELECT value FROM settings WHERE key='identity_initialization_complete'");
      run(db,"INSERT OR IGNORE INTO settings VALUES('workspace_mode','production')");
      const declared=[{name:'王宏',username:'wanghong',role:'admin'},{name:'祝天',username:'zhutian',role:'sales'},{name:'米粒',username:'mili',role:'sales'}];
      for(const entry of declared) if(!one(db,'SELECT id FROM users WHERE username=?',entry.username))run(db,'INSERT INTO users(name,username,role,performance_enabled,created_at) VALUES(?,?,?,?,?)',entry.name,entry.username,entry.role,entry.role==='sales'?1:0,now());
      for(const member of config.members||[]) {
        let created=false;
        let user=one(db,'SELECT * FROM users WHERE ding_user_id=?',member.userId);
        if(!user&&member.username)user=one(db,'SELECT * FROM users WHERE username=?',member.username);
        if(!user&&member.developer)user=one(db,"SELECT * FROM users WHERE username='developer_yu'");
        if(!user) {
          const username=member.developer?'developer_yu':member.username||'ding_'+member.userId;
          const id=Number(run(db,'INSERT INTO users(name,username,role,ding_user_id,developer_admin,performance_enabled,created_at) VALUES(?,?,?,?,?,?,?)',member.name,username,member.role||'sales',member.userId,member.developer?1:0,member.role==='sales'?1:0,now()).lastInsertRowid);
          user=one(db,'SELECT * FROM users WHERE id=?',id);
          created=true;
        }
        if(member.developer&&member.unionId!==config.developer.unionId)throw new Error('开发者绑定不一致');
        const bound=one(db,'SELECT union_id FROM ding_identities WHERE user_id=?',user.id);
        if(member.developer) {
          if(bound&&bound.union_id!==member.unionId)throw new Error('开发者身份与受限配置冲突，请先核对');
          if(user.ding_user_id!==member.userId||user.developer_admin!==1||user.business_member!==0||user.performance_enabled!==0)run(db,'UPDATE users SET ding_user_id=?,developer_admin=1,business_member=0,performance_enabled=0 WHERE id=?',member.userId,user.id);
        } else {
          // Verified initial bindings seed an empty identity only. Preserve later administrator changes.
          if(user.developer_admin===1||user.business_member===0)throw new Error('业务成员配置不能覆盖开发者身份');
          if(!bound&&!user.ding_user_id&&(!initialized||created))run(db,'UPDATE users SET ding_user_id=? WHERE id=?',member.userId,user.id);
          else if(Boolean(bound)!==Boolean(user.ding_user_id)&&!created)throw new Error('成员身份绑定不完整，请先核对，不自动覆盖');
        }
        if(!bound&&(member.developer||!initialized||created))run(db,'INSERT INTO ding_identities VALUES(?,?)',user.id,member.unionId);
      }
      const rules=JSON.parse(one(db,"SELECT value FROM settings WHERE key='rules'").value);
      if(!rules.commission.manager_id) {
        rules.commission.manager_id=one(db,"SELECT id FROM users WHERE username='wanghong'").id;
        run(db,"UPDATE settings SET value=? WHERE key='rules'",JSON.stringify(rules));
      }
      run(db,"INSERT OR IGNORE INTO settings VALUES('identity_initialization_complete','true')");
    });
  }finally{db.close();}
  Object.assign(process.env,{NODE_ENV:'production',DEMO_MODE:'false',HOST:'127.0.0.1',PORT:'3100',DB_PATH:filename,PUBLIC_ORIGIN:'http://127.0.0.1:3100',CRM_LOCAL_PRODUCTION:'true',DINGTALK_ONLY:'true',DINGTALK_CLIENT_ID:config.clientId,DINGTALK_CLIENT_SECRET:config.clientSecret,DINGTALK_CORP_ID:config.corpId,DINGTALK_REDIRECT_URI:config.redirectUri});
  delete process.env.QF_START;
  return {filename};
}
