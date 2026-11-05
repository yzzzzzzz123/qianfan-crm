import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url));
const parent=path.resolve(root,'../..');
const source=await fs.access(path.join(parent,'server/service.mjs')).then(()=>parent).catch(()=>root);
if(source!==root)for(const dir of ['public','server']){await fs.rm(path.join(root,dir),{recursive:true,force:true});await fs.cp(path.join(source,dir),path.join(root,dir),{recursive:true});}
let db=await fs.readFile(path.join(root,'server/database.mjs'),'utf8');
db=db.replace('import { DatabaseSync } from "node:sqlite";','import { DatabaseSync } from "../sqlite-browser.mjs";').replace('import fs from "node:fs";','').replace('import path from "node:path";','').replace(/  if \(filename !== ":memory:"\)\s*fs\.mkdirSync\(path\.dirname\(filename\), \{ recursive: true \}\);/,'');
await fs.writeFile(path.join(root,'server/database.mjs'),db);
const domain=path.join(root,'server/domain.mjs');let domainSource=await fs.readFile(domain,'utf8');if(!domainSource.includes('import { Buffer }'))await fs.writeFile(domain,'import { Buffer } from "buffer";\n'+domainSource);
// Only freshly generated demonstration data is included; never copy a running database.
const seedFile=path.join(root,'server/seed.mjs');let seed=await fs.readFile(seedFile,'utf8');
const rename={'王宏':'演示管理员','祝天':'销售甲','米粒':'销售乙','影子科技集团有限公司':'青禾农业科技（演示）','影子科技':'青禾农业','元鼎智能科技有限公司':'北辰智能制造（演示）','元鼎智能':'北辰制造','华南建工集团有限公司':'云山建设集团（演示）','华南建工':'云山建设','明德教育集团':'启明教育集团（演示）','明德教育':'启明教育','长江物流股份有限公司':'远航物流（演示）','长江物流':'远航物流','天工新材料科技有限公司':'新材科技（演示）','天工新材':'新材科技','广发零售连锁集团':'百川连锁（演示）','广发零售':'百川连锁','蓝海文旅集团有限公司':'山海文旅（演示）','蓝海文旅':'山海文旅','星辰医疗器械有限公司':'康宁器械（演示）','星辰医疗':'康宁器械'};
for(const [a,b]of Object.entries(rename))seed=seed.replaceAll(a,b);seed=seed.replaceAll('交接资料中的示例客户，仅用于功能演示。','虚构演示客户，仅用于功能测试。');await fs.writeFile(seedFile,seed);
await fs.writeFile(path.join(root,'public/api.js'),'export { api, setCsrf } from "../browser-api.mjs";\n');
for(const file of ['public/app.js','public/views.js']){const p=path.join(root,file);let s=await fs.readFile(p,'utf8');s=s.replaceAll('本地演示环境，数据可实际保存。','独立浏览器试用，数据保存在当前浏览器。').replaceAll('登录身份由服务端会话确认。','这是浏览器内的演示身份，可切换角色检查业务流程。').replaceAll('本地演示工作区','浏览器独立试用').replaceAll('当前为本地演示，外部集成尚未接入','仅当前浏览器保存 · 外部集成未接入');await fs.writeFile(p,s);}
const result=await build({entryPoints:[path.join(root,'entry.mjs')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',minify:true,alias:{'node:crypto':path.join(root,'crypto-browser.mjs')},external:['fs','path','crypto'],legalComments:'inline'});
let js=result.outputFiles[0].text.replaceAll('</script','<\\/script');
let css=await fs.readFile(path.join(root,'public/styles.css'),'utf8');
css+='\n:root{--trial-height:60px}body{padding-top:var(--trial-height)}#trial-notice{position:fixed;inset:0 0 auto;z-index:100;height:var(--trial-height);box-sizing:border-box;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#fff5e6;border-bottom:1px solid #ead7b7;color:#67431d;font-size:12px;line-height:1.5}#trial-notice div{display:flex;flex-shrink:0;gap:8px}#trial-notice button{font:inherit;border:1px solid #d5bb96;border-radius:6px;background:#fff;padding:6px 9px;color:#67431d;cursor:pointer}#trial-notice button:focus-visible{outline:3px solid #126bd1;outline-offset:2px}.sidebar{top:var(--trial-height);height:calc(100dvh - var(--trial-height))}.topbar{top:var(--trial-height)}.login-screen{min-height:calc(100dvh - var(--trial-height))}@media(max-width:700px){:root{--trial-height:100px}#trial-notice{padding:9px 14px;align-items:flex-start;flex-direction:column;justify-content:center;gap:5px;font-size:11px}#trial-notice button{padding:4px 8px}}';
let html=await fs.readFile(path.join(root,'public/index.html'),'utf8');
html=html.replace(/<link rel="stylesheet" href="\/styles.css"\s*\/>/,`<style>${css}</style>`).replace(/<script type="module" src="\/app.js"><\/script>/,()=>`<script type="module">${js}</script>`);
for(const asset of ['brand.png','favicon.png']){const data=await fs.readFile(path.join(root,'public/assets',asset));html=html.replaceAll('/assets/'+asset,'data:image/png;base64,'+data.toString('base64'));}
html=html.replace('<title>千帆 CRM · 工作台</title>','<title>千帆 CRM · 独立试用版</title>');
await fs.mkdir(path.join(root,'dist'),{recursive:true});await fs.writeFile(path.join(root,'dist/index.html'),html);
if(source!==root){await fs.mkdir(path.join(source,'artifacts'),{recursive:true});await fs.writeFile(path.join(source,'artifacts/千帆CRM-可交互离线试用版-20261023.html'),html);}
console.log(`Built self-contained trial HTML: ${(Buffer.byteLength(html)/1024/1024).toFixed(2)} MB`);
