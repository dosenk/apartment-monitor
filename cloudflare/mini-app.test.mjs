import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { validateInitData, miniApi, checkedPreferences } from './mini-app.mjs';
import { DEFAULT_CITY } from './location.mjs';
import { scanLock } from './access.mjs';
const token = 'fixture-token-not-real';
function signed(id, date = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(date), user: JSON.stringify({ id, first_name: 'Test' }), query_id: 'test' });
  const data = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(data).digest('hex')); return params.toString();
}
test('Mini App accepts Telegram signatures and rejects tampering, stale sessions and duplicate fields', async () => {
  assert.equal((await validateInitData(signed(123), token)).id, 123);
  await assert.rejects(validateInitData(signed(123).replace('Test', 'Fake'), token));
  await assert.rejects(validateInitData(signed(123), 'another-token'));
  await assert.rejects(validateInitData(signed(123, Math.floor(Date.now()/1000)-3601), token));
  await assert.rejects(validateInitData(signed(123, Math.floor(Date.now()/1000)+60), token));
  await assert.rejects(validateInitData(signed(123) + '&user=%7B%22id%22%3A456%7D', token));
  await assert.rejects(validateInitData(signed(-123), token));
  await assert.rejects(validateInitData('', token));
});
test('Mini App settings and manual checks use only the authenticated user; password gate remains mandatory', async t => {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close()); sql.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  const prepare = query => { const statement = sql.prepare(query); const bound = args => ({ first: async () => statement.get(...args), run: async () => statement.run(...args) }); return { ...bound([]), bind: (...args) => bound(args) }; };
  const scans = [], env = { TELEGRAM_BOT_TOKEN: token, DB: { prepare, batch: async ss => ss.map(s=>s.run()) }, SCAN: { create: async p => scans.push(p) } };
  const request = (path, id, body = {}) => miniApi(new Request(`https://worker.test/api/${path}`, { method: 'POST', body: JSON.stringify({ ...body, initData: signed(id) }) }), env);
  assert.equal((await request('session', 123)).status, 403);
  sql.prepare('INSERT INTO bot_users(chat_id,authorized) VALUES (?,1)').run('123');
  sql.prepare('INSERT INTO bot_users(chat_id,authorized) VALUES (?,1)').run('456');
  const prefs = { cities: [DEFAULT_CITY], stations: [], onliner: [], districts: [], cityDistricts: {}, maxByn: 1000, frequency: '30m' };
  assert.equal((await request('check', 123)).status, 400);
  sql.prepare('INSERT INTO meta VALUES (?,?)').run('schedule_paused:123','1');
  const saved = await request('preferences',123,{ settings:prefs, chatId:'456' });
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).paused,true);
  assert.equal((await (await request('session',123)).json()).paused,true);
  assert.equal((await (await request('session',456)).json()).paused,false);
  assert.equal(sql.prepare('SELECT settings FROM search_preferences WHERE chat_id=?').get('456'), undefined);
  assert.equal((await (await request('session',456)).json()).configured,false);
  assert.equal((await request('preferences',456,{ settings:{...prefs,maxByn:2000} })).status,200);
  assert.equal((await (await request('session',123)).json()).settings.maxByn,1000);
  await request('check',123,{chatId:'456'}); assert.equal(scans[0].params.chatId,'123');
  sql.prepare('INSERT INTO locks VALUES (?,?,?)').run(scanLock('123'),'scan',Date.now()+60000);
  assert.equal((await (await request('check',123)).json()).running,true); assert.equal(scans.length,1);
  assert.equal((await request('preferences',123,{settings:{...prefs,cities:[]}})).status,400);
  assert.equal((await request('region',123,{oblast:4})).status,200);
  const region = await (await request('region',123,{oblast:4})).json();
  assert.ok(region.direct.some(x=>x.name==='Минск')); assert.ok(region.rayons.includes('Клецкий'));
  assert.equal((await request('places',123,{oblast:4,rayon:999})).status,400);
});
test('Mini App rejects malformed budgets and filters instead of silently changing them', () => {
  const good = { cities: [DEFAULT_CITY], stations: [], onliner: [], districts: [], maxByn: null, frequency: '30m' };
  assert.equal(checkedPreferences(good).radiusKm,null);
  for (const change of [{maxByn:-1},{maxByn:'500'},{cities:[999999]},{stations:[999]},{onliner:['near','1']},{districts:['unknown']},{frequency:'1m'},{cityDistricts:{Unknown:['Unknown']}}]) assert.throws(()=>checkedPreferences({...good,...change}));
});
