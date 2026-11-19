const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./backend-harness.cjs');
const setMembers=(h,list)=>h.context.setSetting_('members',JSON.stringify(list));
test('direct sheet membership changes are picked up by the existing retry trigger',()=>{
 const h=harness();setMembers(h,['first@engineering.upenn.edu']);
 h.context.syncReservationsToCalendar();assert.equal(h.context.capabilities_().calendarAccessState,'Synced');
 // A second effective Settings row models a direct edit, not a website API call.
 h.db.Settings.appendRow(['members','["first@engineering.upenn.edu","new@engineering.upenn.edu"]']);
 assert.equal(h.context.capabilities_().calendarAccessState,'Pending');
 h.context.syncReservationsToCalendar();
 assert.equal(h.acl.get('user:new@engineering.upenn.edu').role,'reader');
 assert.equal(h.context.capabilities_().calendarAccessState,'Synced');
 const writes=h.calls.length;h.context.syncReservationsToCalendar();assert.equal(h.calls.length,writes);
 assert.ok(h.calls.every(c=>c.args.sendNotifications===false));
});
test('sharing reads all ACL pages, upgrades weak grants and preserves owner/manual permissions',()=>{
 const h=harness({aclPageSize:1});setMembers(h,['member@engineering.upenn.edu',' OWNER@engineering.upenn.edu ','member@engineering.upenn.edu']);
 for(const [email,role] of [['admin@engineering.upenn.edu','reader'],['member@engineering.upenn.edu','freeBusyReader'],['owner@engineering.upenn.edu','owner'],['manual@example.com','writer']])h.acl.set('user:'+email,{id:'user:'+email,scope:{type:'user',value:email},role});
 const r=h.context.syncLabCalendarAccess();assert.equal(r.state,'Synced');assert.equal(r.upgraded,1);assert.equal(r.added,0);
 assert.equal(h.acl.get('user:owner@engineering.upenn.edu').role,'owner');assert.equal(h.acl.get('user:manual@example.com').role,'writer');
 assert.equal(h.acl.get('user:member@engineering.upenn.edu').role,'reader');
});
test('one failed share does not block other members; retries repair it without duplicate grants',()=>{
 const h=harness();setMembers(h,['a@engineering.upenn.edu','b@engineering.upenn.edu']);h.fault.aclEmail='a@engineering.upenn.edu';
 const r=h.context.syncLabCalendarAccess();assert.equal(r.state,'Error');assert.equal(r.failed,1);assert.ok(h.acl.has('user:b@engineering.upenn.edu'));
 assert.equal(h.context.capabilities_().calendarAccessState,'Error');h.fault.aclEmail=null;
 const fixed=h.context.syncLabCalendarAccess();assert.equal(fixed.state,'Synced');assert.equal(fixed.added,1);
});
test('ACL service outage does not interrupt pending reservation synchronization',()=>{
 const h=harness();h.item();h.add('Reservations',{id:'r1',itemId:'item1',eventId:'ltr1',qty:1,user:'Member',start:'2030-01-01T15:00:00.000Z',end:'2030-01-01T16:00:00.000Z',status:'Booked',syncState:'Pending'});
 h.fault.acl=true;h.context.syncReservationsToCalendar();
 assert.equal(h.context.capabilities_().calendarAccessState,'Error');assert.equal(h.rows('Reservations')[0].syncState,'Synced');assert.equal(h.events.size,1);
 h.fault.acl=false;h.context.syncReservationsToCalendar();assert.equal(h.context.capabilities_().calendarAccessState,'Synced');assert.equal(h.events.size,1);
});
test('invalid or empty access lists never create broad Calendar grants',()=>{
 const h=harness();setMembers(h,['not an email']);assert.equal(h.context.syncLabCalendarAccess().state,'Error');assert.equal(h.acl.size,0);
 setMembers(h,[]);h.context.setSetting_('admins','[]');assert.equal(h.context.syncLabCalendarAccess().state,'Error');assert.equal(h.acl.size,0);
});
test('admin website membership edits synchronize immediately and protect sync metadata',()=>{
 const h=harness();const result=h.post('saveSettings',{key:'members',value:'["admin@engineering.upenn.edu","new@engineering.upenn.edu"]'});
 assert.equal(result.ok,true);assert.equal(h.acl.get('user:new@engineering.upenn.edu').role,'reader');
 assert.ok(h.post('saveSettings',{key:'calendar_access_sync',value:'{}'}).error);
 assert.ok(h.post('saveSettings',{key:'members',value:'[]'},'new@engineering.upenn.edu').error);
});
