import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { CITIES } from './geography.mjs';
import { access, scope, cursorKey, scanLock } from './access.mjs';

const source = (await readFile(new URL('./worker.mjs', import.meta.url), 'utf8'))
  .replace("import { WorkflowEntrypoint } from 'cloudflare:workers';", 'class WorkflowEntrypoint { constructor(ctx,env) { this.env=env; } }')
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, import.meta.url).href}'`);
const { default: worker, ApartmentScan } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(schema);
  const prepare = query => {
    const statement = sql.prepare(query);
    const bound = args => ({
      first: async () => statement.get(...args) || null,
      all: async () => ({ results: statement.all(...args) }),
      run: async () => ({ meta: { changes: Number(statement.run(...args).changes) } }),
    });
    return { ...bound([]), bind: (...args) => bound(args) };
  };
  return { sql, DB: { prepare, batch: async statements => Promise.all(statements.map(s => s.run())) } };
}
function telegramMock(t) {
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    messages.push({ method: url.split('/').at(-1), ...JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: messages.length } });
  });
  return messages;
}
const message = (id, text) => ({ update_id: Date.now(), message: { message_id: 1, text, chat: { id, type: 'private' } } });
const callback = (id, action) => ({ callback_query: { id: 'test', data: `prefs:${action}`, message: { message_id: 1, chat: { id, type: 'private' } } } });
async function post(env, update) {
  const result = await worker.fetch(new Request('https://worker.test/telegram', { method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' }, body: JSON.stringify(update) }), env);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).ok, true);
}

test('password gates all menus and scans; users keep independent preferences and schedules', async t => {
  const { DB, sql } = database(); t.after(() => sql.close());
  const messages = telegramMock(t), scans = [];
  const env = { DB, TELEGRAM_CHAT_ID: '999', TELEGRAM_BOT_TOKEN: 'test', WEBHOOK_SECRET: 'secret',
    BOT_ACCESS_PASSWORD: 'Shared-Test', SCAN: { create: async options => { scans.push(options.params); return { id: 'test' }; } } };
  await post(env, message(123, '/start'));
  await post(env, callback(123, 'frequency:10m'));
  await post(env, message(123, '🔄 Проверить новые квартиры'));
  assert.equal(sql.prepare('SELECT count(*) AS n FROM search_drafts').get().n, 0);
  assert.equal(scans.length, 0);
  await post(env, message(123, 'Shared-Test'));
  await post(env, message(456, 'Shared-Test'));
  assert.equal(sql.prepare('SELECT count(*) AS n FROM bot_users WHERE authorized=1').get().n, 2);
  const minsk = CITIES.findIndex(row => row[0] === 'Минск');
  const brest = CITIES.findIndex(row => row[0] === 'Брест' && row[3] === 'г.');
  for (const [id, city, region, price, frequency] of [[123, minsk, 4, '1000', '30m'], [456, brest, 0, '2000', '8h']]) {
    await post(env, callback(id, `capital:${city}:${region}`));
    await post(env, callback(id, 'input:price'));
    await post(env, message(id, price));
    await post(env, callback(id, `frequency:${frequency}`));
    await post(env, callback(id, 'apply'));
  }
  const saved = id => JSON.parse(sql.prepare('SELECT settings FROM search_preferences WHERE chat_id=?').get(id).settings);
  assert.deepEqual(saved('123').cities, [minsk]);
  assert.deepEqual(saved('456').cities, [brest]);
  assert.equal(saved('123').maxByn, 1000);
  assert.equal(saved('456').maxByn, 2000);
  await post(env, message(123, '🔄 Проверить новые квартиры'));
  await post(env, message(456, '🔄 Проверить новые квартиры'));
  assert.deepEqual(scans.map(x => x.chatId), ['123', '456']);
  scans.length = 0;
  let job;
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.parse('2026-10-02T05:00:00Z') }, env,
    { waitUntil: promise => { job = promise; } });
  await job;
  assert.deepEqual(scans.map(x => x.chatId), ['123', '456']);
  assert.ok(messages.some(m => m.method === 'deleteMessage' && m.chat_id === '123'));
  assert.equal(env.TELEGRAM_CHAT_ID, '999');
});

test('password is case-sensitive, login failures are throttled, and groups are excluded', async t => {
  const { DB, sql } = database(); t.after(() => sql.close()); telegramMock(t);
  const env = { DB, TELEGRAM_BOT_TOKEN: 'test', BOT_ACCESS_PASSWORD: 'Shared-Test' };
  for (let i = 0; i < 5; i++) assert.equal(await access(env, message(123, 'shared-test'), 1000), false);
  assert.equal(await access(env, message(123, 'Shared-Test'), 2000), false);
  assert.equal(await access(env, message(123, 'Shared-Test'), 601001), true);
  const group = message(456, 'Shared-Test'); group.message.chat.type = 'group';
  assert.equal(await access(env, group), false);
  assert.equal(await access({ ...env, BOT_ACCESS_PASSWORD: undefined }, message(789, 'Shared-Test')), false);
  assert.equal(sql.prepare('SELECT authorized FROM bot_users WHERE chat_id=?').get('789'), undefined);
});

test('one users sent listing and cursor do not suppress another users delivery', async t => {
  const { DB, sql } = database(); t.after(() => sql.close()); const messages = telegramMock(t);
  const item = { key: 'kufar:shared', publishedAt: '2026-10-01T10:00:00Z', address: 'Минск', rooms: 1,
    priceUsd: 300, priceByn: 900, url: 'https://re.kufar.by/vi/123' };
  sql.prepare('INSERT INTO user_sent VALUES (?,?,?)').run('123', item.key, 'before');
  for (const chatId of ['123', '456']) {
    const runId = `run-${chatId}`;
    sql.prepare('INSERT INTO scan_runs VALUES (?,?,?,?,?,?,?)').run(runId, '2026-10-01T09:00:00Z', '2026-10-01T11:00:00Z', 'send', 1, null, 0);
    sql.prepare('INSERT INTO scan_preferences VALUES (?,?)').run(runId, JSON.stringify({ cities: [], frequency: '30m' }));
    sql.prepare('INSERT INTO scan_recipients VALUES (?,?)').run(runId, chatId);
    sql.prepare('INSERT INTO locks VALUES (?,?,?)').run(scanLock(chatId), runId, Date.now() + 600000);
    sql.prepare('INSERT INTO pending VALUES (?,?,?,?)').run(runId, item.key, item.publishedAt, JSON.stringify(item));
  }
  const env = { DB, TELEGRAM_CHAT_ID: '999', TELEGRAM_BOT_TOKEN: 'test' };
  const step = { do: async (_, ...args) => args.at(-1)(), sleep: async () => {} };
  await new ApartmentScan({}, env).run({ payload: { runId: 'run-123' } }, step);
  assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey('456')), undefined);
  await new ApartmentScan({}, env).run({ payload: { runId: 'run-456' } }, step);
  const listings = messages.filter(m => m.text?.includes(item.url));
  assert.deepEqual(listings.map(m => m.chat_id), ['456']);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM user_sent WHERE key=?').get(item.key).n, 2);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM locks').get().n, 0);
  assert.equal(scope(env, '123').TELEGRAM_CHAT_ID, '123');
});

