import fs from 'node:fs';
import path from 'node:path';

// This file records the owner's explicit exception for this project's local
// enterprise-profile queue. It grants no authority to any other scheduler.
export function prepareLocalCompanyProfileAutomation(root,{io=fs,platform=process.platform}={}) {
  const file=path.join(root,'.private/company-profile-automation.json');
  if(!io.existsSync(file))return null;
  const fail=()=>{throw new Error('企业资料自动查询授权无效，请核对本项目本地运行范围');};
  try {
    const stat=io.lstatSync(file),directory=io.lstatSync(path.dirname(file));
    if(platform!=='win32'||stat.isSymbolicLink()||directory.isSymbolicLink()||!stat.isFile()||stat.size>4096)fail();
    const value=JSON.parse(io.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    if(value.version!==1||value.scope!=='qianfan-company-profile'||value.target!=='local'||value.automatic!==true||value.project_root!==path.resolve(root)||value.database!=='app/data/crm.sqlite'||value.origin!=='http://127.0.0.1:3100')fail();
    return {authorized:true,scope:value.scope,projectRoot:path.resolve(root),databasePath:path.resolve(root,value.database),origin:value.origin};
  }catch{fail();}
}

export function validateLocalCompanyProfileAutomation(value,{platform=process.platform,localHttp,projectRoot,filename,origin}) {
  return platform==='win32'&&localHttp===true&&value?.authorized===true&&value.scope==='qianfan-company-profile'&&value.projectRoot===path.resolve(projectRoot)&&value.databasePath===path.resolve(filename)&&value.origin===origin
    ?{authorized:true,scope:value.scope,runtimeChecked:true}:null;
}
