// DingTalk's reviewed get_speaker_summary result contract. The task's creation
// acknowledgement is deliberately never accepted as a completed analysis.
export const qualityUnavailable=()=>({state:'unavailable',content:'',reason:'当前钉钉接入未提供会议质检接口，尚不能读取这项报告'});
export function parseSpeakerSummary(result){
 if(result===null)return {state:'unavailable',content:'',reason:'钉钉尚未生成这条听记的发言人观点'};
 if(!result||Array.isArray(result)||typeof result!=='object')return {state:'unsupported_shape',content:'',reason:'发言人总结返回格式尚未核验'};
 if(result.success===false)return {state:'failed',content:'',reason:'钉钉发言人总结任务未完成，请在钉钉核对任务状态'};
 if(result.status==='processing'&&result.innerStatus!=='Finished'&&!result.errorMsg)return {state:'pending',content:'',reason:'钉钉正在生成发言人总结，请稍后读取结果'};
 if(result.status==='completed'&&result.innerStatus==='Finished'&&result.success===true&&typeof result.taskId==='string'&&result.taskId.trim()&&result.errorMsg===''&&typeof result.content==='string'&&result.content.trim()&&result.content.length<=500000)return {state:'ready',content:result.content.trim(),reason:''};
 return {state:'unsupported_shape',content:'',reason:'发言人总结尚未返回可核验的完成状态与正文'};
}
export function isEmptySpeakerQuery(args,...outputs){
 if(args.slice(0,4).join(' ')!=='minutes speaker summary get')return false;
 return outputs.some(output=>{try{return JSON.parse(output).error?.message==='downstream query empty';}catch{return false;}});
}
export const speakerPending=()=>({state:'pending',content:'',reason:'已提交钉钉发言人总结任务，正在等待读取结果'});
export const speakerFailed=()=>({state:'failed',content:'',reason:'发言人观点暂未读取完成，本次未获取到可核验的结果'});