test('a blocked source does not stop alerts, lose the window or repeat delivered listings on recovery', async t => {
  const { DB, sql } = database(); t.after(() => sql.close());
  let blocked = true;
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('api.telegram.org')) {
      messages.push(JSON.parse(options.body));
      return Response.json({ ok: true, result: {} });
    }
    if (url.includes('onliner.by')) return Response.json({ apartments: [], page: { last: 1 } });
    if (url.includes('realt.by')) return blocked ? new Response('Forbidden', { status: 403 }) :
      new Response('<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: {
        objects: [], pagination: { totalCount: 0 } } } }) + '</script>');
    if (url.includes('api.kufar.by')) return Response.json({ ads: [{ ad_id: 123, ad_link: 'https://re.kufar.by/vi/123',
      list_time: '2026-10-01T10:00:00Z', price_byn: 90000, price_usd: 30000,
      ad_parameters: [{ p: 'coordinates', v: [27.55, 53.9] }, { p: 'region', vl: 'Минск' }, { p: 'rooms', v: '1' }],
      account_parameters: [{ p: 'address', v: 'Минск' }] }], pagination: { pages: [] } });
    throw Error('Unexpected URL');
  });
  const minsk = CITIES.findIndex(row => row[0] === 'Минск');
  sql.prepare('INSERT INTO search_preferences VALUES (?,?)').run('123', JSON.stringify({ cities: [minsk], locationChosen: true }));
  sql.prepare('INSERT INTO meta VALUES (?,?)').run(cursorKey('123'), '2026-10-01T09:00:00.000Z');
  const env = { DB, TELEGRAM_CHAT_ID: '123', TELEGRAM_BOT_TOKEN: 'test' };
  const step = { do: async (_, ...args) => args.at(-1)(), sleep: async () => {} };
  const run = id => new ApartmentScan({}, env).run({ instanceId: id,
    payload: { chatId: '123', kind: 'check', requestedAt: Date.parse('2026-10-01T11:00:00Z') } }, step);
  const partial = await run('blocked-run');
  assert.equal(partial.partial, true);
  assert.ok(messages.some(m => m.text?.includes('Realt: доступ ограничен площадкой (HTTP 403)')));
  assert.ok(messages.some(m => m.text?.includes('https://re.kufar.by/vi/123')));
  assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey('123')).value, '2026-10-01T09:00:00.000Z');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM locks').get().n, 0);
  blocked = false;
  const complete = await run('recovered-run');
  assert.equal(complete.partial, false);
  assert.equal(messages.filter(m => m.text?.includes('https://re.kufar.by/vi/123')).length, 1);
  assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey('123')).value, '2026-10-01T11:00:00.000Z');
});

