import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './helpers/fixture.mjs';
import {relevantCatalog} from '../server/ai-intake.mjs';
import {createWordDocument} from '../server/word-document.mjs';

test('原始业务资料和合同附件按记录归属隔离，来源与日期可以回读',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),other=await f.login(3),date=new Date().toISOString();
  const contract=f.db.prepare('SELECT id FROM contracts WHERE owner_id=2 LIMIT 1').get();assert.ok(contract);
  f.db.prepare(`INSERT INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('QFCRM','合同总表','HT-TEST','contract',contract.id,JSON.stringify({amount:'123.45',note:'<script>test</script>'}),'QFCRM.xlsx','合同总表',2,date,'source-test-1','imported','');
  const id=Number(f.db.prepare('INSERT INTO attachments(entity,entity_id,filename,mime_type,size,sha256,content,source_path,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run('contract',contract.id,'合同.pdf','application/pdf',8,'unit-file',Buffer.from('%PDF-1.7'),'合同.pdf',date,1).lastInsertRowid);
  const sources=await f.request(`/source-records?entity=contract&id=${contract.id}`,{actor:sales});assert.equal(sources.status,200);assert.equal(sources.body.records[0].source_row,2);assert.equal(sources.body.records[0].imported_at,date);assert.equal(sources.body.records[0].raw.amount,'123.45');
  assert.equal((await f.request(`/source-records?entity=contract&id=${contract.id}`,{actor:other})).status,403);
  assert.equal((await f.request('/source-records',{actor:sales})).status,403);
  assert.equal((await f.request('/source-records',{actor:admin})).body.total,1);
  const attachment=await f.request(`/attachments/${id}`,{actor:sales});assert.equal(attachment.status,200);assert.equal(Buffer.from(attachment.body.base64,'base64').toString(),'%PDF-1.7');
  assert.equal((await f.request(`/attachments/${id}`,{actor:other})).status,403);
  assert.equal((await f.request(`/attachments/${id}`)).status,401);
});

test('大量真实客户目录只发送原文精确涉及的对象，关联仍保留完整身份',()=>{
  const records={users:[{id:1}],customers:Array.from({length:6000},(_,id)=>({id,name:`客户企业${String(id).padStart(6,'0')}有限责任公司`})),contacts:[{id:1,customer_id:5151,name:'测试联系人'}],opportunities:[{id:7,customer_id:5151,name:'实施项目',code:'SJ20261234'}],contracts:[]};
  const result=relevantCatalog(records,[{text:'SJ20261234 跟进材料'}],'');assert.deepEqual(result.customers.map(c=>c.id),[5151]);assert.equal(result.opportunities[0].id,7);assert.equal(result.contacts.length,1);assert.equal(result.users.length,1);
  assert.equal(relevantCatalog(records,[],'').customers.length,0);assert.equal(relevantCatalog(records,[],'',{intent:'customer',id:9}).customers[0].id,9);
});

test('导出的Word是有效可编辑DOCX，XML按文本编码且包含报价明细',()=>{
  const buffer=createWordDocument({title:'报价单',content:'测试客户 <甲>\n实施 2人天 原价1000元 折后1800元',status:'内部核对稿'});
  const result=spawnSync(process.env.CRM_PYTHON||'python',['-c',`import zipfile,io,sys,xml.etree.ElementTree as E,json
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
root=E.fromstring(z.read('word/document.xml'))
print(json.dumps([e.text for e in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')],ensure_ascii=True))`],{input:buffer,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);const text=JSON.parse(result.stdout).join('\n');assert.match(text,/测试客户 <甲>/);assert.match(text,/2人天/);assert.match(text,/1800/);
});

test('Excel导出错误标为A1时仍读取真实所有单元格，不静默截断业务资料',()=>{
  const create=spawnSync(process.env.CRM_PYTHON||'python',['-c',`import io,zipfile,base64
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
 rows=''.join('<row r="'+str(n)+'"><c r="A'+str(n)+'" t="inlineStr"><is><t>record-'+str(n)+'</t></is></c><c r="B'+str(n)+'"><v>'+str(n*123)+'</v></c></row>' for n in range(1,101))
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetData>'+rows+'</sheetData></worksheet>')
print(base64.b64encode(b.getvalue()).decode())`],{encoding:'utf8',windowsHide:true});
  assert.equal(create.status,0,create.stderr);
  const parsed=spawnSync(process.env.CRM_PYTHON||'python',[fileURLToPath(new URL('../scripts/extract-upload.py',import.meta.url))],{input:JSON.stringify({name:'业务.xlsx',base64:create.stdout.trim()}),encoding:'utf8',windowsHide:true});
  assert.equal(parsed.status,0,parsed.stderr);const value=JSON.parse(parsed.stdout);assert.ok(value.ok);assert.match(value.text,/record-100\t12300/);assert.equal(value.text.split('\n').length,101);
});
