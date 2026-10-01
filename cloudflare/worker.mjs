import { WorkflowEntrypoint } from 'cloudflare:workers';
import { BUTTON, interval, label, matches, onliner, realt, kufar, caption } from './logic.mjs';
import { LINES, STATIONS, preferences, toggleStation, toggleOnliner } from './metro.mjs';

const AGENT = 'ApartmentMonitor/1.0 (personal rental alerts)';
const SETTINGS_BUTTON = '⚙️ Настроить метро';
const keyboard = { keyboard: [[{ text: BUTTON }], [{ text: SETTINGS_BUTTON }]],
  resize_keyboard: true, is_persistent: true };

async function readPreferences(env) {
  const value = (await env.DB.prepare("SELECT value FROM meta WHERE key='search_preferences'").first())?.value;
  try { return preferences(JSON.parse(value)); } catch { return preferences(null); }
}

async function savePreferences(env, selected) {
  await env.DB.prepare(`INSERT INTO meta(key,value) VALUES ('search_preferences',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(selected)).run();
}

function menu(screen, selected) {
  const pick = (label, data) => ({ text: label, callback_data: `prefs:${data}` });
  if (screen.startsWith('stations:')) {
    const line = Number(screen.split(':')[1]);
    const title = LINES.find(x => x.id === line)?.name || LINES[0].name;
    const index = LINES.some(x => x.id === line) ? line : 1;
    const stationButtons = STATIONS.flatMap((station, i) => station[1] === index
      ? [pick(`${selected.stations.includes(i) ? '☑️' : '☐'} ${station[0]}`, `station:${i}`)] : []);
    return {
      text: `🚇 Realt и Kufar · ${title}\nОтметьте станции. Радиус — 3 км от выбранной станции.\n` +
        `Если станций нет, действует прежний район Якуба Коласа (3 км).`,
      inline_keyboard: [
        LINES.map(x => pick(`${index === x.id ? '• ' : ''}${x.id}-я линия`, `stations:${x.id}`)),
        ...stationButtons.map(button => [button]),
        [pick('Сбросить станции', 'reset:stations'), pick('⬅️ Настройки', 'home')],
      ],
    };
  }
  if (screen === 'onliner') {
    const options = [['near', 'Возле метро (до 3 км)'], ...LINES.map(x => [String(x.id), x.name])];
    return {
      text: '🚇 Onliner\nВыберите линии или все станции. Поиск использует координаты квартир и радиус 3 км.\n' +
        'Если ничего не выбрано, действует прежний район Якуба Коласа (3 км).',
      inline_keyboard: [
        ...options.map(([id, name]) => [pick(`${selected.onliner.includes(id) ? '☑️' : '☐'} ${name}`, `option:${id}`)]),
        [pick('Сбросить Onliner', 'reset:onliner'), pick('⬅️ Настройки', 'home')],
      ],
    };
  }
  const stationNames = selected.stations.map(i => STATIONS[i]?.[0]).filter(Boolean);
  const onlinerNames = selected.onliner.map(id => id === 'near' ? 'возле метро' : LINES.find(x => String(x.id) === id)?.name).filter(Boolean);
  return {
    text: '⚙️ Настройки метро\n' +
      `Realt + Kufar: ${stationNames.length ? stationNames.join(', ') : 'район Якуба Коласа (3 км)'}\n` +
      `Onliner: ${onlinerNames.length ? onlinerNames.join(', ') : 'район Якуба Коласа (3 км)'}\n\n` +
      'Цена до $500. Изменения действуют с новой проверки; уже отправленные объявления не повторяются.',
    inline_keyboard: [
      [pick('🚇 Станции Realt + Kufar', 'stations:1')],
      [pick('🚇 Линии Onliner', 'onliner')],
      [pick('Готово', 'close')],
    ],
  };
}

async function showMenu(env, screen, messageId) {
  const selected = await readPreferences(env);
  const view = menu(screen, selected);
  const payload = { chat_id: env.TELEGRAM_CHAT_ID, text: view.text,
    reply_markup: { inline_keyboard: view.inline_keyboard } };
  if (messageId) await telegram(env, 'editMessageText', { ...payload, message_id: messageId });
  else await telegram(env, 'sendMessage', payload);
}

async function fetchPage(url, parser) {
  const headers = new URL(url).hostname === 'api.kufar.by' ?
    { 'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36', Accept: 'application/json', Referer: 'https://re.kufar.by/' } :
    { 'User-Agent': AGENT, Accept: 'application/json,text/html' };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 240);
    throw Error(`Source HTTP ${response.status}: ${new URL(url).hostname}; server=${response.headers.get('server')}; type=${response.headers.get('content-type')}; detail=${detail}`);
  }
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
    const runId = event.payload?.runId || event.instanceId;
    let handoff = false;
    const nextInstance = async () => ({ id: (await env.SCAN.create({ params: { runId } })).id });
    try {
      if (!event.payload?.runId) {
        const kind = event.payload?.kind || ({ '0 6 * * *': 'morning', '0 11 * * *': 'midday', '0 19 * * *': 'evening' }[event.schedule?.cron]);
        if (!kind) throw Error('Unknown scan type');
        let locked = false;
        for (let attempt = 0; attempt < 90; attempt++) {
          locked = await step.do(`acquire-${attempt}`, () => acquire(env, runId));
          if (locked) break;
          await step.sleep(`wait-${attempt}`, '20 seconds');
        }
        if (!locked) throw Error('Scan lock held too long');
        const cursor = await step.do('read-cursor', async () =>
          (await env.DB.prepare("SELECT value FROM meta WHERE key='covered_until'").first())?.value || null);
        const bounds = interval(kind, event.payload?.requestedAt || event.schedule?.scheduledTime || Date.now(), cursor);
        if (bounds.start >= bounds.end) return { skipped: true, bounds };
        const selected = await step.do('read-settings', () => readPreferences(env));
        await step.do('init-run', () => env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO scan_runs
            (id,start,end,stage,page,cursor,header_sent) VALUES (?,?,?,'onliner',1,NULL,0)`)
            .bind(runId, bounds.start, bounds.end),
          env.DB.prepare('INSERT OR IGNORE INTO scan_preferences(run_id,settings) VALUES (?,?)')
            .bind(runId, JSON.stringify(selected)),
        ]));
      } else {
        const renewed = await step.do('renew-lock', async () => env.DB.prepare(
          "UPDATE locks SET expires=? WHERE name='scan' AND owner=?")
          .bind(Date.now() + 30 * 60 * 1000, runId).run());
        if (!renewed.meta.changes) throw Error('Scan lock expired or belongs to another check');
      }
      let state = await step.do('load-run', () => env.DB.prepare('SELECT * FROM scan_runs WHERE id=?').bind(runId).first());
      if (!state) throw Error('Scan state missing');
      const selected = await step.do('load-settings', async () => {
        const row = await env.DB.prepare('SELECT settings FROM scan_preferences WHERE run_id=?').bind(runId).first();
        return row ? preferences(JSON.parse(row.settings)) : preferences(null);
      });
      const cutoff = Date.parse(state.start);
      const onlinerParams = new URLSearchParams();
      for (const rooms of ['1_room', '2_rooms', '3_rooms', '4_rooms', '5_rooms', '6_rooms']) onlinerParams.append('rent_type[]', rooms);
      onlinerParams.set('order', 'created_at:desc');
      let fetched = 0;
      while (state.stage !== 'send' && fetched < 15) {
        const source = state.stage, page = state.page;
        let url, parser;
        if (source === 'onliner') {
          url = `https://ak.api.onliner.by/search/apartments?${onlinerParams}&page=${page}`;
          parser = onliner;
        } else if (source === 'realt') {
          url = `https://realt.by/rent/flat-for-long/${page === 1 ? '' : `?page=${page}`}`;
          parser = realt;
        } else if (source === 'kufar') {
          const params = new URLSearchParams({ cat: '1010', typ: 'let', rgn: '7', size: '100', sort: 'lst.d', lang: 'ru' });
          if (state.cursor) params.set('cursor', state.cursor);
          url = `https://api.kufar.by/search-api/v2/search/rendered-paginated?${params}`;
          parser = kufar;
        } else throw Error(`Unknown source ${source}`);
        const batch = await step.do(`fetch-${source}-${page}`, () => fetchPage(url, parser));
        const candidates = batch.items.filter(x => matches(x, state.start, state.end, selected));
        const older = batch.items.some(x => Date.parse(x.publishedAt) < cutoff);
        let done;
        if (source === 'onliner') done = !batch.items.length || page >= batch.lastPage || older;
        else if (source === 'realt') done = !batch.items.length || page + 1 > Math.ceil(batch.total / 30) - 2;
        else done = !batch.items.length || batch.items.every(x => Date.parse(x.publishedAt) < cutoff) || !batch.next;
        if (!done && ((source === 'onliner' && page >= 30) || page >= 100))
          throw Error(`${source} page limit reached; cannot guarantee full search`);
        const next = done ? ({ onliner: 'realt', realt: 'kufar', kufar: 'send' })[source] : source;
        const nextPage = done ? 1 : page + 1;
        const nextCursor = !done && source === 'kufar' ? batch.next : null;
        await step.do(`save-${source}-${page}`, () => env.DB.batch([
          ...candidates.map(x => env.DB.prepare(`INSERT OR IGNORE INTO pending(run_id,key,published_at,item)
            VALUES (?,?,?,?)`).bind(runId, x.key, x.publishedAt, JSON.stringify(x))),
          env.DB.prepare('UPDATE scan_runs SET stage=?,page=?,cursor=? WHERE id=?')
            .bind(next, nextPage, nextCursor, runId),
        ]));
        state = { ...state, stage: next, page: nextPage, cursor: nextCursor };
        fetched++;
      }
      if (state.stage !== 'send') {
        const instance = await step.do('continue-pages', nextInstance);
        handoff = true;
        return { continued: instance.id, source: state.stage, page: state.page };
      }
      const count = async () => (await env.DB.prepare(`SELECT count(*) AS n FROM pending p
        LEFT JOIN sent s ON s.key=p.key WHERE p.run_id=? AND s.key IS NULL`).bind(runId).first()).n;
      if (!state.header_sent) {
        const total = await step.do('count-pending', count);
        const heading = `🏠 Квартиры за период ${label(state.start, state.end)}\n` +
          (total ? `Новых объявлений: ${total}` : 'Новых объявлений нет');
        await step.do('send-header', async () => {
          await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: heading, reply_markup: keyboard });
          await env.DB.prepare('UPDATE scan_runs SET header_sent=1 WHERE id=?').bind(runId).run();
        });
      }
      const batch = await step.do('pending-batch', async () => (await env.DB.prepare(`SELECT p.item FROM pending p
        LEFT JOIN sent s ON s.key=p.key WHERE p.run_id=? AND s.key IS NULL
        ORDER BY p.published_at,p.key LIMIT 12`).bind(runId).all()).results);
      for (const row of batch) {
        const item = JSON.parse(row.item);
        await step.do(`send-${item.key}`, () => sendListing(env, item));
        await step.do(`save-${item.key}`, () => env.DB.prepare('INSERT OR IGNORE INTO sent(key,sent_at) VALUES (?,?)')
          .bind(item.key, new Date().toISOString()).run());
      }
      const remaining = await step.do('remaining', count);
      if (remaining) {
        const instance = await step.do('continue-delivery', nextInstance);
        handoff = true;
        return { continued: instance.id, remaining };
      }
      await step.do('finish', () => env.DB.batch([
        env.DB.prepare(`INSERT INTO meta(key,value) VALUES ('covered_until',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(state.end),
        env.DB.prepare('DELETE FROM pending WHERE run_id=?').bind(runId),
        env.DB.prepare('DELETE FROM scan_runs WHERE id=?').bind(runId),
        env.DB.prepare('DELETE FROM scan_preferences WHERE run_id=?').bind(runId),
      ]));
      return { bounds: { start: state.start, end: state.end }, delivered: true };
    } finally {
      if (!handoff) await step.do('release-lock', () => env.DB.prepare("DELETE FROM locks WHERE name='scan' AND owner=?").bind(runId).run());
    }
  }
}
export default {
  async scheduled(controller, env, ctx) {
    const kind = { '0 6 * * *': 'morning', '0 11 * * *': 'midday', '0 19 * * *': 'evening' }[controller.cron];
    if (!kind) throw Error(`Unexpected Cron Trigger: ${controller.cron}`);
    ctx.waitUntil(env.SCAN.create({ params: { kind, requestedAt: controller.scheduledTime } }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
    if (url.pathname !== '/telegram' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
    const update = await request.json();
    if (String(update.callback_query?.message?.chat?.id) === env.TELEGRAM_CHAT_ID) {
      const callback = update.callback_query;
      const data = callback.data || '';
      if (data === 'check_updates') {
        const instance = await env.SCAN.create({ params: { kind: 'check', requestedAt: Date.now() } });
        await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Проверяю новые квартиры…' });
        return Response.json({ ok: true, id: instance.id });
      }
      if (data.startsWith('prefs:')) {
        let screen = 'home';
        const action = data.slice(6);
        const selected = await readPreferences(env);
        if (/^station:\d+$/.test(action)) {
          const index = Number(action.split(':')[1]);
          screen = `stations:${STATIONS[index]?.[1] || 1}`;
          if (STATIONS[index]) await savePreferences(env, toggleStation(selected, index));
        } else if (/^stations:[123]$/.test(action)) screen = action;
        else if (/^option:(near|[123])$/.test(action)) {
          screen = 'onliner';
          await savePreferences(env, toggleOnliner(selected, action.split(':')[1]));
        } else if (action === 'onliner') screen = 'onliner';
        else if (action === 'reset:stations' || action === 'reset:onliner') {
          const target = action.split(':')[1];
          await savePreferences(env, { ...selected, [target]: [] });
          screen = target === 'stations' ? 'stations:1' : 'onliner';
        } else if (action === 'close') {
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id });
          await telegram(env, 'editMessageText', { chat_id: env.TELEGRAM_CHAT_ID,
            message_id: callback.message.message_id, text: 'Настройки метро сохранены.' });
          return Response.json({ ok: true });
        }
        await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id });
        await showMenu(env, screen, callback.message.message_id);
        return Response.json({ ok: true });
      }
    }
    if (String(update.message?.chat?.id) !== env.TELEGRAM_CHAT_ID) return Response.json({ ok: true });
    if (update.message?.text?.startsWith('/start')) {
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: 'Внизу чата доступны проверка квартир и настройка метро.',
        reply_markup: keyboard });
      await showMenu(env, 'home');
    } else if (update.message?.text === BUTTON) {
      const instance = await env.SCAN.create({ params: { kind: 'check', requestedAt: Date.now() } });
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: 'Проверяю новые квартиры…', reply_markup: keyboard });
      return Response.json({ ok: true, id: instance.id });
    } else if (update.message?.text === SETTINGS_BUTTON || update.message?.text === '/settings') {
      await showMenu(env, 'home');
    }
    return Response.json({ ok: true });
  },
};
