const path=require('path'),fs=require('fs'),http=require('http');
const {chromium}=require(require('child_process').execSync('npm root -g').toString().trim()+'/playwright');
const {startServer}=require('./mock-gas');
const NEW=path.join(__dirname,'..'), SHOTS=path.join(__dirname,'shots'); fs.mkdirSync(SHOTS,{recursive:true});
const {gas}=startServer(path.join(NEW,'Code.gs'),8787);
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css'};
http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  if(p==='/config.js'){res.writeHead(200,{'Content-Type':MIME['.js']});return res.end("window.MH_CONFIG={SCRIPT_URL:'http://localhost:8787/exec',TOOL_NAME:'MH Meats New Ordering Tool',BUILD:'test'};");}
  const f=path.join(NEW,p); if(!fs.existsSync(f)){res.writeHead(404);return res.end();} res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'text/plain'}); fs.createReadStream(f).pipe(res);}).listen(8788);
const BASE='http://localhost:8788/';
let n=0, errors=[];
const ok=(c,m)=>{if(!c) throw new Error('FAIL: '+m); n++; console.log('✓',m);};
async function newPage(browser,opts){const ctx=await browser.newContext(opts||{viewport:{width:1400,height:900}}); const p=await ctx.newPage();
  p.on('pageerror',e=>errors.push('pageerror: '+e.message)); p.on('console',m=>{if(m.type()==='error'&&!/fonts\.g|Failed to load resource/.test(m.text()))errors.push('console: '+m.text());}); return p;}