test('pause is per-user, persists independently of settings, and preserves manual checks and resume', async t => {
  const { DB, sql } = database(); t.after(() => sql.close()); const messages = telegramMock(t), scans = [];
  const env = { DB, TELEGRAM_CHAT_ID: '999', TELEGRAM_BOT_TOKEN: 'test', WEBHOOK_SECRET: 'secret', SCAN: { create: async options => { scans.push(options.params); return { id: 'test' }; } } };
  const minsk = CITIES.findIndex(row => row[0] === 'Минск');
  for (const chatId of ['123', '456']) {
    sql.prepare('INSERT INTO bot_users(chat_id,authorized) VALUES (?,1)').run(chatId);
    sql.prepare('INSERT INTO search_preferences VALUES (?,?)').run(chatId, JSON.stringify({ cities: [minsk], locationChosen: true, frequency: '30m' }));
  }
  await post(env, message(123, '⏸ Пауза'));
  assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get('schedule_paused:123').value, '1');
  assert.ok(messages.at(-1).reply_markup.keyboard.flat().some(b=>b.text==='▶️ Продолжить'));
  let job;
  const tick = async () => { await worker.scheduled({cron:'*/10 * * * *',scheduledTime:Date.parse('2026-10-04T05:00:00Z')},env,{waitUntil:p=>job=p}); await job; };
  await tick(); assert.deepEqual(scans.map(x=>x.chatId),['456']);
  await post(env, message(123, '🔄 Проверить')); assert.equal(scans.at(-1).chatId,'123'); assert.equal(scans.at(-1).kind,'check');
  await post(env, message(123, '📋 Мой поиск')); assert.match(messages.at(-1).text,/на паузе/);
  await post(env, message(123, '▶️ Продолжить')); assert.ok(messages.at(-1).reply_markup.keyboard.flat().some(b=>b.text==='⏸ Пауза'));
  scans.length=0; await tick(); assert.deepEqual(scans.map(x=>x.chatId),['123','456']);
});

test('pausing an automatic delivery stops remaining alerts, keeps its cursor, and releases the lock', async t => {
  const {DB,sql}=database();t.after(()=>sql.close());const messages=telegramMock(t);
  const chatId='123', runId='automatic', item={key:'kufar:pending',publishedAt:'2026-10-04T10:00:00Z',address:'Минск',rooms:1,priceByn:900,url:'https://re.kufar.by/vi/123'};
  sql.prepare('INSERT INTO scan_runs VALUES (?,?,?,?,?,?,?)').run(runId,'2026-10-04T09:00:00Z','2026-10-04T11:00:00Z','send',1,null,1);
  sql.prepare('INSERT INTO scan_recipients VALUES (?,?)').run(runId,chatId);
  sql.prepare('INSERT INTO meta VALUES (?,?)').run(`automatic_scan:${runId}`,'1');
  sql.prepare('INSERT INTO meta VALUES (?,?)').run(cursorKey(chatId),'2026-10-04T09:00:00Z');
  sql.prepare('INSERT INTO locks VALUES (?,?,?)').run(scanLock(chatId),runId,Date.now()+600000);
  sql.prepare('INSERT INTO pending VALUES (?,?,?,?)').run(runId,item.key,item.publishedAt,JSON.stringify(item));
  const step={do:async(_, ...args)=>args.at(-1)(),sleep:async()=>{sql.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('schedule_paused:123','1');}};
  const result=await new ApartmentScan({}, {DB,TELEGRAM_BOT_TOKEN:'test'}).run({payload:{runId}},step);
  assert.equal(result.paused,true); assert.equal(messages.length,0);
  assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey(chatId)).value,'2026-10-04T09:00:00Z');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM user_sent').get().n,0);
  for(const table of ['locks','pending','scan_runs']) assert.equal(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
  assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(`automatic_scan:${runId}`),undefined);
});

