import { telegram } from './telegram-api.mjs';

export const scope = (env, chatId) => ({ ...env, TELEGRAM_CHAT_ID: String(chatId) });
export const scanLock = chatId => `scan:${chatId}`;
export const cursorKey = chatId => `covered_until:${chatId}`;

async function samePassword(input, expected) {
  const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(input), digest(expected)]);
  return a.reduce((difference, byte, i) => difference | (byte ^ b[i]), 0) === 0;
}

export async function access(env, update, now = Date.now()) {
  const chat = update.callback_query?.message?.chat || update.message?.chat;
  if (!chat || chat.type !== 'private' || !Number.isSafeInteger(chat.id) || chat.id <= 0) return false;
  const chatId = String(chat.id);
  const row = await env.DB.prepare('SELECT authorized,failures,blocked_until FROM bot_users WHERE chat_id=?')
    .bind(chatId).first();
  if (row?.authorized) return true;
  const callback = update.callback_query;
  const text = update.message?.text;
  if (callback) {
    await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Сначала введите пароль в личном чате с ботом.', show_alert: true });
    return false;
  }
  let response = '🔐 Для доступа введите пароль. Регистр букв важен.';
  if (row?.blocked_until > now) response = 'Слишком много попыток. Попробуйте через 10 минут.';
  else if (typeof text === 'string' && !text.startsWith('/')) {
    if (!env.BOT_ACCESS_PASSWORD) response = 'Вход пока не настроен владельцем. Попробуйте позже.';
    else if (text.length <= 128 && await samePassword(text, env.BOT_ACCESS_PASSWORD)) {
      await env.DB.prepare(`INSERT INTO bot_users(chat_id,authorized,failures,blocked_until) VALUES (?,1,0,0)
        ON CONFLICT(chat_id) DO UPDATE SET authorized=1,failures=0,blocked_until=0`).bind(chatId).run();
      // Remove the submitted password when Telegram permits it; never log its contents.
      try { await telegram(env, 'deleteMessage', { chat_id: chatId, message_id: update.message.message_id }); } catch { /* optional */ }
      await telegram(env, 'sendMessage', { chat_id: chatId, text: '✅ Доступ открыт. Настройте свой поиск и нажмите «Применить».' });
      return true;
    } else {
      const failures = (row?.blocked_until && row.blocked_until <= now ? 0 : row?.failures || 0) + 1;
      await env.DB.prepare(`INSERT INTO bot_users(chat_id,authorized,failures,blocked_until) VALUES (?,0,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until`)
        .bind(chatId, failures, failures >= 5 ? now + 600000 : 0).run();
      response = failures >= 5 ? 'Слишком много попыток. Попробуйте через 10 минут.' : 'Пароль неверный. Попробуйте ещё раз.';
    }
  }
  await telegram(env, 'sendMessage', { chat_id: chatId, text: response, reply_markup: { remove_keyboard: true } });
  return false;
}
