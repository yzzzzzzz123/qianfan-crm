import test from 'node:test';
import assert from 'node:assert/strict';
import {createMinutesAudioPlayer,mountMinutesAssociation,minutesFilterQuery} from '../public/modules/minutes-controller-utils.js';
import {minutesDetailView} from '../public/modules/minutes-detail-view.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const response=(value='audio')=>({ok:true,blob:async()=>new Blob([value])});
function audioHarness(fetcher){
  const audio={paused:0,loaded:0,removed:0,pause(){this.paused++;},load(){this.loaded++;},removeAttribute(){this.removed++;}};
  const a={innerHTML:'',querySelector(){return this.innerHTML.includes('<audio')?audio:null;}},b={innerHTML:'',querySelector(){return null;}};
  const h={record:{id:1},epoch:1,context:'opportunity_id=1',actor:2,node:a,errors:[],revoked:[],created:0};
  const player=createMinutesAudioPlayer({getRecord:()=>h.record,getEpoch:()=>h.epoch,getContext:()=>h.context,getActor:()=>h.actor,getPlayer:()=>h.node,fetcher,onError:e=>h.errors.push(e.message),createUrl:()=>`blob:test-${++h.created}`,revokeUrl:url=>h.revoked.push(url)});
  return {...h,h,a,b,audio,player};
}
test('关闭A并打开B后，延迟返回的A录音不写入B播放器',async()=>{
  const pending=deferred(),f=audioHarness(url=>url.includes('/1/audio')?pending.promise:Promise.resolve(response('B')));
  const first=f.player.play(1);f.player.clear();f.h.record={id:2};f.h.epoch++;f.h.node=f.b;
  await f.player.play(2);const rendered=f.b.innerHTML;assert.match(rendered,/blob:test-1/);
  pending.resolve(response('A'));await first;assert.equal(f.b.innerHTML,rendered);assert.equal(f.h.created,1);assert.deepEqual(f.h.errors,[]);
});
test('录音body仍在读取时切换账号或查看范围，完成后不创建旧blob',async()=>{
  const pending=deferred(),f=audioHarness(async()=>({ok:true,blob:()=>pending.promise}));
  const play=f.player.play(1);await Promise.resolve();f.h.actor=3;f.h.context='customer_id=7';pending.resolve(new Blob(['old']));await play;
  assert.equal(f.h.created,0);assert.doesNotMatch(f.a.innerHTML,/<audio/);
});
test('关闭已播放录音时暂停、卸载媒体并释放地址，旧请求错误不会污染新详情',async()=>{
  const f=audioHarness(async()=>response());await f.player.play(1);f.h.node=null;f.player.clear();
  assert.equal(f.audio.paused,1);assert.equal(f.audio.loaded,1);assert.equal(f.audio.removed,1);assert.deepEqual(f.h.revoked,['blob:test-1']);
  const pending=deferred(),g=audioHarness(()=>pending.promise),play=g.player.play(1);g.player.clear();g.h.node=g.b;g.h.record={id:2};pending.resolve({ok:false,json:async()=>({error:'A专属错误'})});await play;assert.deepEqual(g.h.errors,[]);assert.equal(g.b.innerHTML,'');
});
test('当前录音失败可直接重试，错误原文被转义',async()=>{
  const f=audioHarness(async()=>({ok:false,json:async()=>({error:'<script>bad</script>'})}));await f.player.play(1);assert.match(f.a.innerHTML,/data-action="minutes-audio"/);assert.match(f.a.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(f.a.innerHTML,/<script>/);
});

class Select extends EventTarget {
  constructor(options=[]){super();this.options=options.map(([value,textContent])=>({value:String(value),textContent}));this._value=this.options[0]?.value||'';this.label='';this.addEventListener('change',()=>this.label=this.options.find(o=>o.value===this.value)?.textContent||'');}
  set value(value){this._value=this.options.some(o=>o.value===String(value))?String(value):'';}
  get value(){return this._value;}
  append(option){this.options.push(option);}
  replaceChildren(){this.options=[];this._value='';}
}
function associationHarness(t,record={revision:7,customer_id:3,opportunity_id:1}) {
  const old=globalThis.document;globalThis.document={createElement:()=>({value:'',textContent:'',disabled:false})};t.after(()=>{if(old===undefined)delete globalThis.document;else globalThis.document=old;});
  const customer=new Select([['','不指定客户'],[3,'甲客户'],[4,'乙客户']]),opportunity=new Select([['','不指定商机'],[1,'甲商机'],[2,'乙商机']]),preview={textContent:''};
  const form={dataset:{},elements:{customer_id:customer,opportunity_id:opportunity},querySelector:()=>preview,addEventListener(type,handler){this.change=handler;}};
  const S={customers:[{id:3,name:'甲客户'},{id:4,name:'乙客户'}],opportunities:[{id:1,customer_id:3,name:'甲商机'},{id:2,customer_id:4,name:'乙商机'}]};mountMinutesAssociation(form,S,record);return {form,customer,opportunity,preview};
}
test('客户商机联动同时更新提交值和搜索框显示，按客户过滤候选并给出保存预览',t=>{
  const f=associationHarness(t);assert.equal(f.form.dataset.revision,'7');assert.equal(f.customer.value,'3');assert.match(f.opportunity.label,/甲商机/);
  f.customer.value='4';f.form.change({target:f.customer});assert.equal(f.opportunity.value,'');assert.equal(f.opportunity.label,'不指定商机');assert.deepEqual(f.opportunity.options.map(o=>o.value),['','2']);
  f.customer.value='';f.form.change({target:f.customer});f.opportunity.value='1';f.form.change({target:f.opportunity});assert.equal(f.customer.value,'3');assert.equal(f.customer.label,'甲客户');assert.match(f.preview.textContent,/甲客户 \/ 甲商机/);
});
test('原关联已移交时保留原ID，主动换客户才清旧商机，避免打开表单即取消关联',t=>{
  const f=associationHarness(t,{revision:9,customer_id:99,opportunity_id:98});assert.equal(f.customer.value,'99');assert.equal(f.opportunity.value,'98');assert.match(f.opportunity.label,/原关联/);
  f.customer.value='3';f.form.change({target:f.customer});assert.equal(f.opportunity.value,'');assert.match(f.preview.textContent,/仅关联客户/);
});
test('查询携带组合筛选和原业务日期，详情历史只读不提供新正文及录音读取按钮',()=>{
  const q=minutesFilterQuery({minutesQ:'客户预算',minutesSource:'source-a',minutesCustomer:'3',minutesOpportunity:'1',minutesLinkState:'linked',minutesContentState:'failed',minutesMediaState:'unsupported',minutesFrom:'2026-10-01',minutesTo:'2026-10-31',minutesPageSize:30},2);
  assert.equal(q.get('page'),'2');assert.equal(q.get('page_size'),'30');assert.equal(q.get('content_state'),'failed');assert.equal(q.get('from'),'2026-10-01');assert.equal(q.get('opportunity_id'),'1');
  const S={minutes:{sources:[]},customers:[],opportunities:[]},r={id:1,source_id:'old',title:'<客户会议>',start_time:'2026-10-15T10:00:00Z',duration_ms:60000,external_id:'a',can_manage:true,can_refresh:false,media_state:'available',artifacts:{summary:{state:'failed',content:'保留的正文'}}};
  const html=minutesDetailView(S,r,'customer_id=3');assert.match(html,/minutes-context-back/);assert.match(html,/&lt;客户会议&gt;/);assert.doesNotMatch(html,/data-action="minutes-audio"|data-action="minutes-artifact-retry"/);assert.match(html,/上次成功读取/);
});
