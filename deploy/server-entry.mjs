import fs from 'node:fs';
import path from 'node:path';
import { serverEnvironment,serverAIEnvironment } from '../app/server/server-config.mjs';
import { openDatabase,one } from '../app/server/database.mjs';
import { prepareCompanyProfile } from '../local/company-profile-config.mjs';
const filename=process.env.QF_DEPLOY_CONFIG||'/srv/qianfan-crm/private/application.json';
const config=JSON.parse(fs.readFileSync(filename,'utf8'));
Object.assign(process.env,serverEnvironment(config));delete process.env.QF_START;
const aiFile=path.join(path.dirname(filename),'ai.json');
if(fs.existsSync(aiFile))Object.assign(process.env,serverAIEnvironment(JSON.parse(fs.readFileSync(aiFile,'utf8'))));
prepareCompanyProfile(path.resolve(path.dirname(filename),'../current'),{configFile:path.join(path.dirname(filename),'company-profile.json')});
if(!fs.existsSync(config.dbPath))throw new Error('服务器初始化数据库尚未导入');
const db=openDatabase(config.dbPath);
try {
  if(one(db,"SELECT value FROM settings WHERE key='workspace_mode'")?.value!=='production')throw new Error('服务器只能启动正式数据库');
  if(config.developerSwitch&&!one(db,'SELECT u.id FROM users u JOIN ding_identities d ON d.user_id=u.id WHERE u.active=1 AND u.business_member=0 AND u.developer_admin=1 AND u.ding_user_id=? AND d.union_id=?',config.developer?.userId||'',config.developer?.unionId||''))throw new Error('服务器指定开发者绑定不一致');
}finally{db.close();}
const {start}=await import('../app/server/index.mjs');start();
