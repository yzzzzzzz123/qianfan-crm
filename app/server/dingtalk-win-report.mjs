import {AppError} from './domain.mjs';

function deliveryError(message,{code='DINGTALK_FAILED',uncertain=false,retryable=false,cardCreated=false}={}){
  const error=new AppError(message,502);Object.assign(error,{code,uncertain,retryable,cardCreated});return error;
}
export function createWinReportSender({env=process.env,fetcher=fetch}={}){
  const separate=!!(env.DINGTALK_WIN_REPORT_CLIENT_ID||env.DINGTALK_WIN_REPORT_CLIENT_SECRET);
  const key=separate?env.DINGTALK_WIN_REPORT_CLIENT_ID:env.DINGTALK_CLIENT_ID;
  const secret=separate?env.DINGTALK_WIN_REPORT_CLIENT_SECRET:env.DINGTALK_CLIENT_SECRET;
  let cached;
  async function token(){
    if(cached?.until>Date.now())return cached.value;
    let response;
    try{response=await fetcher('https://api.dingtalk.com/v1.0/oauth2/accessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appKey:key,appSecret:secret}),signal:AbortSignal.timeout(20000),redirect:'error'});}
    catch{throw deliveryError('钉钉应用凭证获取失败，请核对连接后重试',{code:'TOKEN_NETWORK',retryable:true});}
    let result;try{result=await response.json();}catch{throw deliveryError('钉钉应用凭证响应无效',{code:'TOKEN_RESPONSE'});}
    if(!response.ok||typeof result.accessToken!=='string')throw deliveryError('钉钉应用凭证无效，请核对服务器配置',{code:'TOKEN_REJECTED'});
    cached={value:result.accessToken,until:Date.now()+Math.max(30,Number(result.expireIn||7200)-120)*1000};return cached.value;
  }
  return {
    configured:!!(key&&secret),
    async send(delivery,snapshot){
      if(!key||!secret)throw deliveryError('服务器尚未配置钉钉应用凭证',{code:'NOT_CONFIGURED'});
      const accessToken=await token();
      if(!snapshot.ding_user_id)throw deliveryError('商机负责人缺少已核验的钉钉身份，无法发送 @ 提醒',{code:'OWNER_IDENTITY_MISSING'});
      const md=value=>String(value??'').replace(/[\r\n]+/g,' ').replace(/[\\`*_{}\[\]()#+.!|<>]/g,'\\$&');
      const amount=(snapshot.amount/100).toFixed(2);
      const displayAmount=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(snapshot.amount/100);
      // Keep the published template's ordered slots; genuine @ delivery still uses atUserIds below.
      const cardParamMap={title:snapshot.test?'【测试】恭喜成单':'恭喜成单',owner_name:snapshot.owner_name,customer_name:snapshot.customer_name,sales_content:snapshot.sales_content,contract_no:snapshot.contract_no,amount,sign_date:snapshot.sign_date,won_at:snapshot.won_at,
        amount_text:`恭喜 <font colorTokenV2=common_blue1_color>@${md(snapshot.owner_name)}</font>`,owner_text:`销售内容：${md(snapshot.sales_content)}`,customer_text:`销售金额：¥${displayAmount}`,sales_text:'笃行致远，终有收获，再接再厉！',contract_text:'',date_text:''};
      const body={cardTemplateId:delivery.template_id,outTrackId:delivery.out_track_id,openSpaceId:`dtv1.card//IM_GROUP.${delivery.conversation_id}`,cardData:{cardParamMap},imGroupOpenSpaceModel:{supportForward:false},imGroupOpenDeliverModel:{robotCode:delivery.robot_code,atUserIds:{[snapshot.ding_user_id]:snapshot.owner_name}}};
      const existing=delivery.card_created===1;
      const payload=existing?{outTrackId:body.outTrackId,openSpaceId:body.openSpaceId,imGroupOpenDeliverModel:body.imGroupOpenDeliverModel}:body;
      let response;
      try{response=await fetcher(`https://api.dingtalk.com/v1.0/card/instances/${existing?'deliver':'createAndDeliver'}`,{method:'POST',headers:{'Content-Type':'application/json','x-acs-dingtalk-access-token':accessToken},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000),redirect:'error'});}
      catch{throw deliveryError('投放结果尚未确认，请先在群内核对后再决定补发',{code:'DELIVERY_UNCERTAIN',uncertain:true,cardCreated:existing});}
      let result;try{result=await response.json();}catch{throw deliveryError('投放响应无法确认，请先核对群内是否已有卡片',{code:'DELIVERY_RESPONSE',uncertain:true,cardCreated:existing});}
      if(!response.ok||result.code&&result.code!=='OK'){
        const code=String(result.code||`HTTP_${response.status}`).replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,100);
        if(response.status===429)throw deliveryError('钉钉限流，将稍后重试本群',{code,retryable:true});
        if(response.status>=500)throw deliveryError('钉钉投放结果不确定，请先核对群内卡片',{code,uncertain:true});
        if(response.status===401)cached=null;
        throw deliveryError('钉钉拒绝投放，请核对机器人、群和模板权限后补发',{code});
      }
      const receipt=result.result,created=existing||receipt?.outTrackId===delivery.out_track_id;
      const targets=existing?receipt:receipt?.deliverResults;
      const target=Array.isArray(targets)?targets.find(r=>r.spaceType==='IM_GROUP'&&r.spaceId===delivery.conversation_id):null;
      if(created&&target?.success===false)throw deliveryError('卡片已创建但目标群投放失败，请核对群权限',{code:'GROUP_DELIVERY_REJECTED',cardCreated:true});
      if(result.success!==true||!created||target?.success!==true)throw deliveryError('钉钉未返回匹配的群投放回执，请先核对投放结果',{code:'DELIVERY_RECEIPT',uncertain:true,cardCreated:created});
      return {outTrackId:delivery.out_track_id};
    },
  };
}
