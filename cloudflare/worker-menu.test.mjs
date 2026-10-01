import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Only the Cloudflare base class is unavailable in Node; exercise the actual webhook handler.
const source = (await readFile(new URL('./worker.mjs', import.meta.url), 'utf8'))
  .replace("import { WorkflowEntrypoint } from 'cloudflare:workers';", 'class WorkflowEntrypoint {}')
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, import.meta.url).href}'`);
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('frequency page, repeated selection and Back survive expired callback retries', async t => {
  let settings = JSON.stringify({ cities: [], locationChosen: true, frequency: '30m' });
  let displayed = '';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith('/answerCallbackQuery')) return Response.json({ ok: false, error_code: 400,
      description: 'Bad Request: query ID is invalid' }, { status: 400 });
    if (displayed === payload.text) return Response.json({ ok: false, error_code: 400,
      description: 'Bad Request: message is not modified' }, { status: 400 });
    displayed = payload.text;
    return Response.json({ ok: true, result: { message_id: 42 } });
  });
  const env = { TELEGRAM_CHAT_ID: '123', TELEGRAM_BOT_TOKEN: 'test', WEBHOOK_SECRET: 'secret\n',
    DB: { prepare: (sql) => ({ bind: (...args) => ({
      first: async () => sql.includes('bot_users') ? { authorized: 1 } : { settings, awaiting: null },
      run: async () => { if (args[1]) settings = args[1]; },
    }) }) } };
  for (const action of ['frequency', 'frequency:30m', 'frequency:1h', 'home']) {
    const response = await worker.fetch(new Request('https://worker.test/telegram', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'secret' },
      body: JSON.stringify({ callback_query: { id: 'expired', data: `prefs:${action}`,
        message: { message_id: 42, chat: { id: 123, type: 'private' } } } }),
    }), env);
    assert.equal(response.status, 200, action);
    assert.equal((await response.json()).ok, true, action);
  }
  assert.equal(JSON.parse(settings).frequency, '1h');
  assert.ok(displayed.startsWith('⚙️ Настройки поиска'));
  const denied = await worker.fetch(new Request('https://worker.test/telegram', { method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }, body: '{}' }), env);
  assert.equal(denied.status, 403);
});
