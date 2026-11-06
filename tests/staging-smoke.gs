// Append this file ONLY to an isolated staging project, defining STAGING_SPREADSHEET_ID
// as the copied spreadsheet's ID in that project. Never install this on production.
function runLabTrackStagingSmoke() {
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  if(typeof STAGING_SPREADSHEET_ID==="undefined" || ss.getId()!==STAGING_SPREADSHEET_ID || !ss.getName().startsWith("LabTrack Staging")) throw new Error("Staging-only test: wrong spreadsheet");
  setSetting_("slack_mode","off");
  migrateLabTrackV2();
  const calendarId=setupLabEquipmentCalendar();
  Calendar.Calendars.patch({summary:"Lab Equipment — Staging"},calendarId);
  enableLabScheduling();
  const user={email:settingList_("admins")[0],name:"Staging Test"};
  const order={id:newId_(),item:"STAGING TEST — Robot",store:"Test Supplier",link:"https://example.com/robot",img:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcN8AAAAASUVORK5CYII=",qty:2,unit:"units",cat:"Robots & Motors",status:"Ordered",requestedByEmail:user.email};
  appendRow("Orders",order,[]);
  const payload={orderId:order.id,mode:"individual",item:{name:order.item,qty:2,unit:"units",loc:"STAGING ONLY",cat:order.cat},serials:["STAGE-A","STAGE-B"]};
  const receipt=receiveOrder_(payload,user,true);
  const retry=receiveOrder_(payload,user,true);
  if(receipt.receipt.id!==retry.receipt.id || receipt.items.length!==2 || receipt.items[0].img!==order.img)throw new Error("Receipt persistence/retry failed");
  const date=Utilities.formatDate(new Date(Date.now()+86400000),LAB_TZ,"yyyy-MM-dd");
  const startLocal=date+"T10:00",endLocal=date+"T11:00";
  const request={requestId:newId_(),itemId:receipt.items[0].id,qty:1,startLocal,endLocal,repeatUntil:shiftLocal_(startLocal,14).slice(0,10)};
  const series=reservationOperation_("createReservation",request,user,true);
  if(series.reservations.length!==3 || series.reservations.some(r=>r.syncState!=="Synced"))throw new Error("Calendar series synchronization failed: "+JSON.stringify(series));
  let conflict=false;try{reservationOperation_("createReservation",Object.assign({},request,{requestId:newId_()}),user,true);}catch(e){conflict=/conflict/.test(e.message);}
  if(!conflict)throw new Error("Overlapping equipment reservation was accepted");
  const updated=reservationOperation_("updateReservation",{requestId:newId_(),id:series.ids[0],scope:"future",qty:1,startLocal:date+"T12:00",endLocal:date+"T13:00",notes:"Staging series edit"},user,true);
  if(updated.reservations.some(r=>r.syncState!=="Synced"))throw new Error("Calendar update failed");
  reservationOperation_("cancelReservation",{requestId:newId_(),id:series.ids[0],scope:"future"},user,true);
  const active={id:newId_(),itemId:receipt.items[1].id,qty:1,user:user.name,email:user.email,start:new Date(Date.now()-60000).toISOString(),end:new Date(Date.now()+3600000).toISOString(),status:"Booked",syncState:"Pending"};
  active.originalEnd=active.end;active.eventId="lt"+active.id;appendRow("Reservations",active,[]);
  const finished=reservationOperation_("finishReservation",{requestId:newId_(),id:active.id},user,true);
  if(finished.reservations[0].status!=="Finished" || finished.reservations[0].syncState!=="Synced")throw new Error("Early finish failed");
  const visible=reservationOperation_("createReservation",{requestId:newId_(),itemId:receipt.items[0].id,qty:1,startLocal,endLocal,notes:"Staging UI verification booking"},user,true);
  const result={ok:true,spreadsheetId:ss.getId(),calendarId,receiptId:receipt.receipt.id,itemIds:receipt.items.map(i=>i.id),reservationId:visible.ids[0],checks:["atomic receipt","idempotent retry","images and links","weekly series","quantity conflict","series edit","series cancel","early finish","Calendar readback"]};
  setSetting_("staging_smoke_result",JSON.stringify(result));
  Logger.log(JSON.stringify(result));
  return result;
}

function runLabTrackStagingRecovery() {
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  if(typeof STAGING_SPREADSHEET_ID==="undefined" || ss.getId()!==STAGING_SPREADSHEET_ID || !ss.getName().startsWith("LabTrack Staging")) throw new Error("Staging-only test: wrong spreadsheet");
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  const calendarId=readSettings_().calendar_id;
  try {
    const prior=JSON.parse(readSettings_().staging_smoke_result),user={email:settingList_("admins")[0],name:"Staging Recovery"};
    const date=Utilities.formatDate(new Date(Date.now()+86400000),LAB_TZ,"yyyy-MM-dd");
    setSetting_("calendar_id","unavailable-staging-calendar@group.calendar.google.com");
    const created=reservationOperation_("createReservation",{requestId:newId_(),itemId:prior.itemIds[0],qty:1,startLocal:date+"T18:00",endLocal:date+"T19:00",notes:"Calendar recovery test"},user,true);
    if(created.reservations[0].syncState!=="Error")throw new Error("Failed Calendar write was not reported");
    setSetting_("calendar_id",calendarId);
    syncCalendarRows_(created.reservations);
    let row=findId_("Reservations",created.ids[0]);
    if(row.syncState!=="Synced")throw new Error("Calendar retry failed");
    // Replay an already-created event as if the response had been lost.
    atomicWrite_([{sheet:"Reservations",id:row.id,object:{syncState:"Pending"}}]);
    syncCalendarRows_([findId_("Reservations",row.id)]);
    const events=Calendar.Events.list(calendarId,{privateExtendedProperty:"labtrackId="+row.id,showDeleted:false}).items||[];
    if(events.length!==1)throw new Error("Calendar retry duplicated or lost the event");
    reservationOperation_("cancelReservation",{requestId:newId_(),id:row.id},user,true);
    const visible=Calendar.Events.get(calendarId,"lt"+prior.reservationId);
    if(!visible.description.includes("LabTrack"))throw new Error("Calendar readback missing equipment details");
    setSetting_("staging_recovery_result",JSON.stringify({ok:true,checks:["durable error state","retry recovery","stable event ID","Calendar event readback"],at:new Date().toISOString()}));
    Logger.log("Staging Calendar outage and retry checks passed");
  } finally {setSetting_("calendar_id",calendarId);lock.releaseLock();}
}
