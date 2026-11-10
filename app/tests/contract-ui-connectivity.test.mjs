import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionsPage,collectionDetail,contractAnalysisPanel,formWorkflow} from '../public/modules/contract-workflow.js';
import {formContent} from '../public/views.js';

function state(role='admin'){
 const c={id:1,customer_id:1,owner_id:2,collaborator_pm:3,name:'隔离合同',code:'HT-UI-1',lifecycle:'已归档',amount:10000,collected:5000,outstanding:5000,received_status:'部分回款',product_names:['授权','交付'],created_at:'2026-11-01T00:00:00Z',attachments:[],items:[],payments:[
  {id:91,status:'待到账',amount:5000,product_amount:null,promise_date:'2026-11-03'},
  {id:92,status:'已到账',amount:3000,product_amount:2000,pay_date:'2026-11-01'},
  {id:93,status:'已到账',amount:2000,product_amount:null,pay_date:'2026-11-02'},
 ]};
 return {actor:{id:role==='pm'?3:role==='sales'?2:1,role},today:'2026-11-02',contracts:[c],customers:[{id:1,name:'隔离客户'}],users:[{id:1,name:'管理员',role:'admin',active:1},{id:2,name:'销售甲',role:'sales',active:1},{id:3,name:'项目经理',role:'pm',active:1}],rules:{},opportunities:[]};
}
const page={view:'collections',q:'',owner:''};

test('仅合同授权的PM可以显示最小客户名称，不需要完整客户档案',()=>{
 const S=state('pm');S.customers=[];S.contracts[0].customer_name='仅名称客户<核对>';
 const html=collectionDetail(S,1);
 assert.match(html,/仅名称客户&lt;核对&gt;/);
 assert.doesNotMatch(html,/仅名称客户<核对>/);
 assert.deepEqual(S.customers,[]);
});

test('已到账回款保留产品分配入口，待到账仅确认及维护计划，未知分配不能显示为零',()=>{
 const html=collectionDetail(state(),1);
 for(const id of [92,93])assert.match(html,new RegExp('data-action="payment-allocation" data-id="'+id+'"'));
 assert.doesNotMatch(html,/data-action="payment-allocation" data-id="91"/);
 assert.match(html,/data-action="collection-receive" data-id="91"/);
 assert.match(html,/data-action="payment-plan" data-id="91"/);
 assert.doesNotMatch(html,/data-action="(?:collection-receive|payment-plan)" data-id="9[23]"/);
 assert.match(html,/产品 ¥20(?:\.00)? · 服务 ¥10(?:\.00)?/);
 assert.match(html,/提成分配待补/);
});

test('销售维护本人财务，关联PM仅维护项目，其他销售不能操作',()=>{
 const sales=state('sales'),html=collectionDetail(sales,1);
 assert.match(html,/data-action="new-payment"/);assert.match(html,/data-action="contract-maintain"/);
 assert.match(formContent(sales,'payment-allocation',92),/<form/);assert.match(formWorkflow(sales,'contract-extract',1),/请先上传合同原件/);
 sales.contracts[0].attachments=[{id:99,filename:'合同.pdf',mime_type:'application/pdf'}];assert.match(formWorkflow(sales,'contract-extract',1),/<form/);
 const pm=state('pm'),detail=collectionDetail(pm,1);
 assert.doesNotMatch(detail,/data-action="(?:payment-allocation|new-payment|collection-receive|payment-plan)"/);
 assert.match(detail,/data-action="contract-project" data-id="1"/);
 assert.doesNotMatch(formContent(pm,'payment-allocation',92),/<form/);assert.doesNotMatch(formWorkflow(pm,'contract-extract',1),/<form/);
});

test('合同附件AI展示使用分金额，未知日期金额保持未知，原件文字转义且PM不读取正文',()=>{
 const S=state(),c=S.contracts[0];
 c.contract_analysis={state:'ready',filename:'原件.pdf',result:{total_amount:12345,summary:'<script>原件文字</script>',payment_stages:[{name:'首款',amount:2345,due_date:'2026-11-03',condition:'签订后付款',evidence:'原条款'}, {name:'验收款',amount:null,due_date:null,condition:'验收后付款',evidence:'日期未明确'}],questions:['阶段合计待核对']}};
 const html=contractAnalysisPanel(S,c);
 assert.match(html,/123\.45/);assert.match(html,/23\.45/);assert.match(html,/待补充/);assert.match(html,/阶段合计待核对/);
 assert.match(html,/&lt;script&gt;原件文字&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.equal(contractAnalysisPanel({...S,actor:{id:3,role:'pm'}},c),'');
 c.contract_analysis={state:'failed',reason:'原件解析失败，请重新提取',result:{total_amount:null,payment_stages:[],summary:'',questions:[]}};
 assert.match(contractAnalysisPanel(S,c),/原件解析失败，请重新提取/);
 assert.doesNotMatch(contractAnalysisPanel(S,c),/识别合同总金额/);
});
