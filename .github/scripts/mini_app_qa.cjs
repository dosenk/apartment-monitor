const { chromium } = require('playwright');
const fs = require('fs');
(async()=>{
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844}});
const root=process.cwd()+'/cloudflare/public';
const {preferences,STATIONS,LINES}=await import(process.cwd()+'/cloudflare/metro.mjs');
const {DISTRICTS,CITY_DISTRICTS}=await import(process.cwd()+'/cloudflare/districts.mjs');
const {OBLASTS,directCities,rayons,cities}=await import(process.cwd()+'/cloudflare/location.mjs');
let selected=preferences({cities:[]}),configured=false,checks=0,fail=false;
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>window.Telegram={WebApp:{initData:'test-fixture',ready(){},expand(){},enableClosingConfirmation(){},disableClosingConfirmation(){},BackButton:{show(){},hide(){},onClick(){}}}});
await page.route('https://telegram.org/**',route=>route.fulfill({body:''}));
await page.route('https://app.test/**',async route=>{
 const u=new URL(route.request().url());
 if(u.pathname.startsWith('/api/')){
  const data=route.request().postDataJSON();let result;
  if(fail){fail=false;return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Тестовая ошибка. Повторите.'})});}
  const place=({row,index})=>({id:index,name:row[0],type:row[3],oblast:row[1],rayon:row[2]});
  if(u.pathname==='/api/session')result={settings:selected,configured,places:[],user:{firstName:'Дима'},catalog:{oblasts:OBLASTS,lines:LINES,stations:STATIONS.map(([name,line],id)=>({id,name,line})),districts:DISTRICTS,cityDistricts:CITY_DISTRICTS}};
  if(u.pathname==='/api/region')result={direct:directCities(OBLASTS[data.oblast]).map(place),rayons:rayons(OBLASTS[data.oblast])};
  if(u.pathname==='/api/places'){const entries=cities(OBLASTS[data.oblast],rayons(OBLASTS[data.oblast])[data.rayon],data.query);result={places:entries.slice(data.offset,data.offset+30).map(place),total:entries.length};}
  if(u.pathname==='/api/preferences'){selected=preferences(data.settings);configured=true;result={ok:true,settings:selected};}
  if(u.pathname==='/api/check'){checks++;result={ok:true};}
  return route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
 }
 const path=root+(u.pathname.endsWith('/')?u.pathname+'index.html':u.pathname);
 return route.fulfill({body:fs.readFileSync(path),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});
});
await page.goto('https://app.test/app/');await page.locator('#form').waitFor({state:'visible'});
const assert=(b,msg)=>{if(!b)throw Error(msg)};
assert(await page.locator('#minsk').isHidden(),'Minsk filters exposed before city');
await page.locator('#add').click();await page.getByRole('button',{name:'Минская область',exact:true}).click();
await page.getByRole('button',{name:/🏙 Минск/}).click();
assert(await page.locator('#minsk').isVisible(),'Minsk filters missing');
await page.locator('#price').fill('1500');await page.locator('#frequency').selectOption('30m');
await page.getByText('Линии метро · Onliner',{exact:true}).click();await page.getByLabel('Московская линия',{exact:true}).check();
fail=true;await page.locator('#save').click();await page.getByText('Тестовая ошибка. Повторите.',{exact:true}).waitFor();
assert(await page.locator('#save').isEnabled(),'Retry save unavailable');
await page.locator('#save').click();await page.getByText('Настройки сохранены. Поиск по расписанию включён.',{exact:true}).waitFor();
assert(selected.maxByn===1500&&selected.onliner[0]==='1','Settings mismatch');
await page.locator('#check').click();await page.getByText('Проверка запущена. Объявления придут в ваш чат Telegram.',{exact:true}).waitFor();assert(checks===1,'Check not triggered');
await page.locator('#add').click();await page.getByRole('button',{name:'Минская область',exact:true}).click();await page.getByRole('button',{name:/📍 Минский район/}).click();
await page.locator('#search').fill('Заславль');await page.getByRole('button',{name:/Заславль/}).click();assert(selected.cities.length===1,'Unsaved cities changed server');
await page.locator('#save').click();await page.getByText('Настройки сохранены. Поиск по расписанию включён.',{exact:true}).waitFor();assert(selected.cities.length===2,'Multi-city not saved');
await page.screenshot({path:'/tmp/mini-app-mobile.png',fullPage:true});
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile horizontal overflow');
await page.setViewportSize({width:1024,height:900});await page.screenshot({path:'/tmp/mini-app-desktop.png',fullPage:true});
await page.getByRole('button',{name:'Убрать Минск'}).click();assert(await page.locator('#minsk').isHidden(),'Minsk filters remain after removal');
assert(errors.length===0,errors.join('\n'));console.log('Browser QA passed: city flow, conditional filters, multi-city, save/retry, manual check, mobile/desktop layout; no JS errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
