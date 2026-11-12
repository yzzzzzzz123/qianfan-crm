import path from 'node:path';

export function serverAIEnvironment(config) {
  const providers={zimaocloud:{model:'deepseek-v4-1-flash',base:'https://aiclub.zimaocloud.com/model/openApi/v1'},ppio:{model:'qwen/qwen3.8-max',base:'https://api.ppio.com/openai/v1'}};
  const selected=providers[config?.provider];
  if(!selected||config.model!==selected.model||config.base_url!==selected.base)throw new Error('服务器AI配置与已支持的提供方、模型及地址不一致');
  if(typeof config.apiKey!=='string'||!/^[!-~]{16,2048}$/.test(config.apiKey))throw new Error('服务器AI私有凭据无效');
  if(typeof config.python_executable!=='string'||!/^\/srv\/qianfan-crm\/runtime\/[a-zA-Z0-9_./-]+\/bin\/python3$/.test(config.python_executable)||config.python_executable.split('/').includes('..'))throw new Error('服务器文件解析器须位于CRM独立运行环境');
  return {CRM_AI_PROVIDER:config.provider,AI_API_KEY:config.apiKey,...(config.searchApiKey||config.provider==='ppio'?{PPIO_SEARCH_API_KEY:config.searchApiKey||config.apiKey}:{}),CRM_PYTHON:config.python_executable};
}

export function serverEnvironment(config) {
  const fail=message=>{throw new Error(message);};
  let origin;try{origin=new URL(config.origin);}catch{fail('服务器公网地址无效');}
  if(origin.protocol!=='https:'||origin.origin!==config.origin||origin.username||origin.password)fail('服务器公网地址必须是HTTPS Origin');
  const basePath=config.basePath||'/';
  if(!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath))fail('服务器访问路径无效');
  const port=config.port||5310;if(!Number.isInteger(port)||port<1024||port>65535)fail('服务器内部端口无效');
  if(typeof config.dbPath!=='string'||!path.isAbsolute(config.dbPath))fail('服务器数据库须使用绝对路径');
  const ding=config.dingtalk||{};for(const key of ['clientId','clientSecret','corpId'])if(typeof ding[key]!=='string'||!ding[key])fail('服务器钉钉凭据不完整');
  if(typeof config.developerSwitch!=='boolean')fail('须明确配置开发者切换开关');
  return {CRM_RUNTIME_ENVIRONMENT:'server',CRM_MINUTES_BINARY:'/srv/qianfan-crm/runtime/minutes-tools/dws',CRM_MINUTES_CREDENTIAL_ROOT:'/srv/qianfan-crm/private/minutes-accounts',NODE_ENV:'production',DEMO_MODE:'false',HOST:'127.0.0.1',PORT:String(port),DB_PATH:config.dbPath,PUBLIC_ORIGIN:origin.origin,PUBLIC_BASE_PATH:basePath,CRM_LOCAL_PRODUCTION:'false',CRM_DEVELOPER_SWITCH:String(config.developerSwitch),DINGTALK_ONLY:'true',DINGTALK_CLIENT_ID:ding.clientId,DINGTALK_CLIENT_SECRET:ding.clientSecret,DINGTALK_CORP_ID:ding.corpId,DINGTALK_REDIRECT_URI:origin.origin+basePath+'api/auth/dingtalk/callback'};
}
