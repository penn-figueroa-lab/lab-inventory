const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const headers={
Items:'id name cat qty unit loc minQty img desc status usedBy serial displayId shared consumable',
Orders:'id store item link qty unit price cat requestedBy reason urgency date status requestedByEmail',
Deliveries:'id item qty unit from receivedBy date tracking status',
Checkouts:'id itemId item user out ret status checkedOutByEmail groupEmails',
Settings:'key value',AuditLog:'date user email action details',SlackQueue:'time emoji title details fields'};
function harness(options={}){
 const db={},events=new Map(),calls=[],fault={batch:false,calendar:false,locked:false};
 let seq=1;
 class Range{
  constructor(sheet,row,col,n=1,m=1){Object.assign(this,{sheet,row,col,n,m});}
  getValues(){return Array.from({length:this.n},(_,i)=>Array.from({length:this.m},(_,j)=>this.sheet.data[this.row-1+i]?.[this.col-1+j]??''));}
  setValues(values){delete this.sheet.snapshot;values.forEach((r,i)=>{this.sheet.data[this.row-1+i]??=[];r.forEach((v,j)=>this.sheet.data[this.row-1+i][this.col-1+j]=v);});return this;}
  setValue(v){return this.setValues([[v]]);}
  setNumberFormat(){return this;}
 }
 class Sheet{
  constructor(name,data=[]){this.name=name;this.id=seq++;this.data=data;}
  getRange(...args){return new Range(this,...args);}
  getDataRange(){if(options.staleSpreadsheetReads){this.snapshot??=structuredClone(this.data);return {getValues:()=>structuredClone(this.snapshot)};}return this.getRange(1,1,Math.max(1,this.data.length),Math.max(1,this.getLastColumn()));}
  getLastColumn(){return Math.max(0,...this.data.map(r=>r.length));}
  getLastRow(){return this.data.length;}
  getSheetId(){return this.id;}
  appendRow(row){this.data.push([...row]);delete this.snapshot;}
  deleteRow(row){this.data.splice(row-1,1);}
  deleteRows(row,count){this.data.splice(row-1,count);}
 }
 for(const [name,h] of Object.entries(headers)) db[name]=new Sheet(name,[h.split(' ')]);
 db.Settings.data=[['categories','["Robots"]'],['admins','["admin@engineering.upenn.edu"]'],['slack_mode','off'],['members','[]'],['categories','["Robots","Cameras"]']];
 const spreadsheet={getSheetByName:n=>db[n]||null,insertSheet:n=>db[n]=new Sheet(n),getId:()=> 'test-sheet'};
 const lock={waitLock(){if(fault.locked)throw Error('Lock timed out');},tryLock(){return !fault.locked;},releaseLock(){}};
 const context={console,Date,Set,Map,JSON,Math,Number,String,Array,Error,PropertiesService:{getScriptProperties:()=>({getProperty:()=>options.webhook||''})},
  SpreadsheetApp:{getActiveSpreadsheet:()=>spreadsheet,flush(){}},LockService:{getScriptLock:()=>lock},Logger:{log(){}},
  Utilities:{getUuid:()=>crypto.randomUUID(),formatDate(d,tz,pattern){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(p=>[p.type,p.value]));const date=`${p.year}-${p.month}-${p.day}`;return pattern==='yyyy-MM-dd'?date:`${date}T${p.hour}:${p.minute}`;}},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({setMimeType(){return JSON.parse(s);}})},
  UrlFetchApp:{fetch(url,args){calls.push({url,args});return {getContentText:()=> '{}',getResponseCode:()=>options.slackStatus||200};}},
  Calendar:{Events:{get(c,id){if(fault.calendar)throw Error('503 unavailable');if(!events.has(id))throw Error('404 not found');return events.get(id);},insert(e,c){if(fault.calendar)throw Error('503 unavailable');if(events.has(e.id))throw Error('409 conflict');events.set(e.id,e);return e;},patch(e,c,id){if(fault.calendar)throw Error('503 unavailable');events.set(id,{...events.get(id),...e});},remove(c,id){if(fault.calendar)throw Error('503 unavailable');events.delete(id);}},Calendars:{get:()=>({id:'lab-calendar'}),insert:()=>({id:'lab-calendar'})}},
  Sheets:{Spreadsheets:{Values:{get(id,range){const name=range.slice(1,-1).replace(/''/g,"'");return {values:structuredClone(db[name].data)};}},batchUpdate({requests}){
    if(fault.batch)throw Error('Simulated batch failure');
    const copy=Object.fromEntries(Object.values(db).map(s=>[s.id,structuredClone(s.data)]));
    for(const req of requests){const b=req.appendCells||req.updateCells, id=b.sheetId??b.range.sheetId;const rows=b.rows.map(r=>r.values.map(c=>{const v=c.userEnteredValue;return v.stringValue??v.numberValue??v.boolValue??'';}));if(req.appendCells)copy[id].push(...rows);else rows.forEach((r,j)=>{const target=copy[id][b.range.startRowIndex+j];r.forEach((v,k)=>target[(b.range.startColumnIndex||0)+k]=v);});}
    Object.values(db).forEach(s=>s.data=copy[s.id]);return {};
  }}}
 };
 vm.createContext(context);vm.runInContext(fs.readFileSync('google-apps-script.js','utf8'),context);
 context.verifyToken=token=>token==='bad'?null:{email:token||'admin@engineering.upenn.edu',name:token?.split('@')[0]||'Admin'};
 context.migrateLabTrackV2();context.setSetting_('calendar_id','lab-calendar');context.setSetting_('scheduling_enabled','true');
 function add(name,obj){vm.runInContext('transactionalData_ = {}',context);const h=db[name].data[0];db[name].appendRow(h.map(k=>obj[k]??''));return obj;}
 function item(overrides={}){return add('Items',{id:'item1',name:'Robot',cat:'Robots',qty:1,unit:'units',loc:'Lab A',minQty:0,img:'',link:'',status:'Available',usedBy:'[]',displayId:'RM-000001',shared:false,consumable:false,...overrides});}
 function order(overrides={}){return add('Orders',{id:'order1',item:'Robot',store:'Supplier',qty:2,unit:'units',cat:'Robots',link:'https://example.com/robot',img:'https://example.com/robot.jpg',status:'Ordered',requestedByEmail:'member@engineering.upenn.edu',...overrides});}
 function post(action,body={},email='admin@engineering.upenn.edu'){Object.values(db).forEach(s=>delete s.snapshot);return context.doPost({postData:{contents:JSON.stringify({action,token:email,...body})}});}
 const rows=name=>context.rows_(name);
 return {context,db,events,fault,calls,add,item,order,post,rows};
}
module.exports={harness};
