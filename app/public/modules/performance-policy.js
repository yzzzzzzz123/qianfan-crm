export const performanceDefaults = Object.freeze({
  process_weight:70,result_weight:30,cap:50,
  meeting:0.5,visit:1,quote:0.5,funnel_low:0.5,funnel_mid:2,funnel_high:3,
});
export const performancePolicy=value=>({...performanceDefaults,...value});
