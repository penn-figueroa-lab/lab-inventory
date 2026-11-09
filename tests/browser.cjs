const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),babel=require('@babel/core');
const {harness}=require('./backend-harness.cjs');
(async()=>{
 const h=harness();h.item({link:'https://example.com/robot',serial:12345});h.item({id:'camera1',name:'Camera',displayId:'CE-000002-001',qty:1,serial:'001',status:'In Use',usedBy:['Legacy user']});h.item({id:'camera2',name:'Camera',displayId:'CE-000002-002',qty:1,serial:'002'});h.item({id:'consumable',name:'Electrodes',displayId:'CS-000003',qty:100,consumable:true});h.order({item:'New Robot',urgency:'Normal'});h.item({id:'loan1',name:'External drive',displayId:'CE-000004',status:'On loan',usedBy:['Shafagh']});h.add('Checkouts',{id:'historical',item:'Earlier robot',user:'Former lab user',out:'2026-03-01 09:00',ret:'2026-03-01 12:00',status:'Returned'});h.add('Reservations',{id:'someone-elses-booking',itemId:'item1',qty:1,start:new Date(Date.now()-60000).toISOString(),end:new Date(Date.now()+3600000).toISOString(),status:'Booked',email:'member@engineering.upenn.edu',user:'Lab Teammate',syncState:'Error'});
 let html=fs.readFileSync('index.html','utf8');const source=html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)[1];const compiled=babel.transformSync(source,{presets:[['@babel/preset-react',{runtime:'classic'}]]}).code;
 html=html.replace(/<script src="https:\/\/unpkg.com\/react@[^>]+><\/script>/,'<script src="/react.js"></script>').replace(/<script src="https:\/\/unpkg.com\/react-dom@[^>]+><\/script>/,'<script src="/react-dom.js"></script>').replace(/<script src="https:\/\/unpkg.com\/@babel[^>]+><\/script>/,'').replace(/<script src="https:\/\/accounts.google.com[^>]+><\/script>/,'<script>window.__auth={initializations:0,prompts:0,disabled:0,mode:"auto",issue(){return "test."+btoa(JSON.stringify({email:"admin@engineering.upenn.edu",hd:"engineering.upenn.edu",name:"Admin",exp:Math.floor(Date.now()/1000)+3600,nonce:Math.random()}))+".signature";}};window.google={accounts:{id:{initialize(o){window.__auth.initializations++;window.__auth.callback=o.callback;},prompt(n){window.__auth.prompts++;if(window.__auth.mode==="auto")setTimeout(()=>window.__auth.callback({credential:window.__auth.issue()}),20);else n({isSkippedMoment:()=>true});},renderButton(el){const b=document.createElement("button");b.textContent="Test Google reconnect";b.onclick=()=>window.__auth.callback({credential:window.__auth.issue()});el.replaceChildren(b);},cancel(){},disableAutoSelect(){window.__auth.disabled++;}}}};</script>').replace(/<script type="text\/babel"[^>]*>[\s\S]*?<\/script>/,'<script src="/app.js"></script>');
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage();page.setDefaultTimeout(7000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let invalidResponse=false,expiredRequests=0;
 const expireSession=()=>page.evaluate(()=>{const u=JSON.parse(localStorage.getItem('labtrack_user'));const p=JSON.parse(atob(u.token.split('.')[1]));p.exp=Math.floor(Date.now()/1000)-1;u.token='test.'+btoa(JSON.stringify(p))+'.expired';session.setUser(u);});
 await page.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('https://script.google.com/')) {
    const credential=route.request().method()==='POST'?JSON.parse(route.request().postData()).token:new URL(url).searchParams.get('token');if(JSON.parse(Buffer.from(credential.split('.')[1],'base64url')).exp*1000<=Date.now()){expiredRequests++;return route.fulfill({json:{error:'Unauthorized'}});}
    if(route.request().method()==='POST') {if(invalidResponse){invalidResponse=false;return route.fulfill({status:200,contentType:'text/html',body:'sign in required'});}const b=JSON.parse(route.request().postData());return route.fulfill({json:h.post(b.action,{...b,token:JSON.parse(Buffer.from(b.token.split('.')[1],'base64url')).email}),headers:{'access-control-allow-origin':'*'}});}
    return route.fulfill({json:h.context.doGet({parameter:{...Object.fromEntries(new URL(url).searchParams),token:'admin@engineering.upenn.edu'}}),headers:{'access-control-allow-origin':'*'}});
  }
  const files={'/react.js':'node_modules/react/umd/react.development.js','/react-dom.js':'node_modules/react-dom/umd/react-dom.development.js','/image-catalog.js':'image-catalog.js','/auth-session.js':'auth-session.js'};
  const u=new URL(url);if(u.hostname==='localhost'){
   if(files[u.pathname])return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(files[u.pathname],'utf8')});
   if(u.pathname==='/app.js')return route.fulfill({contentType:'application/javascript',body:compiled});
   return route.fulfill({contentType:'text/html',body:html});
  }
  return route.abort();
 });
 await page.addInitScript(()=>window.top===window&&localStorage.setItem('labtrack_user',JSON.stringify({name:'Admin',email:'admin@engineering.upenn.edu',token:'test.'+btoa(JSON.stringify({email:'admin@engineering.upenn.edu',hd:'engineering.upenn.edu',name:'Admin',exp:Math.floor(Date.now()/1000)-1}))+'.signature'})));
 try {
 await page.goto('http://localhost:4173');await page.getByRole('heading',{name:'Equipment schedule'}).waitFor();
 assert.equal(await page.evaluate(()=>window.__auth.initializations),1);assert.equal(await page.evaluate(()=>window.__auth.prompts),1);
 // Returning to an idle tab renews without logging out or rebuilding the inventory.
 await expireSession();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>window.__auth.prompts===2&&session.expires()>Date.now());
 assert.equal(await page.getByText('Legacy Usage',{exact:true}).count(),0);
 const schedule=page.getByRole('region',{name:'Equipment schedule'});
 assert.equal(await schedule.getByRole('button',{name:'My reservations',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await schedule.locator('iframe').count(),0);assert.doesNotMatch(await schedule.innerText(),/Lab Teammate|On loan to Shafagh/);
 await schedule.getByRole('button',{name:'All lab',exact:true}).click();
 await schedule.getByText('Checkout history · 1 records',{exact:true}).click();await schedule.getByLabel('Search earlier checkouts').fill('Former lab user');assert.match(await schedule.innerText(),/Earlier robot/);await schedule.getByText('Checkout history · 1 records',{exact:true}).click();assert.match(await schedule.innerText(),/On loan to Shafagh/);assert.match(await schedule.innerText(),/Lab Teammate/);assert.match(await schedule.innerText(),/sync delayed/);
 await schedule.getByRole('button',{name:'My reservations',exact:true}).click();assert.doesNotMatch(await schedule.innerText(),/Lab Teammate/);
 await schedule.getByRole('button',{name:'All lab',exact:true}).click();
 await schedule.getByRole('button',{name:'View calendar',exact:true}).click();const frame=page.locator('iframe[title="Lab Equipment Google Calendar"]');assert.match(await frame.getAttribute('src'),/calendar.google.com\/calendar\/embed/);assert.match(await frame.getAttribute('src'),/America%2FNew_York/);
 await schedule.getByRole('button',{name:'Agenda',exact:true}).click();assert.match(await frame.getAttribute('src'),/mode=AGENDA/);await schedule.getByRole('button',{name:'Hide calendar',exact:true}).click();
 await page.getByRole('button',{name:/Checked out \/ reserved/}).click();assert.equal(await page.locator('.card-item').count(),2);assert.match(await page.locator('.card-item').filter({has:page.getByRole('button',{name:'Robot',exact:true})}).innerText(),/Lab Teammate/);const loanCard=page.locator('.card-item').filter({hasText:'External drive'});assert.match(await loanCard.innerText(),/Shafagh/);assert.equal(await loanCard.getByRole('button',{name:'Reserve',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:/^All \d/}).click();
 await page.getByRole('button',{name:'Reserve equipment',exact:true}).click();await page.getByLabel('Find equipment').fill('CE-000002-002');await page.locator('.equipment-choice').click();await page.getByRole('dialog',{name:'Reserve equipment'}).getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(h.rows('Reservations').length,1);

 const search=page.getByPlaceholder('Search name, location, serial or label ID…');await search.fill(' ce-000002-002 ');
 await page.locator('.card-item').filter({hasText:'Camera'}).click();await page.getByRole('dialog').waitFor();
 assert.match(await page.getByRole('dialog').innerText(),/2 total/);assert.match(await page.getByRole('dialog').innerText(),/Unavailable/i);assert.match(await page.getByRole('dialog').innerText(),/Search match/);
 await page.getByRole('button',{name:'Details / reserve'}).nth(1).click();assert.match(await page.getByRole('dialog').innerText(),/CE-000002-002/);
 await page.getByRole('dialog').getByRole('button',{name:'Reserve this item'}).click();
 const modal=page.getByRole('dialog',{name:'Reserve equipment'});
 await modal.getByLabel('Start',{exact:true}).fill('2030-03-01T10:00');await modal.getByLabel('End',{exact:true}).fill('2030-03-01T11:00');
 await modal.getByText('Repeat weekly on this weekday').click();await modal.getByLabel('Repeat through').fill('2030-03-15');
 await modal.getByRole('button',{name:'Reserve',exact:true}).click();await modal.waitFor({state:'hidden'});assert.equal(h.rows('Reservations').length,4);assert.equal(h.events.size,3);
 // Close detail, find a different item by numeric serial and inspect its link.
 await page.getByRole('dialog').press('Escape');await search.fill('12345');await page.locator('.card-item').filter({hasText:'Robot'}).click();assert.equal(await page.getByRole('link',{name:'Purchase / reorder link ↗'}).getAttribute('href'),'https://example.com/robot');await page.getByRole('dialog').press('Escape');
 await page.getByRole('button',{name:/Order Requests/}).click();await page.getByRole('button',{name:'Mark Received'}).click();
 let receive=page.getByRole('dialog',{name:'Receive order'});await receive.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(h.rows('Orders')[0].status,'Ordered');assert.equal(h.rows('Deliveries').length,0);
 await page.getByRole('button',{name:'Mark Received'}).click();receive=page.getByRole('dialog',{name:'Receive order'});await receive.getByLabel('Location (required)',{exact:true}).fill('Shelf B');
 // Expiry during an open receipt form keeps its contents and offers in-place reconnection.
 await page.evaluate(()=>window.__auth.mode='dismiss');await expireSession();
 await receive.getByRole('button',{name:'Confirm receipt'}).click();await receive.getByRole('button',{name:'Test Google reconnect'}).waitFor();
 assert.equal(await receive.getByLabel('Location (required)',{exact:true}).inputValue(),'Shelf B');assert.equal(h.rows('Receipts').length,0);
 const prompts=await page.evaluate(()=>window.__auth.prompts);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(await page.evaluate(()=>window.__auth.prompts),prompts);assert.equal(await page.evaluate(()=>window.__auth.disabled),0);
 await page.screenshot({path:'test-results/session-reconnect.png',fullPage:true});
 await receive.getByRole('button',{name:'Test Google reconnect'}).click();await receive.getByRole('button',{name:'Test Google reconnect'}).waitFor({state:'hidden'});assert.equal(await receive.getByLabel('Location (required)',{exact:true}).inputValue(),'Shelf B');
 await page.evaluate(()=>window.__auth.mode='auto');
 invalidResponse=true;await receive.getByRole('button',{name:'Confirm receipt'}).click();await receive.getByRole('alert').waitFor();assert.equal(await receive.getByLabel('Location (required)',{exact:true}).inputValue(),'Shelf B');assert.equal(h.rows('Receipts').length,0);
 await receive.getByRole('button',{name:'Confirm receipt'}).click();await receive.waitFor({state:'hidden'});assert.equal(h.rows('Receipts').length,1);assert.equal(h.rows('Items').find(i=>i.name==='New Robot').img,'https://example.com/robot.jpg');
 await page.reload();await page.getByRole('heading',{name:'Equipment schedule'}).waitFor();await search.fill('New Robot');await page.locator('.card-item').filter({hasText:'New Robot'}).click();assert.equal(await page.getByRole('link',{name:'Purchase / reorder link ↗'}).count(),1);await page.getByRole('dialog').press('Escape');
 // Desktop and narrow-screen screenshot/overflow checks use no real account or network writes.
 await page.emulateMedia({reducedMotion:'reduce'});await search.fill('');fs.mkdirSync('test-results',{recursive:true});await page.waitForFunction(()=>[...document.querySelectorAll('.card-item')].every(n=>Number(getComputedStyle(n).opacity)>.95));await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/inventory-desktop.png',fullPage:true});
 await page.locator('.header-tools > summary').click();await page.getByRole('button',{name:'Light appearance',exact:true}).click();await page.locator('.header-tools > summary').press('Escape');await page.screenshot({path:'test-results/inventory-light.png',fullPage:true});await page.locator('.header-tools > summary').click();await page.getByRole('button',{name:'Dark appearance',exact:true}).click();await page.locator('.header-tools > summary').press('Escape');
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/inventory-mobile.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Mobile page overflows horizontally');
 assert.equal(expiredRequests,0);assert.deepEqual(errors,[]);console.log('Browser workflows passed: label/numeric search, full group counts, weekly booking, purchase links, cancel receipt, failed-save retention, receive/reload, mobile layout.');
 } catch(e){fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/failure.png',fullPage:true});console.error('Browser errors:',errors);console.error((await page.locator('body').innerText()).slice(-3500));throw e;}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