test('manual scan continuation still delivers while the schedule is paused', async t => {
  const {DB,sql}=database();t.after(()=>sql.close());const messages=telegramMock(t),runId='manual',chatId='123';
  sql.prepare('INSERT INTO scan_runs VALUES (?,?,?,?,?,?,?)').run(runId,'2026-10-04T09:00:00Z','2026-10-04T11:00:00Z','send',1,null,0);
  sql.prepare('INSERT INTO scan_recipients VALUES (?,?)').run(runId,chatId);
  sql.prepare('INSERT INTO locks VALUES (?,?,?)').run(scanLock(chatId),runId,Date.now()+600000);
  sql.prepare('INSERT INTO meta VALUES (?,?)').run(`automatic_scan:${runId}`,'0');
  sql.prepare('INSERT INTO meta VALUES (?,?)').run('schedule_paused:123','1');
  const result=await new ApartmentScan({}, {DB,TELEGRAM_BOT_TOKEN:'test'}).run({payload:{runId}}, {do:async(_, ...args)=>args.at(-1)(),sleep:async()=>{}});
  assert.equal(result.delivered,true); assert.equal(messages.length,1);
  assert.ok(messages[0].reply_markup.keyboard.flat().some(b=>b.text==='▶️ Продолжить'));
});

test('manual-only settings exclude cron and queued automatic scans while retaining button checks', async t => {
  const {DB,sql}=database();t.after(()=>sql.close());telegramMock(t);const scans=[];
  const env={DB,TELEGRAM_CHAT_ID:'999',TELEGRAM_BOT_TOKEN:'test',WEBHOOK_SECRET:'secret',SCAN:{create:async options=>{scans.push(options.params);return {id:'test'};}}};
  const minsk=CITIES.findIndex(row=>row[0]==='Минск');
  for (const [id,frequency] of [['123','manual'],['456','10m']]) {
    sql.prepare('INSERT INTO bot_users(chat_id,authorized) VALUES (?,1)').run(id);
    sql.prepare('INSERT INTO search_preferences VALUES (?,?)').run(id,JSON.stringify({cities:[minsk],locationChosen:true,frequency}));
  }
  let job;await worker.scheduled({cron:'*/10 * * * *',scheduledTime:Date.parse('2026-10-04T06:00:00Z')},env,{waitUntil:p=>job=p});await job;
  assert.deepEqual(scans.map(x=>x.chatId),['456']);assert.equal(scans[0].automatic,true);
  await post(env,message(123,'🔄 Проверить'));assert.equal(scans.at(-1).chatId,'123');assert.equal(scans.at(-1).kind,'check');
  const result=await new ApartmentScan({},env).run({instanceId:'queued',payload:{chatId:'123',kind:'check',automatic:true,requestedAt:Date.now()}}, {do:async(_, ...args)=>args.at(-1)(),sleep:async()=>{}});
  assert.equal(result.paused,true);assert.equal(sql.prepare('SELECT count(*) AS n FROM scan_runs').get().n,0);
});

