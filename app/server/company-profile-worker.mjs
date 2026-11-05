// The executor checks its runtime authority on every drain, including timer
// wakes. Local automation is a narrow, owner-authorized project exception.
export function createCompanyProfileWorker({queue,configured,deployment='local',localAutomation,intervalMs=5000,gapMs=400,logger=console}={}) {
  const automatic=configured===true&&(deployment==='production'||(localAutomation?.authorized===true&&localAutomation?.runtimeChecked===true&&localAutomation?.scope==='qianfan-company-profile'));
  let stopped=false,timer=null,active=null,activeManual=false,activeCustomerId=null,pendingManual=0;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function kick({manual=false,maxJobs=Infinity,customerId}={}) {
    if(stopped||!configured||(!manual&&!automatic))return Promise.resolve({state:'disabled'});
    if(active){
      if(manual&&(!activeManual||(activeCustomerId!==null&&activeCustomerId!==customerId))){
        pendingManual++;
        return active.catch(()=>{}).then(()=>{pendingManual--;return kick({manual,maxJobs,customerId});});
      }
      return active;
    }
    activeManual=manual;activeCustomerId=customerId??null;
    active=(async()=>{
      let last={state:'idle'},processed=0;
      while(!stopped&&processed<maxJobs&&(!customerId||processed<1)) {
        if(!manual&&pendingManual>0)break;
        last=await queue.runNext({manual,...(customerId?{customerId}:{})});
        if(last.state!=='processed')break;
        processed++;
        if(gapMs>0)await sleep(gapMs);
      }
      return {...last,processed};
    })().finally(()=>{active=null;activeManual=false;activeCustomerId=null;});
    return active;
  }
  function startScheduler() {
    if(!automatic)return ()=>{};
    queue.enqueueAll();
    const tick=async()=>{
      if(stopped)return;
      try{await kick();}catch{logger.error?.('企业资料队列执行未完成，将保留进度稍后继续');}
      if(!stopped)timer=setTimeout(tick,intervalMs);
    };
    timer=setTimeout(tick,0);
    return stop;
  }
  function stop(){stopped=true;clearTimeout(timer);}
  async function shutdown(){stop();await active?.catch(()=>{});}
  return {automatic,kick,startScheduler,shutdown};
}
