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
