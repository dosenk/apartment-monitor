import { preferences, STATIONS, LINES, FREQUENCIES } from './metro.mjs';
import { CITIES } from './geography.mjs';
import { OBLASTS, rayons, cities, directCities } from './location.mjs';
import { DISTRICTS, CITY_DISTRICTS } from './districts.mjs';
import { scanLock, schedulePaused } from './access.mjs';

const encoder = new TextEncoder();
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (message, status) => Object.assign(new Error(message), { status });
export async function validateInitData(raw, token, now = Date.now()) {
  if (typeof raw !== 'string' || raw.length > 12000 || !token) throw fail('Откройте настройки через меню Telegram-бота.', 401);
  const fields = new URLSearchParams(raw);
  if ([...fields.keys()].some((key, i, all) => all.indexOf(key) !== i)) throw fail('Неверная авторизация Telegram.', 401);
  const hash = fields.get('hash');
  if (!/^[a-f0-9]{64}$/.test(hash || '')) throw fail('Неверная авторизация Telegram.', 401);
  const date = Number(fields.get('auth_date'));
  if (!Number.isInteger(date) || date > now / 1000 + 30 || date < now / 1000 - 3600) throw fail('Сессия истекла. Закройте и снова откройте настройки.', 401);
  fields.delete('hash');
  const data = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const base = await crypto.subtle.importKey('raw', encoder.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', base, encoder.encode(token));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, Uint8Array.from(hash.match(/../g), x => parseInt(x, 16)), encoder.encode(data));
  if (!valid) throw fail('Неверная авторизация Telegram.', 401);
  let user;
  try { user = JSON.parse(fields.get('user')); } catch { throw fail('Неверная авторизация Telegram.', 401); }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw fail('Неверная авторизация Telegram.', 401);
  return user;
}
const place = ({ index, row }) => ({ id: index, name: row[0], type: row[3], oblast: row[1], rayon: row[2] });
export function checkedPreferences(value) {
  if (!value || !Array.isArray(value.cities) || !value.cities.length || value.cities.length > 50 ||
      value.cities.some(x => !Number.isInteger(x) || !CITIES[x])) throw fail('Выберите хотя бы один населённый пункт (не более 50).', 400);
  if (!FREQUENCIES.includes(value.frequency)) throw fail('Выберите частоту проверки.', 400);
  if (value.maxByn !== null && (!Number.isFinite(value.maxByn) || value.maxByn <= 0 || value.maxByn > 100000)) throw fail('Цена должна быть от 0,01 до 100000 BYN или без ограничения.', 400);
  for (const [name, choices] of [['stations', STATIONS.map((_, i) => i)], ['onliner', ['near', '1', '2', '3']], ['districts', DISTRICTS]]) {
    if (!Array.isArray(value[name]) || value[name].length > choices.length || value[name].some(x => !choices.includes(x))) throw fail('Неизвестный фильтр поиска.', 400);
  }
  if (value.onliner.includes('near') && value.onliner.length > 1) throw fail('Выберите «Возле метро» либо конкретные линии.', 400);
  if (value.cityDistricts != null && (typeof value.cityDistricts !== 'object' || Array.isArray(value.cityDistricts) ||
      Object.entries(value.cityDistricts).some(([city, names]) => !CITY_DISTRICTS[city] || !Array.isArray(names) || names.length > CITY_DISTRICTS[city].length || names.some(x => !CITY_DISTRICTS[city].includes(x))))) throw fail('Неизвестный район города.', 400);
  return preferences({ ...value, locationChosen: true, browseOblast: null, browseRayon: null, placeQuery: '' });
}
export async function miniApi(request, env) {
  if (request.method !== 'POST') return json({ error: 'Используйте POST.' }, 405);
  try {
    const raw = await request.text();
    if (raw.length > 20000) throw fail('Слишком большой запрос.', 413);
    let body;
    try { body = JSON.parse(raw); } catch { throw fail('Некорректный запрос.', 400); }
    const user = await validateInitData(body?.initData, env.TELEGRAM_BOT_TOKEN);
    const chatId = String(user.id);
    if (!(await env.DB.prepare('SELECT authorized FROM bot_users WHERE chat_id=?').bind(chatId).first())?.authorized) throw fail('Сначала нажмите /start и введите пароль в чате с ботом.', 403);
    const path = new URL(request.url).pathname;
    if (path === '/api/session') {
      const row = await env.DB.prepare('SELECT settings FROM search_preferences WHERE chat_id=?').bind(chatId).first();
      const selected = preferences(row ? JSON.parse(row.settings) : { cities: [] });
      return json({ user: { firstName: user.first_name || '' }, configured: Boolean(row), paused: await schedulePaused(env, chatId), settings: selected,
        places: selected.cities.map(index => place({ index, row: CITIES[index] })),
        catalog: { oblasts: OBLASTS, lines: LINES, stations: STATIONS.map(([name, line], id) => ({ id, name, line })),
          districts: DISTRICTS, cityDistricts: CITY_DISTRICTS, frequencies: FREQUENCIES } });
    }
    if (path === '/api/region' || path === '/api/places') {
      if (!Number.isInteger(body.oblast) || !OBLASTS[body.oblast]) throw fail('Выберите область.', 400);
      const oblast = OBLASTS[body.oblast], available = rayons(oblast);
      if (path === '/api/region') return json({ direct: directCities(oblast).map(place), rayons: available });
      if (!Number.isInteger(body.rayon) || !available[body.rayon]) throw fail('Выберите район области.', 400);
      const query = typeof body.query === 'string' ? body.query.slice(0, 80) : '';
      const offset = Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
      const entries = cities(oblast, available[body.rayon], query);
      return json({ places: entries.slice(offset, offset + 30).map(place), total: entries.length, offset });
    }
    if (path === '/api/preferences') {
      const selected = checkedPreferences(body.settings);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO search_preferences(chat_id,settings) VALUES (?,?) ON CONFLICT(chat_id) DO UPDATE SET settings=excluded.settings').bind(chatId, JSON.stringify(selected)),
        env.DB.prepare('DELETE FROM search_drafts WHERE chat_id=?').bind(chatId),
      ]);
      return json({ ok: true, settings: selected, paused: await schedulePaused(env, chatId) });
    }
    if (path === '/api/check') {
      const row = await env.DB.prepare('SELECT settings FROM search_preferences WHERE chat_id=?').bind(chatId).first();
      if (!row || !preferences(JSON.parse(row.settings)).cities.length) throw fail('Сначала сохраните настройки поиска.', 400);
      const lock = await env.DB.prepare('SELECT expires FROM locks WHERE name=?').bind(scanLock(chatId)).first();
      if (lock?.expires > Date.now()) return json({ ok: true, running: true }, 202);
      await env.SCAN.create({ params: { chatId, kind: 'check', requestedAt: Date.now() } });
      return json({ ok: true, running: false }, 202);
    }
    return json({ error: 'Не найдено.' }, 404);
  } catch (error) {
    if (!error.status) console.error('Mini App request failed');
    return json({ error: error.status ? error.message : 'Не удалось выполнить запрос. Попробуйте ещё раз.' }, error.status || 500);
  }
}
