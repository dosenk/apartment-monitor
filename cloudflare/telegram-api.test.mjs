import test from 'node:test';
import assert from 'node:assert/strict';
import { telegram } from './telegram-api.mjs';

test('an expired callback acknowledgement does not block menu navigation', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const method = url.split('/').at(-1);
    calls.push({ method, payload: JSON.parse(options.body) });
    return Response.json(method === 'answerCallbackQuery'
      ? { ok: false, error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' }
      : { ok: true, result: { message_id: 42 } }, { status: method === 'answerCallbackQuery' ? 400 : 200 });
  });
  const env = { TELEGRAM_BOT_TOKEN: 'test-token' };
  await telegram(env, 'answerCallbackQuery', { callback_query_id: 'expired' });
  await telegram(env, 'editMessageText', { message_id: 42, text: 'Настройки поиска' });
  assert.deepEqual(calls.map(x => x.method), ['answerCallbackQuery', 'editMessageText']);
  assert.equal(calls[1].payload.text, 'Настройки поиска');
});

test('repeated menu edits are idempotent, while real Telegram failures remain visible', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error_code: 400,
    description: 'Bad Request: message is not modified' }, { status: 400 }));
  assert.equal(await telegram({ TELEGRAM_BOT_TOKEN: 'test' }, 'editMessageText', {}), null);
  await assert.rejects(telegram({ TELEGRAM_BOT_TOKEN: 'test' }, 'sendMessage', {}), /message is not modified/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error_code: 403,
    description: 'Forbidden: bot was blocked by the user' }, { status: 403 }));
  await assert.rejects(telegram({ TELEGRAM_BOT_TOKEN: 'test' }, 'answerCallbackQuery', {}), /Forbidden/);
});