test('commercial workflow scans only Kufar and all Realt commercial categories with its own cursor and no budget',async t=>{
  const {DB,sql}=database();t.after(()=>sql.close());const requests=[],messages=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.includes('api.telegram.org')){messages.push(JSON.parse(options.body));return Response.json({ok:true,result:{}});}
    requests.push(url);
    if(url.includes('realt.by/belarus/rent/')) return new Response('<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{objects:[{code:321,createdAt:'2026-10-22T10:00:00Z',townName:'Минск',address:'Минск, Сурганова, 1',areaMin:50,areaMax:200,repairState:5,priceCurrency:933,pricePerM2:1000}],pagination:{page:1,pageSize:120,totalCount:1},firstPageSizeMultiplier:4}}})+'</script>');
    if(url.includes('api.kufar.by')) {assert.equal(new URL(url).searchParams.get('cat'),'1050');return Response.json({ads:[{category:1050,type:'let',ad_id:322,ad_link:'https://re.kufar.by/vi/322',list_time:'2026-10-22T10:00:00Z',price_byn:'99999900',price_usd:'30000000',ad_parameters:[{p:'region',vl:'Минск'},{p:'size',v:80}]}],pagination:{pages:[]}});}
    throw Error('Unexpected residential or Onliner source');
  });
  const city=CITIES.findIndex(row=>row[0]==='Минск');
  sql.prepare('INSERT INTO search_preferences VALUES (?,?)').run('123',JSON.stringify({propertyType:'commercial',cities:[city],areaMin:70,areaMax:90,maxByn:1}));
  sql.prepare('INSERT INTO meta VALUES (?,?)').run(cursorKey('123'),'2026-10-22T10:30:00.000Z');
  const env={DB,TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'test'};
  const result=await new ApartmentScan({},env).run({instanceId:'commercial-first',payload:{chatId:'123',kind:'check',requestedAt:Date.parse('2026-10-22T10:50:00Z')}},{do:async(_, ...args)=>args.at(-1)(),sleep:async()=>{}});
  assert.equal(result.delivered,true,JSON.stringify({result,requests}));assert.equal(requests.length,8);assert.equal(new Set(requests.filter(u=>u.includes('realt.by'))).size,7);
  assert.ok(messages.some(m=>m.text?.includes('Коммерческая недвижимость за период')));
  assert.equal(messages.filter(m=>m.text?.includes('🔗')).length,2);
  assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey('123')).value,'2026-10-22T10:30:00.000Z');
  assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey('123','commercial')).value,'2026-10-22T10:50:00.000Z');
});

test('commercial pagination retains the first-page limit across pages with different page sizes',async t=>{
 const {DB,sql}=database();t.after(()=>sql.close());const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.includes('api.telegram.org'))return Response.json({ok:true,result:{}});
  requests.push(url);
  if(url.includes('api.kufar.by'))return Response.json({ads:[],pagination:{pages:[]}});
  const page=Number(new URL(url).searchParams.get('page')||1);
  // First page contains four normal pages; subsequent pages report multiplier 1.
  return new Response('<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{objects:[{code:page,townName:'Минск',createdAt:'2026-10-21T00:00:00Z'}],pagination:{page,pageSize:page===1?120:30,totalCount:125},firstPageSizeMultiplier:page===1?4:1}}})+'</script>');
 });
 const city=CITIES.findIndex(row=>row[0]==='Минск');
 sql.prepare('INSERT INTO search_preferences VALUES (?,?)').run('123',JSON.stringify({propertyType:'commercial',cities:[city]}));
 const result=await new ApartmentScan({}, {DB,TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'test'}).run({instanceId:'pagination',payload:{chatId:'123',kind:'check',requestedAt:Date.parse('2026-10-22T10:50:00Z')}},{do:async(_, ...args)=>args.at(-1)(),sleep:async()=>{}});
 assert.equal(result.delivered,true);assert.equal(requests.length,15);assert.equal(requests.filter(u=>new URL(u).searchParams.get('page')==='2').length,7);
 assert.ok(requests.every(u=>Number(new URL(u).searchParams.get('page')||1)<=2));
});

