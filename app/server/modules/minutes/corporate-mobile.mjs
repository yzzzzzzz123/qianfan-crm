// Only complete international phone identities from trusted, online DingTalk
// responses are comparable. Never guess a country or accept masked numbers.
export function corporateMobile(mobile,countryCode){
 if(typeof mobile!=='string'||typeof countryCode!=='string')return null;
 const country=countryCode.trim().replace(/^\+/,''),number=mobile.trim().replace(/[ -]/g,'');
 if(!/^[1-9]\d{0,2}$/.test(country)||!/^\d{6,14}$/.test(number)||country.length+number.length>15)return null;
 return `${country}:${number}`;
}
