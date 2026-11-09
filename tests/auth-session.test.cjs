const {test}=require('node:test'),assert=require('node:assert/strict');
const {LabTrackSession}=require('../auth-session.js');
const email='member@engineering.upenn.edu';
const jwt=(exp,extra={})=>'header.'+Buffer.from(JSON.stringify({exp,hd:'engineering.upenn.edu',email,name:'Zoë',...extra})).toString('base64url')+'.signature';
function fixture(seconds=3600) {
 let now=1800000000000,visible=true,online=true,cb,prompts=0,init=0,disable=0,mode='success';
 const timers=new Map();let n=0;const states=[];
 const g={initialize:o=>{init++;cb=o.callback;},prompt:fn=>{prompts++;if(mode==='success')cb({credential:jwt(now/1000+3600)});else if(mode==='dismiss')fn({isSkippedMoment:()=>true});},cancel(){},disableAutoSelect(){disable++;}};
 const s=new LabTrackSession({clientId:'client',google:()=>g,now:()=>now,visible:()=>visible,online:()=>online,setTimer:(fn,ms)=>{timers.set(++n,{fn,ms});return n;},clearTimer:id=>timers.delete(id)});
 s.onState=x=>states.push(x);s.setUser({email,token:jwt(now/1000+seconds)});
 return {s,states,timers,get prompts(){return prompts;},get init(){return init;},get disable(){return disable;},set mode(m){mode=m;},advance:ms=>now+=ms,visible:v=>visible=v,online:v=>online=v,credential:t=>cb({credential:t}),now:()=>now};
}
test('restored expired session initializes Google once and renews before sending',async()=>{
 const f=fixture(-1),sent=[];await Promise.all([f.s.initialize(),f.s.initialize()]);
 assert.equal(f.init,1);const result=await f.s.request(async token=>{sent.push(token);return {ok:true};});
 assert.equal(result.ok,true);assert.equal(f.prompts,1);assert.equal(sent.length,1);assert.ok(f.s.expires(sent[0])>f.now());assert.equal(f.s.user.name,'Zoë');
});
test('returning after sleep renews; hidden and offline tabs do not prompt',async()=>{
 const f=fixture();f.advance(4000000);f.visible(false);await f.s.resume();assert.equal(f.prompts,0);
 f.visible(true);f.online(false);await f.s.resume();assert.equal(f.prompts,0);
 f.online(true);await f.s.resume();assert.equal(f.prompts,1);
});
test('simultaneous reads/writes share a single credential renewal',async()=>{
 const f=fixture(-1);f.mode='wait';const tokens=[];
 const requests=Array.from({length:5},()=>f.s.request(async t=>{tokens.push(t);return {ok:true};}));
 await new Promise(setImmediate);f.credential(jwt(f.now()/1000+3600));await Promise.all(requests);
 assert.equal(f.prompts,1);assert.equal(new Set(tokens).size,1);assert.equal(tokens.length,5);
});
test('server rejection retries once with a fresh token; never retries ambiguous network errors',async()=>{
 const f=fixture(1800),sent=[];
 const result=await f.s.request(async t=>{sent.push(t);return sent.length===1?{error:'Unauthorized'}:{ok:true};});
 assert.equal(result.ok,true);assert.equal(sent.length,2);assert.notEqual(sent[0],sent[1]);
 let calls=0;await f.s.request(async()=>{calls++;return null;});assert.equal(calls,1);
});
test('dismissed renewal shows reconnect state and repeated polling never prompts again',async()=>{
 const f=fixture(-1);f.mode='dismiss';let writes=0;
 for(let i=0;i<4;i++){f.advance(120000);const r=await f.s.request(async()=>{writes++;return {ok:true};});assert.equal(r.error,'Unauthorized');}
 assert.equal(writes,0);assert.equal(f.prompts,1);assert.equal(f.states.at(-1),'required');assert.equal(f.disable,0);
 f.mode='success';await f.s.renew(true);assert.equal(f.prompts,2);assert.equal(f.states.at(-1),'ready');
});
test('proactive renewal failure may use still-valid token; expired token is never sent',async()=>{
 const f=fixture(240);f.mode='dismiss';await f.s.resume();assert.equal(f.states.at(-1),'ready');
 let calls=0;await f.s.request(async()=>{calls++;return {ok:true};});assert.equal(calls,1);
 f.advance(300000);await f.s.request(async()=>{calls++;});assert.equal(calls,1);assert.equal(f.prompts,1);
});
test('missing Google callback times out and retains identity for in-place reconnection',async()=>{
 const f=fixture(-1);f.mode='wait';const p=f.s.renew();await Promise.resolve();
 [...f.timers.values()].find(t=>t.ms===20000).fn();await p;
 assert.equal(f.s.user.email,email);assert.equal(f.states.at(-1),'required');
});
test('renewal refuses another account; explicit logout alone disables auto-selection',async()=>{
 const f=fixture(-1);f.mode='wait';const p=f.s.renew();await Promise.resolve();
 f.credential(jwt(f.now()/1000+3600,{email:'someone@engineering.upenn.edu'}));await p;
 assert.equal(f.s.user.email,email);assert.equal(f.disable,0);f.s.signOut();assert.equal(f.disable,1);assert.equal(f.s.user,null);
});
test('each queued call reads the latest credential and stale responses cannot switch accounts',async()=>{
 const f=fixture(1800);let resolve;const first=f.s.request(()=>new Promise(r=>resolve=r));
 f.s.setUser({email:'other@engineering.upenn.edu',token:jwt(f.now()/1000+3600,{email:'other@engineering.upenn.edu'})});resolve({ok:true});assert.equal((await first).error,'Unauthorized');
 let token;await f.s.request(async t=>{token=t;return {ok:true};});assert.equal(token,f.s.user.token);
});