test('Kufar public-web recovery delivers listings and safely continues web pagination after API 403',async t=>{
 const {DB,sql}=database();t.after(()=>sql.close());const messages=[],requests=[],sleeps=[];
 const item={category:1050,type:'let',ad_id:777,ad_link:'https://re.kufar.by/vi/777',list_time:'2026-10-23T10:00:00Z',ad_parameters:[{p:'region',vl:'Минск'},{p:'size',v:80}]};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  url=String(url);if(url.includes('api.telegram.org')){messages.push(JSON.parse(options.body));return Response.json({ok:true,result:{}});}
  requests.push(url);
  if(url.includes('api.kufar.by'))return new Response('',{status:403});
  if(url.includes('re.kufar.by'))return new Response('<script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{listing:{ads:new URL(url).searchParams.has('cursor')?[]:[item],pagination:new URL(url).searchParams.has('cursor')?[]:[{label:'next',token:'page-two'}]}}}})+'</script>');
  return new Response('<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{objects:[],pagination:{page:1,pageSize:30,totalCount:0}}}})+'</script>');
 });
 const city=CITIES.findIndex(row=>row[0]==='Минск');sql.prepare('INSERT INTO search_preferences VALUES (?,?)').run('123',JSON.stringify({cities:[city],propertyType:'commercial',areaMin:70,areaMax:90}));
 const result=await new ApartmentScan({}, {DB,TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'test'}).run({instanceId:'web-recovery',payload:{chatId:'123',kind:'check',requestedAt:Date.parse('2026-10-23T10:50:00Z')}},{do:async(_, ...args)=>args.at(-1)(),sleep:async(name)=>sleeps.push(name)});
 assert.equal(result.partial,false);assert.ok(messages.some(m=>m.text?.includes(item.ad_link)));assert.equal(requests.filter(u=>u.includes('api.kufar.by')).length,1);assert.equal(requests.filter(u=>u.includes('re.kufar.by')).length,2);assert.equal(sleeps.filter(s=>s.startsWith('source-pace-')).length,9);
 assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey('123','commercial')).value,'2026-10-23T10:50:00.000Z');
});

test('repeated identical automatic outage warnings are quiet while manual checks and recovery stay visible',async t=>{
 const {DB,sql}=database();t.after(()=>sql.close());const messages=[];let blocked=true;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  url=String(url);if(url.includes('api.telegram.org')){messages.push(JSON.parse(options.body));return Response.json({ok:true,result:{}});}
  if(url.includes('onliner.by'))return Response.json({apartments:[],page:{last:1}});
  if(url.includes('kufar.by'))return blocked?new Response('',{status:403}):Response.json({ads:[],pagination:{pages:[]}});
  return new Response('<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{objects:[],pagination:{totalCount:0}}}})+'</script>');
 });
 const city=CITIES.findIndex(row=>row[0]==='Минск');sql.prepare('INSERT INTO search_preferences VALUES (?,?)').run('123',JSON.stringify({cities:[city],frequency:'30m'}));sql.prepare('INSERT INTO meta VALUES (?,?)').run(cursorKey('123'),'2026-10-23T09:00:00.000Z');
 const env={DB,TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'test'},step={do:async(_, ...args)=>args.at(-1)(),sleep:async()=>{}};
 const run=(id,automatic)=>new ApartmentScan({},env).run({instanceId:id,payload:{chatId:'123',kind:'check',automatic,requestedAt:Date.parse('2026-10-23T10:50:00Z')}},step);
 assert.equal((await run('one',true)).partial,true);assert.equal(messages.length,1);
 assert.equal((await run('two',true)).partial,true);assert.equal(messages.length,1);
 assert.equal(sql.prepare('SELECT value FROM meta WHERE key=?').get(cursorKey('123')).value,'2026-10-23T09:00:00.000Z');
 await run('manual',false);assert.equal(messages.length,2);assert.match(messages[1].text,/Повторите проверку кнопкой/);
 blocked=false;assert.equal((await run('recovered',true)).partial,false);assert.equal(messages.length,3);assert.doesNotMatch(messages[2].text,/Проверка неполная/);
});

test('source diagnostics require the internal secret and reject arbitrary destinations',async t=>{
 const {DB,sql}=database();t.after(()=>sql.close());let requests=0;
 t.mock.method(globalThis,'fetch',async()=>{requests++;return Response.json({ads:[],pagination:{pages:[]}});});
 const request=(headers,source)=>new Request('https://worker.test/internal/source-health',{method:'POST',headers,body:JSON.stringify({source})});
 const env={DB,WEBHOOK_SECRET:'secret'};
 assert.equal((await worker.fetch(request({},'kufar'),env)).status,403);
 assert.equal((await worker.fetch(request({'X-Telegram-Bot-Api-Secret-Token':'secret'},'https://evil.test'),env)).status,400);assert.equal(requests,0);
 const response=await worker.fetch(request({'X-Telegram-Bot-Api-Secret-Token':'secret'},'kufar'),env);assert.equal((await response.json()).available,true);assert.equal(requests,1);
});
