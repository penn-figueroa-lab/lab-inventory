const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),babel=require('@babel/core');
const {harness}=require('./backend-harness.cjs');
(async()=>{
 const h=harness();h.item({link:'https://example.com/robot',serial:12345});h.item({id:'camera1',name:'Camera',displayId:'CE-000002-001',qty:1,serial:'001'});h.item({id:'camera2',name:'Camera',displayId:'CE-000002-002',qty:1,serial:'002'});h.item({id:'consumable',name:'Electrodes',displayId:'CS-000003',qty:100,consumable:true});h.order({item:'New Robot',urgency:'Normal'});
 let html=fs.readFileSync('index.html','utf8');const source=html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)[1];const compiled=babel.transformSync(source,{presets:[['@babel/preset-react',{runtime:'classic'}]]}).code;
 html=html.replace(/<script src="https:\/\/unpkg.com\/react@[^>]+><\/script>/,'<script src="/react.js"></script>').replace(/<script src="https:\/\/unpkg.com\/react-dom@[^>]+><\/script>/,'<script src="/react-dom.js"></script>').replace(/<script src="https:\/\/unpkg.com\/@babel[^>]+><\/script>/,'').replace(/<script src="https:\/\/accounts.google.com[^>]+><\/script>/,'<script>window.google={accounts:{id:{prompt(){},initialize(){},renderButton(){},disableAutoSelect(){}}}};</script>').replace(/<script type="text\/babel"[^>]*>[\s\S]*?<\/script>/,'<script src="/app.js"></script>');
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage();page.setDefaultTimeout(7000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let invalidResponse=false;
 await page.route('**/*',async route=>{
  const url=route.request().url();
  if(url.startsWith('https://script.google.com/')) {
    if(route.request().method()==='POST') {if(invalidResponse){invalidResponse=false;return route.fulfill({status:200,contentType:'text/html',body:'sign in required'});}const b=JSON.parse(route.request().postData());return route.fulfill({json:h.post(b.action,b,b.token),headers:{'access-control-allow-origin':'*'}});}
    return route.fulfill({json:h.context.doGet({parameter:{...Object.fromEntries(new URL(url).searchParams),token:'admin@engineering.upenn.edu'}}),headers:{'access-control-allow-origin':'*'}});
  }
  const files={'/react.js':'node_modules/react/umd/react.development.js','/react-dom.js':'node_modules/react-dom/umd/react-dom.development.js'};
  const u=new URL(url);if(u.hostname==='localhost'){
   if(files[u.pathname])return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(files[u.pathname],'utf8')});
   if(u.pathname==='/app.js')return route.fulfill({contentType:'application/javascript',body:compiled});
   return route.fulfill({contentType:'text/html',body:html});
  }
  return route.abort();
 });
 await page.addInitScript(()=>localStorage.setItem('labtrack_user',JSON.stringify({name:'Admin',email:'admin@engineering.upenn.edu',token:'admin@engineering.upenn.edu'})));
 try {
 await page.goto('http://localhost:4173');await page.getByRole('heading',{name:'My reservations'}).waitFor();
 assert.equal(await page.getByText('Legacy Usage',{exact:true}).count(),0);
 const search=page.getByPlaceholder('Search name, location, serial or label ID…');await search.fill(' ce-000002-002 ');
 await page.locator('.card-item').filter({hasText:'Camera'}).click();await page.getByRole('dialog').waitFor();
 assert.match(await page.getByRole('dialog').innerText(),/2 total/);assert.match(await page.getByRole('dialog').innerText(),/Search match/);
 await page.getByRole('button',{name:'Details / reserve'}).nth(1).click();assert.match(await page.getByRole('dialog').innerText(),/CE-000002-002/);
 await page.getByRole('dialog').getByRole('button',{name:'Reserve this item'}).click();
 const modal=page.getByRole('dialog',{name:'Reserve equipment'});
 await modal.getByLabel('Start',{exact:true}).fill('2030-03-01T10:00');await modal.getByLabel('End',{exact:true}).fill('2030-03-01T11:00');
 await modal.getByText('Repeat weekly on this weekday').click();await modal.getByLabel('Repeat through').fill('2030-03-15');
 await modal.getByRole('button',{name:'Reserve',exact:true}).click();await modal.waitFor({state:'hidden'});assert.equal(h.rows('Reservations').length,3);assert.equal(h.events.size,3);
 // Close detail, find a different item by numeric serial and inspect its link.
 await page.getByRole('dialog').press('Escape');await search.fill('12345');await page.locator('.card-item').filter({hasText:'Robot'}).click();assert.equal(await page.getByRole('link',{name:'Purchase / reorder link ↗'}).getAttribute('href'),'https://example.com/robot');await page.getByRole('dialog').press('Escape');
 await page.getByRole('button',{name:/Order Requests/}).click();await page.getByRole('button',{name:'Mark Received'}).click();
 let receive=page.getByRole('dialog',{name:'Receive order'});await receive.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(h.rows('Orders')[0].status,'Ordered');assert.equal(h.rows('Deliveries').length,0);
 await page.getByRole('button',{name:'Mark Received'}).click();receive=page.getByRole('dialog',{name:'Receive order'});await receive.getByLabel('Location (required)',{exact:true}).fill('Shelf B');
 invalidResponse=true;await receive.getByRole('button',{name:'Confirm receipt'}).click();await receive.getByRole('alert').waitFor();assert.equal(await receive.getByLabel('Location (required)',{exact:true}).inputValue(),'Shelf B');assert.equal(h.rows('Receipts').length,0);
 await receive.getByRole('button',{name:'Confirm receipt'}).click();await receive.waitFor({state:'hidden'});assert.equal(h.rows('Receipts').length,1);assert.equal(h.rows('Items').find(i=>i.name==='New Robot').img,'https://example.com/robot.jpg');
 await page.reload();await page.getByRole('heading',{name:'My reservations'}).waitFor();await search.fill('New Robot');await page.locator('.card-item').filter({hasText:'New Robot'}).click();assert.equal(await page.getByRole('link',{name:'Purchase / reorder link ↗'}).count(),1);await page.getByRole('dialog').press('Escape');
 // Desktop and narrow-screen screenshot/overflow checks use no real account or network writes.
 await search.fill('');fs.mkdirSync('test-results',{recursive:true});await page.waitForFunction(()=>[...document.querySelectorAll('.card-item')].every(n=>Number(getComputedStyle(n).opacity)>.95));await page.screenshot({path:'test-results/inventory-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/inventory-mobile.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Mobile page overflows horizontally');
 assert.deepEqual(errors,[]);console.log('Browser workflows passed: label/numeric search, full group counts, weekly booking, purchase links, cancel receipt, failed-save retention, receive/reload, mobile layout.');
 } catch(e){fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/failure.png',fullPage:true});console.error('Browser errors:',errors);console.error((await page.locator('body').innerText()).slice(-3500));throw e;}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