const sheetRows=name=>gas.env.sheets[name].rows.slice(1).filter(r=>r.some(v=>v!==''));
(async()=>{
 const browser=await chromium.launch();
 try{
  // ── PC 1: manager, first-time setup
  const pc1=await newPage(browser); await pc1.goto(BASE);
  await pc1.fill('#pinInput','0000'); await pc1.click('#loginBtn'); await pc1.waitForFunction(()=>/Wrong PIN/.test(document.getElementById('loginMsg').textContent));
  ok(true,'wrong PIN refused');
  await pc1.fill('#pinInput','9999'); await pc1.click('#loginBtn');
  await pc1.waitForSelector('#appView:not(.hidden)'); await pc1.waitForSelector('#seedBtn');
  ok(true,'empty sheet → admin first-time setup shown');
  pc1.once('dialog',d=>d.accept()); await pc1.click('#seedBtn');
  await pc1.waitForFunction(()=>document.querySelectorAll('#customerList .customer-btn').length===13,null,{timeout:15000});
  ok(sheetRows('Catalogue').length>900,'catalogue loaded into sheet ('+sheetRows('Catalogue').length+' products)');
  // ── Order entry
  await pc1.click('#nav [data-panel=order]'); await pc1.click('.customer-btn[data-id=ksmeats]');
  const inputs=await pc1.$$('#productArea .qty-input');
  await inputs[0].fill('4'); await inputs[0].press('Enter'); await pc1.keyboard.type('2'); await pc1.keyboard.press('Enter');
  await pc1.fill('#productArea .note-input >> nth=0','thin please'); await pc1.press('#productArea .note-input >> nth=0','Tab');
  await pc1.waitForFunction(()=>/all saved/.test(document.getElementById('statusBadge').textContent),null,{timeout:10000});
  const today=await pc1.evaluate(()=>App._state.date);
  const saved=sheetRows('Orders').filter(r=>r[0]===today&&r[1]==='ksmeats'&&r[3]>0);
  ok(saved.length===2 && saved.some(r=>r[3]===4&&r[4]==='thin please'),'staff entries saved to the Google Sheet with note');
  await pc1.screenshot({path:SHOTS+'/1-order-input.png'});
  // ── PC 2 sees the same thing
  const pc2=await newPage(browser); await pc2.goto(BASE); await pc2.fill('#pinInput','1234'); await pc2.click('#loginBtn');
  await pc2.waitForSelector('#appView:not(.hidden)'); await pc2.click('.customer-btn[data-id=ksmeats]');
  const v2=await pc2.$eval('#productArea .qty-input',e=>e.value);
  ok(v2==='4','second PC sees the same order (shared order book)');
  ok(await pc2.$eval('.customer-btn[data-id=ksmeats] .customer-count',e=>e.textContent)==='2','customer count on PC 2');
  // Staff PIN cannot use admin without manager PIN
  await pc2.click('#nav [data-panel=admin]'); ok(await pc2.$('#adminUnlock')!==null,'admin locked for staff PIN');
  // ── Customer portal (phone)
  await pc1.click('#nav [data-panel=links]'); const link=await pc1.$eval('#linksBody tr:nth-child(2) [data-copy]',e=>e.dataset.copy);
  ok(/portal\.html\?c=ksmeats&k=[0-9a-f]{16}/.test(link),'customer link has private key');
  const phone=await newPage(browser,{viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await phone.goto(link.replace(/^https?:\/\/[^/]+\//,BASE));
  await phone.waitForSelector('.qty'); await phone.waitForFunction(()=>/already has/.test(document.getElementById('dateInfo').textContent));
  ok(true,'portal shows what is already booked for today');
  const pq=await phone.$$eval('.qty',els=>els.filter(e=>e.value).map(e=>e.value)); ok(pq.join()==='4,2','portal prefilled with the current order');
  await phone.screenshot({path:SHOTS+'/2-portal.png',fullPage:false});
  const qs=await phone.$$('.qty'); await qs[0].fill('10'); await qs[5].fill('3'); await phone.fill('#orderNote','back door please');
  await phone.click('#submitBtn'); await phone.waitForSelector('.confirm');
  ok(/Order received/.test(await phone.textContent('.confirm')),'customer sees confirmation only after server OK');
  await phone.screenshot({path:SHOTS+'/3-portal-confirm.png'});
  // PC 2 gets it
  await pc2.evaluate(()=>App.refresh()); await pc2.waitForFunction(()=>!document.getElementById('incomingDot').classList.contains('hidden'));
  ok(true,'staff PC alerted of new customer order');
  await pc2.click('#nav [data-panel=order]'); await pc2.click('.customer-btn[data-id=ksmeats]');
  ok(await pc2.$eval('#productArea .qty-input',e=>e.value)==='10','customer change visible on staff PC');
  ok(/back door please/.test(await pc2.textContent('#productArea')),'customer note visible to staff');
  // ── Offline resilience
  await pc2.evaluate(()=>fetch('http://localhost:8787/__fail?n=6'));
  const i2=await pc2.$$('#productArea .qty-input'); await i2[2].fill('7'); await i2[2].press('Enter');
  await pc2.waitForFunction(()=>/OFFLINE/.test(document.getElementById('statusBadge').textContent),null,{timeout:20000});
  ok(true,'server down → OFFLINE shown, change kept');
  const pend=await pc2.evaluate(()=>localStorage.getItem('mhnew_pending')); ok(pend&&pend.includes('"qty":7'),'unsaved change stored on the PC');
  await pc2.waitForFunction(()=>/all saved/.test(document.getElementById('statusBadge').textContent),null,{timeout:40000});
  ok(sheetRows('Orders').some(r=>r[0]===today&&r[1]==='ksmeats'&&r[3]===7),'change saved automatically after connection returns');
  // ── Production sheets
  for(const t of ['summary','chef','butcher','packer','dispatch','incoming']){ await pc1.click(`#nav [data-panel=${t}]`); await pc1.evaluate(()=>App.refresh()); await pc1.waitForTimeout(250); await pc1.screenshot({path:`${SHOTS}/4-${t}.png`,fullPage:true}); }
  await pc1.click('#nav [data-panel=packer]'); const packTxt=await pc1.textContent('#packerContent');
  ok(/POULTRY PACKER LIST|BEEF PACKER LIST/.test(packTxt),'packer list renders');
  await pc1.click('#nav [data-panel=dispatch]'); ok(/KS MEATS/.test(await pc1.textContent('#dispatchContent')),'dispatch shows KS Meats');
  const [pop]=await Promise.all([pc1.waitForEvent('popup'),pc1.click('#panel-dispatch .sheet-controls .btn-primary')]);
  await pop.waitForLoadState(); ok(/DISPATCH/.test(await pop.textContent('body')),'print window opens with dispatch sheet'); await pop.close();
  await pc1.click('#nav [data-panel=butcher]'); const [pop2]=await Promise.all([pc1.waitForEvent('popup'),pc1.click('text=🖨 Beef')]); await pop2.waitForLoadState();
  ok(/MINCE/.test(await pop2.textContent('body')) && !/CROWNS/.test(await pop2.textContent('body')),'print beef only'); await pop2.close();
  // ── Admin: add product → visible in portal
  await pc1.click('#nav [data-panel=admin]'); await pc1.selectOption('#aCust','ksmeats'); await pc1.click('#aNew');
  await pc1.fill('#aName','test sausage'); await pc1.selectOption('#aCat','poultry'); await pc1.click('#aSave');
  await pc1.waitForFunction(()=>[...document.querySelectorAll('#aProd option')].some(o=>/TEST SAUSAGE/.test(o.textContent)),null,{timeout:10000});
  await phone.goto(link.replace(/^https?:\/\/[^/]+\//,BASE)); await phone.waitForSelector('.qty');
  ok(/TEST SAUSAGE/.test(await phone.textContent('#main')),'new product appears on customer portal');
  // ── Bad link
  const bad=await newPage(browser); await bad.goto(BASE+'portal.html?c=ksmeats&k=wrong'); await bad.waitForSelector('.empty-state h2');
  ok(/not recognised/i.test(await bad.textContent('#main')),'wrong link key refused');
  // ── Double submit protection: same order twice gives one submission
  const before=sheetRows('Submissions').length; await phone.$$eval('.qty',els=>{els[1].value='5';els[1].dispatchEvent(new Event('input'));});
  await Promise.all([phone.click('#submitBtn'),phone.click('#submitBtn').catch(()=>{})]); await phone.waitForSelector('.confirm');
  ok(sheetRows('Submissions').length===before+1,'double tap on Send creates one submission');
  // Clear day needs manager
  await pc2.click('#nav [data-panel=order]'); pc2.once('dialog',d=>d.accept()); await pc2.click('text=Clear Day'); await pc2.waitForSelector('#modalPin');
  await pc2.fill('#modalPin','1234'); await pc2.click('#modalOk'); await pc2.waitForTimeout(600);
  ok(sheetRows('Orders').some(r=>r[0]===today&&r[3]>0),'clear day refused with staff PIN');
  console.log(errors.length?'\nJS ERRORS:\n'+errors.join('\n'):'\nNo JavaScript errors');
  console.log(`${n} end-to-end checks passed`);
 }catch(e){console.error(e.message); console.log(errors.join('\n')); process.exitCode=1;}
 await browser.close(); process.exit();
})();
