const monthPattern=/^(\d{4})-(0[1-9]|1[0-2])$/;
const quarterPattern=/^(\d{4})Q([1-4])$/;

export function shiftCommissionPeriod(value,step){
  const offset=Number(step),month=String(value).match(monthPattern),quarter=String(value).match(quarterPattern);
  if(!Number.isInteger(offset)||!month&&!quarter&&!/^\d{4}$/.test(value))return value;
  const size=month?12:quarter?4:1;
  const absolute=Number(String(value).slice(0,4))*size+(month?Number(month[2])-1:quarter?Number(quarter[2])-1:0)+offset;
  const year=Math.floor(absolute/size),part=absolute-year*size+1;
  if(year<1900||year>9999)return value;
  return month?`${year}-${String(part).padStart(2,'0')}`:quarter?`${year}Q${part}`:String(year);
}

export function currentCommissionPeriod(value,today){
  return monthPattern.test(value)?today.slice(0,7):quarterPattern.test(value)?`${today.slice(0,4)}Q${Math.ceil(Number(today.slice(5,7))/3)}`:today.slice(0,4);
}
