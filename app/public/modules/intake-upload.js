import {esc,icon} from '../ui.js';

const extensions=/\.(pdf|xlsx|md|markdown|txt|csv|json|docx|png|jpe?g|webp)$/i;
const queues=new WeakMap();
const drafts=new Map();
const draftKey=form=>form.elements.previous_batch_id?.value||'new';
function draft(form) {
  const key=draftKey(form);
  if(!drafts.has(key))drafts.set(key,{files:[],text:'',key:form.dataset.key,busy:false});
  return drafts.get(key);
}
const sizeLabel=bytes=>bytes<1024*1024?`${Math.max(1,Math.ceil(bytes/1024))} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;

function show(form,files) {
  const transfer=new DataTransfer();files.forEach(file=>transfer.items.add(file));
  form.querySelector('[name=files]').files=transfer.files;queues.set(form,files);draft(form).files=files;
  form.querySelector('[data-ai-file-list]').innerHTML=files.map((file,index)=>`<li><span class="ai-file-symbol">${icon('note')}</span><span class="ai-file-info"><b>${esc(file.name)}</b><small>${sizeLabel(file.size)}</small></span><button type="button" class="icon-btn" data-action="ai-remove-file" data-index="${index}" aria-label="移除 ${esc(file.name)}">${icon('close')}</button></li>`).join('');
  form.querySelector('[data-ai-file-status]').textContent=files.length?`${files.length} 个文件 · ${sizeLabel(files.reduce((n,f)=>n+f.size,0))}`:'';
  form.querySelector('.ai-dropzone').classList.toggle('has-files',files.length>0);
}
export function restoreIntakeUpload() {
  const form=document.querySelector('form[data-form="ai-intake"]');if(!form)return;
  const state=draft(form);form.dataset.key=state.key;form.elements.text.value=state.text;show(form,state.files);
  form.elements.text.disabled=state.busy;
  form.toggleAttribute('aria-busy',state.busy);if(state.busy)form.setAttribute('aria-busy','true');
  const submit=form.querySelector('[type=submit]');submit.disabled=state.busy;
  if(state.busy)submit.innerHTML='<span class="loader mini"></span> 正在识别…';
}
export function setIntakeBusy(form,busy) {
  const state=busy?draft(form):drafts.get(draftKey(form));
  if(state)state.busy=busy;
  for(const current of document.querySelectorAll('form[data-form="ai-intake"]'))if(draftKey(current)===draftKey(form)) {
    if(busy)current.setAttribute('aria-busy','true');else current.removeAttribute('aria-busy');
    current.elements.text.disabled=busy;
    const submit=current.querySelector('[type=submit]');submit.disabled=busy;
    submit.innerHTML=busy?'<span class="loader mini"></span> 正在识别…':`${icon('note')}识别资料`;
  }
}
export function clearIntakeUpload(form) {drafts.delete(draftKey(form));}

export function bindIntakeUpload() {
  function busy(form) {return form.getAttribute('aria-busy')==='true';}
  function error(form,message) {form.querySelector('.form-error').textContent=message;}
  function add(form,incoming) {
    if(busy(form))return;
    const previous=queues.get(form)||[],merged=[...previous];
    for(const file of incoming)if(!merged.some(f=>f.name===file.name&&f.size===file.size&&f.lastModified===file.lastModified))merged.push(file);
    let message='';
    if(incoming.some(file=>!extensions.test(file.name)))message='此文件类型暂不支持，请上传 PDF、Excel、Word、Markdown、CSV、JSON 或图片。';
    else if(merged.some(file=>!file.size))message='不能上传空文件，请检查资料内容。';
    else if(merged.length>5)message='一次最多接收5个文件，请分批上传。';
    else if(merged.some(file=>file.size>10*1024*1024)||merged.reduce((n,file)=>n+file.size,0)>20*1024*1024)message='单文件须在10MB以内，整批合计须在20MB以内。';
    if(message) {show(form,previous);error(form,message);return;}
    error(form,'');show(form,merged);
  }
  document.addEventListener('change',event=>{
    const input=event.target.closest('form[data-form="ai-intake"] input[name=files]');
    if(input)add(input.form,[...input.files]);
  });
  document.addEventListener('input',event=>{
    const input=event.target.closest('form[data-form="ai-intake"] textarea[name=text]');
    if(input)draft(input.form).text=input.value;
  });
  document.addEventListener('click',event=>{
    const control=event.target.closest('[data-action="ai-pick-files"],[data-action="ai-remove-file"]');
    if(!control)return;const form=control.closest('form[data-form="ai-intake"]');if(!form||busy(form))return;
    if(control.dataset.action==='ai-pick-files')form.querySelector('[name=files]').click();
    else {error(form,'');show(form,(queues.get(form)||[]).filter((_,index)=>index!==Number(control.dataset.index)));}
  });
  for(const type of ['dragenter','dragover','dragleave','drop'])document.addEventListener(type,event=>{
    const form=event.target.closest('form[data-form="ai-intake"]');
    if(!form||!Array.from(event.dataTransfer?.types||[]).includes('Files'))return;
    event.preventDefault();const zone=form.querySelector('.ai-dropzone');
    if(type==='dragenter'||type==='dragover') {if(!busy(form))zone.classList.add('dragging');if(event.dataTransfer)event.dataTransfer.dropEffect=busy(form)?'none':'copy';}
    if(type==='dragleave'&&!form.contains(event.relatedTarget))zone.classList.remove('dragging');
    if(type==='drop') {zone.classList.remove('dragging');add(form,[...event.dataTransfer.files]);}
  });
  document.addEventListener('paste',event=>{
    const form=event.target.closest('form[data-form="ai-intake"]');
    const files=[...(event.clipboardData?.files||[])];if(!form||!files.length)return;
    event.preventDefault();add(form,files);
  });
}
