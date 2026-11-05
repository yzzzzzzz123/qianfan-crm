import {parseTranscriptionPage} from './content.mjs';
function completed(response,id){
 const d=response.data;
 if(d?.taskUuid!==id||d.complete!==true||d.direction!=='0'||!Number.isSafeInteger(d.pages)||d.pages<1||!Array.isArray(d.paragraphList)||d.paragraphCount!==d.paragraphList.length||response.meta?.pagination?.endpoint_exhausted!==true)throw new Error('Transcript completeness was not verified');
 const paragraphList=d.paragraphList.map(p=>p&&p.paragraph===undefined&&Array.isArray(p.sentenceList)&&p.sentenceList.every(s=>typeof s?.sentence==='string')?{...p,paragraph:p.sentenceList.map(s=>s.sentence).join('')}:p);
 const content=parseTranscriptionPage({paragraphList,hasNext:false}).paragraphs.filter(p=>p.text.trim()).map(p=>`${p.speaker||'未识别发言人'}：${p.text}`).join('\n\n');
 if(content.length>500000)throw new Error('Transcript exceeds content limit');
 return content?{state:'ready',content,reason:''}:{state:'empty',content:'',reason:'钉钉本次未提供逐字稿正文，已同步的 AI 总结仍可查看'};
}
export function createTranscriptReader(call){
 return async id=>{
  const read=async()=>completed(await call(['minutes','+transcript','--id',id,'--direction','0','--page-limit','100']),id);
  try{return await read();}catch{
   try{
    // Verified live: some voice-call records return success=true,result={}.
    // The CLI shortcut calls this an incomplete page; it contains no text.
    const result=(await call(['minutes','get','transcription','--id',id])).result;
    if(result&&typeof result==='object'&&!Array.isArray(result)&&Object.keys(result).length===0)return {state:'empty',content:'',reason:'钉钉本次未提供逐字稿正文，已同步的 AI 总结仍可查看'};
    // A valid first page can follow a transient shortcut failure. Retry the
    // complete read; never display the first page as a complete transcript.
    if(Array.isArray(result?.paragraphList))return await read();
   }catch{}
   return {state:'failed',content:'',reason:'逐字稿暂未读取完成，已保留现有正文和 AI 总结'};
  }
 };
}
