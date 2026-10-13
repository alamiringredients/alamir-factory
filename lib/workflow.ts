export {productionOperation,productionLink,decodeOrder,linkGuard} from './production';
import master from './master.json';
import {catalogLists,priceSnapshot} from './catalog';
export {defaultCatalog,validateCatalog} from './catalog';
export const roles:Record<string,string>={admin:'مدير النظام',security:'الاستقبال والأمن',quality:'الجودة',scale:'الميزان',production:'الإنتاج',warehouse:'المخازن',viewer:'متابعة وتقارير'};
export const statuses:Record<string,string>={quality:'انتظار الجودة',gross:'انتظار الوزن القائم',unload:'انتظار الإنتاج',empty:'انتظار الوزن الفارغ',done:'مكتملة',rejected:'مرفوضة'};
export const stages=[['arrival','1.1','الاستقبال'],['quality','1.2','الجودة'],['gross','1.3','الوزن القائم'],['unload','1.4','الإنتاج'],['empty','1.5','الوزن الفارغ']];
export function documentNumber(kind:'ticket'|'inspection'|'order',id:number){if(!Number.isSafeInteger(id)||id<1)throw Error('رقم سجل غير صالح');const prefixes={ticket:'FR',inspection:'QI',order:'OP'};return prefixes[kind]+'-'+String(id).padStart(7,'0');}
export function text(v:unknown,label:string){if(typeof v!=='string'||!v.trim()||v.trim().length>160)throw Error('أدخل '+label+' بشكل صحيح');return v.trim();}
function num(v:unknown,label:string,min=0,max=1e9){if(v===''||v===null||v===undefined||!Number.isFinite(Number(v))||Number(v)<min||Number(v)>max)throw Error('قيمة غير صالحة: '+label);return Number(v);}
function pick(v:unknown,list:any[],label:string){const x=list.find(r=>r[0]===v);if(!x)throw Error('اختر '+label+' من القائمة');return x;}
export function createData(b:any,now:string,catalog?:any){const lists=catalog?catalogLists(catalog):master;const fruit=pick(b.fruit,lists.fruits,'الصنف'),supplier=pick(b.supplier,lists.suppliers,'المورد'),truck=pick(b.truck,lists.trucks,'السيارة');const containers=num(b.containers,'عدد العبوات',0,1e6);if(!Number.isInteger(containers))throw Error('عدد العبوات يجب أن يكون صحيحًا');return {...(catalog?priceSnapshot(catalog,String(fruit[1]),now):{}),fruitEn:fruit[2]||'',plateKey:normalizePlate(text(b.plate,'لوحة السيارة')),fruit:fruit[0],fruitCode:fruit[1],supplier:supplier[0],supplierCode:supplier[1],truck:truck[0],estimate:truck[1],plate:text(b.plate,'لوحة السيارة'),driver:text(b.driver,'السائق'),origin:text(b.origin,'المنشأ'),containers,unit:'KG',arrival:now};}
export function transition(row:any,action:string,b:any,role:string,now:string,link?:any){const permissions:Record<string,string>={quality:'quality',gross:'scale',unload:'production',empty:'scale'};if(role!=='admin'&&permissions[action]!==role)throw Error('لا توجد صلاحية لتنفيذ هذا الإجراء');if(row.status!==action)throw Error('المرحلة تغيرت أو الإجراء غير متاح');const d={...row.data};let status='';
if(action==='quality'){if(!['A','R'].includes(b.decision))throw Error('اختر A أو R');d.decision=b.decision;d.inspection=d.inspection||documentNumber('inspection',row.id);d.deduction=(b.deduction===undefined||b.deduction===null||String(b.deduction).trim()==='')?0:num(b.deduction,'نسبة الخصم',0,100);d.qualityAt=now;d.reason=b.decision==='R'?text(b.reason,'سبب الرفض'):'';status=b.decision==='R'?'rejected':'gross';}
else if(action==='gross'){d.gross=num(b.gross,'الوزن القائم',0.001);d.grossAt=now;status='unload';}
else if(action==='unload'){if(b.confirm!==true)throw Error('أكد إتمام التفريغ');if(link)Object.assign(d,link);else d.order=d.order||documentNumber('order',row.id);d.unloadAt=now;status='empty';}
else if(action==='empty'){d.empty=num(b.empty,'الوزن الفارغ',0.001);if(d.empty>=d.gross)throw Error('الوزن الفارغ يجب أن يكون أقل من الوزن القائم');d.emptyAt=now;d.net=d.gross-d.empty;d.payable=d.net*(1-d.deduction/100);d.amount=d.unitPrice==null?null:Math.round(d.payable*d.unitPrice*100)/100;status='done';}
else throw Error('إجراء غير معروف');return {data:d,status};}

const plateReplacements:[string,string][]=[[' ',''],['\t',''],['\n',''],['\r',''],['\u00a0',''],['-',''],...Array.from('٠١٢٣٤٥٦٧٨٩').map((c,i)=>[c,String(i)] as [string,string]),...Array.from('۰۱۲۳۴۵۶۷۸۹').map((c,i)=>[c,String(i)] as [string,string])];
export function normalizePlate(value:string){let key=value.toLowerCase();for(const [a,b] of plateReplacements)key=key.split(a).join(b);if(!key)throw Error('أدخل رقم لوحة صالح');return key;}
// The SQL is built from fixed replacements, never from user input; legacy records are normalized too.
const legacyPlateSql=plateReplacements.reduce((sql,[a,b])=>`replace(${sql},'${a}','${b}')`,"lower(json_extract(data,'$.plate'))");
export const createTicketSql=`INSERT INTO tickets (demo,version,status,data,history,created_at) SELECT ?,1,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM tickets WHERE demo=? AND coalesce(json_extract(data,'$.plateKey'),${legacyPlateSql})=? AND created_at>?)`;
export const duplicatePlateMessage='السيارة مسجلة بالفعل خلال آخر 4 ساعات. افتح التذكرة الحالية لاستكمال الإجراءات، أو أعد التسجيل بعد انقضاء المدة.';
