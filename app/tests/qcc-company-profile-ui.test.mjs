import test from 'node:test';
import assert from 'node:assert/strict';
import {companyProfileDetails} from '../public/modules/customers.js';

test('企业资料展示简介、产品、年度人数及来源日期，零人数不当成未知',()=>{
 const html=companyProfileDetails({id:1,company_profile:{state:'ready',provider:'企查查 MCP',checked_at:'2026-11-02T01:00:00Z',details:{company_name:'隔离企业',company_description:'<script>简介</script>',main_products:'客户管理；分析服务',employee_scale:'100-199人',insured_count:0,annual_employees:'0',annual_report_year:'2025',source_updated_at:'2026-10-31',main_business:null}}},true);
 for(const label of ['企业简介','企业规模','人员规模','主营产品','年报从业人数','年报年度','来源更新时间','国标行业'])assert.ok(html.includes(label));
 assert.match(html,/参保人数<\/dt><dd>0<\/dd>/);assert.match(html,/年报从业人数<\/dt><dd>0<\/dd>/);
 assert.match(html,/主营业务<\/dt><dd>源接口未提供<\/dd>/);assert.match(html,/&lt;script&gt;简介&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.match(html,/data-action="refresh-company-profile"/);
});

test('未配置不展示查询状态，未披露年报不填默认人数，共享主档不泄露详情',()=>{
 const value={id:1,company_profile:{state:'not_configured',can_refresh:false,details:{},reason:'尚未配置企查查MCP'}};
 assert.doesNotMatch(companyProfileDetails(value,true),/未接入|尚未配置/);assert.doesNotMatch(companyProfileDetails(value,true),/data-action="refresh-company-profile"/);
 assert.equal(companyProfileDetails({...value,shared:true},true),'');
 const ready=companyProfileDetails({id:1,company_profile:{state:'ready',details:{company_name:'仅有企业名称',annual_employees:null,annual_report_year:null}}});
 assert.match(ready,/年报从业人数<\/dt><dd>源接口未提供<\/dd>/);assert.match(ready,/年报年度<\/dt><dd>源接口未提供<\/dd>/);
});
