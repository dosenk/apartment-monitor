import { WorkflowEntrypoint } from 'cloudflare:workers';
import { BUTTON, interval, label, matches, onliner, realt, kufar, caption } from './logic.mjs';

const AGENT = 'ApartmentMonitor/1.0 (personal rental alerts)';
const keyboard = { inline_keyboard: [[{ text: BUTTON, callback_data: 'check_updates' }]] };
const sourceHeaders = { 'User-Agent': AGENT, Accept: 'application/json,text/html' };

async function fetchPage(url, parser, headers = sourceHeaders) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw Error(`Source HTTP ${response.status}: ${new URL(url).hostname}`);
  return parser(parser === realt ? await response.text() : await response.json());
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!result.ok) throw Error(`Telegram ${method}: ${response.status} ${result.description}`);
  return result.result;
}

async function sendListing(env, item) {
  const base = { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: 'HTML' };
  if (item.photo) {
    try {
      await telegram(env, 'sendPhoto', { ...base, photo: item.photo, caption: caption(item) });
      return;
    } catch (error) { console.warn(`Photo failed for ${item.key}: ${error}`); }
  }
  await telegram(env, 'sendMessage', { ...base, text: caption(item), disable_web_page_preview: true });
}

async function acquire(env, owner) {
  const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO locks (name, owner, expires) VALUES ('scan', ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires=excluded.expires
    WHERE locks.expires < ?`).bind(owner, now + 30 * 60 * 1000, now).run();
  return result.meta.changes > 0;
}

export class ApartmentScan extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const kind = event.payload?.kind || ({ '0 6 * * *': 'morning', '0 11 * * *': 'midday', '0 19 * * *': 'evening' }[event.schedule?.cron]);
    if (!kind) throw Error(`Unknown schedule: ${event.schedule?.cron}`);
    const owner = event.instanceId;
    let locked = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      locked = await step.do(`acquire-${attempt}`, () => acquire(env, owner));
      if (locked) break;
      await step.sleep(`wait-${attempt}`, '20 seconds');
    }
    if (!locked) throw Error('Scan lock held too long');
    try {
      const cursor = await step.do('read-cursor', async () => (await env.DB.prepare("SELECT value FROM meta WHERE key='covered_until'").first())?.value || null);
      const bounds = interval(kind, event.payload?.requestedAt || event.schedule?.scheduledTime || Date.now(), cursor);
      if (bounds.start >= bounds.end) return { skipped: true, bounds };
      const results = [];
      const cutoff = Date.parse(bounds.start);
      const onlinerParams = new URLSearchParams();
      for (const rooms of ['1_room', '2_rooms', '3_rooms', '4_rooms', '5_rooms', '6_rooms']) onlinerParams.append('rent_type[]', rooms);
      onlinerParams.set('order', 'created_at:desc');
      for (let page = 1; page <= 30; page++) {
        const url = `https://ak.api.onliner.by/search/apartments?${onlinerParams}&page=${page}`;
        const batch = await step.do(`onliner-${page}`, () => fetchPage(url, onliner));
        results.push(...batch.items.filter(x => Date.parse(x.publishedAt) >= cutoff));
        if (!batch.items.length || page >= batch.lastPage || batch.items.some(x => Date.parse(x.publishedAt) < cutoff)) break;
      }
      for (let page = 1; page <= 100; page++) {
        const url = `https://realt.by/rent/flat-for-long/${page === 1 ? '' : `?page=${page}`}`;
        const batch = await step.do(`realt-${page}`, () => fetchPage(url, realt));
        results.push(...batch.items.filter(x => Date.parse(x.publishedAt) >= cutoff));
        if (!batch.items.length || page + 1 > Math.ceil(batch.total / 30) - 2) break;
        if (page === 100) throw Error('Realt page limit reached');
      }
      const params = new URLSearchParams({ cat: '1010', typ: 'let', rgn: '7', size: '100', sort: 'lst.d', lang: 'ru' });
      for (let page = 1; page <= 100; page++) {
        const url = `https://api.kufar.by/search-api/v2/search/rendered-paginated?${params}`;
        const batch = await step.do(`kufar-${page}`, () => fetchPage(url, kufar, {
          'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36', Accept: 'application/json', Referer: 'https://re.kufar.by/',
        }));
        results.push(...batch.items.filter(x => Date.parse(x.publishedAt) >= cutoff));
        if (!batch.items.length || (batch.items.length && batch.items.every(x => Date.parse(x.publishedAt) < cutoff)) || !batch.next) break;
        params.set('cursor', batch.next);
        if (page === 100) throw Error('Kufar page limit reached');
      }
      const unique = [...new Map(results.filter(x => matches(x, bounds.start, bounds.end)).map(x => [x.key, x])).values()]
        .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
      const pending = [];
      for (const item of unique) {
        const seen = await step.do(`seen-${item.key}`, async () => !!(await env.DB.prepare('SELECT 1 FROM sent WHERE key=?').bind(item.key).first()));
        if (!seen) pending.push(item);
      }
      const header = `🏠 Квартиры за период ${label(bounds.start, bounds.end)}\n` +
        (pending.length ? `Новых объявлений: ${pending.length}` : 'Новых объявлений нет');
      await step.do('send-header', () => telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: header, reply_markup: keyboard }));
      for (const item of pending) {
        await step.do(`send-${item.key}`, () => sendListing(env, item));
        await step.do(`save-${item.key}`, () => env.DB.prepare('INSERT OR IGNORE INTO sent(key,sent_at) VALUES (?,?)').bind(item.key, new Date().toISOString()).run());
      }
      await step.do('advance-cursor', () => env.DB.prepare(`INSERT INTO meta(key,value) VALUES ('covered_until',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(bounds.end).run());
      return { bounds, sent: pending.length };
    } finally {
      await step.do('release-lock', () => env.DB.prepare("DELETE FROM locks WHERE name='scan' AND owner=?").bind(owner).run());
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
    if (url.pathname !== '/telegram' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
    const update = await request.json();
    if (String(update.callback_query?.message?.chat?.id) === env.TELEGRAM_CHAT_ID && update.callback_query?.data === 'check_updates') {
      const instance = await env.SCAN.create({ params: { kind: 'check', requestedAt: Date.now() } });
      await telegram(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'Проверяю новые квартиры…' });
      return Response.json({ ok: true, id: instance.id });
    }
    if (String(update.message?.chat?.id) === env.TELEGRAM_CHAT_ID && update.message?.text === '/start') {
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: 'Нажмите кнопку, чтобы проверить новые квартиры.', reply_markup: keyboard });
    }
    return Response.json({ ok: true });
  },
};
