import { WorkflowEntrypoint } from 'cloudflare:workers';
import { BUTTON, interval, label, matches, onliner, realt, kufar, caption, dueScan } from './logic.mjs';
import { LINES, STATIONS, FREQUENCIES, preferences, toggleStation, toggleOnliner } from './metro.mjs';
import { DISTRICTS, CITY_DISTRICTS } from './districts.mjs';
import { CITIES } from './geography.mjs';
import { OBLASTS, rayons, cities, cityName, isMinskSelected } from './location.mjs';

const AGENT = 'ApartmentMonitor/1.0 (personal rental alerts)';
const SETTINGS_BUTTON = '⚙️ Настройки поиска';
const OLD_SETTINGS_BUTTON = '⚙️ Настроить метро';
const HELP_BUTTON = 'ℹ️ Как пользоваться';
const CURRENT_BUTTON = '📋 Текущие настройки';
const FREQUENCY_LABELS = { scheduled: '09:00, 14:00, 22:00', '10m': 'каждые 10 минут',
  '30m': 'каждые 30 минут', '1h': 'каждый час', '4h': 'каждые 4 часа', '8h': 'каждые 8 часов' };
const keyboard = { keyboard: [[{ text: BUTTON }], [{ text: SETTINGS_BUTTON }, { text: CURRENT_BUTTON }], [{ text: HELP_BUTTON }]],
  resize_keyboard: true, is_persistent: true };

async function readActive(env) {
  const row = await env.DB.prepare('SELECT settings FROM search_preferences WHERE chat_id=?')
    .bind(env.TELEGRAM_CHAT_ID).first();
  return row ? preferences(JSON.parse(row.settings)) : null;
}

async function readDraft(env) {
  let row = await env.DB.prepare('SELECT settings,awaiting FROM search_drafts WHERE chat_id=?')
    .bind(env.TELEGRAM_CHAT_ID).first();
  if (!row) {
    const selected = (await readActive(env)) || preferences(null);
    await env.DB.prepare('INSERT OR IGNORE INTO search_drafts(chat_id,settings,awaiting) VALUES (?,?,NULL)')
      .bind(env.TELEGRAM_CHAT_ID, JSON.stringify(selected)).run();
    row = { settings: JSON.stringify(selected), awaiting: null };
  }
  return { selected: preferences(JSON.parse(row.settings)), awaiting: row.awaiting };
}

async function saveDraft(env, selected, awaiting = null) {
  await env.DB.prepare(`INSERT INTO search_drafts(chat_id,settings,awaiting) VALUES (?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET settings=excluded.settings, awaiting=excluded.awaiting`)
    .bind(env.TELEGRAM_CHAT_ID, JSON.stringify(preferences(selected)), awaiting).run();
}

function menu(screen, selected) {
  const pick = (label, data) => ({ text: label, callback_data: `prefs:${data}` });
  if (screen === 'locations') return {
    text: '📍 Местоположение · шаг 1\nСначала выберите область, затем район области и город. ' +
      'Можно отметить несколько городов в разных районах и областях. Выбранные города ищутся целиком; ' +
      'районы города задаются отдельно, если доступны. Отметки сохранятся после «Применить».',
    inline_keyboard: [
      ...OBLASTS.map((name, index) => [pick(`${name} область`, `oblast:${index}`)]),
      [pick('⬅️ Настройки', 'home')],
    ],
  };
  if (/^oblast:\d$/.test(screen)) {
    const index = Number(screen.split(':')[1]);
    const names = rayons(OBLASTS[index]);
    return {
      text: `📍 ${OBLASTS[index]} область\nВыберите район области. Областные центры и города, 'район которых отсутствует в открытом справочнике, находятся в группе «Города без района в справочнике».`,
      inline_keyboard: [
        ...names.map((name, i) => [pick(name, `rayon:${index}:${i}`)]),
        [pick('⬅️ Области', 'locations')],
      ],
    };
  }
  if (/^rayon:\d:\d+(?::\d+)?$/.test(screen)) {
    const [, oblastIndex, rayonIndex, pageText] = screen.split(':');
    const names = rayons(OBLASTS[Number(oblastIndex)]);
    const rayon = names[Number(rayonIndex)];
    const entries = cities(OBLASTS[Number(oblastIndex)], rayon);
    const pages = Math.max(1, Math.ceil(entries.length / 8));
    const page = Math.min(Number(pageText || 0), pages - 1);
    return {
      text: `📍 ${OBLASTS[Number(oblastIndex)]} область · ${rayon}\nОтметьте нужные города. Весь выбранный город включён в поиск. Страница ${page + 1}/${pages}.`,
      inline_keyboard: [
        ...entries.slice(page * 8, (page + 1) * 8).map(({ row, index }) =>
          [pick(`${selected.cities.includes(index) ? '☑️' : '☐'} ${row[0]}`,
            `city:${index}:${oblastIndex}:${rayonIndex}:${page}`)]),
        [
          ...(page ? [pick('◀️', `rayon:${oblastIndex}:${rayonIndex}:${page - 1}`)] : []),
          ...(page + 1 < pages ? [pick('▶️', `rayon:${oblastIndex}:${rayonIndex}:${page + 1}`)] : []),
        ].filter(Boolean),
        [pick('⬅️ Районы области', `oblast:${oblastIndex}`), pick('⚙️ Настройки', 'home')],
      ].filter(row => row.length),
    };
  }
  if (screen === 'help') return {
    text: 'ℹ️ Как пользоваться\n\n' +
      '1. Выберите область → район области → город. Можно отметить несколько городов, каждый выбранный город ищется целиком.\n' +
      '2. Для Минска доступны районы, метро и радиус; для Бреста — районы города. Пустой список районов не добавляет фильтр. Метро и радиус действуют только на объявления Минска.\n' +
      '3. При желании задайте максимальную цену в BYN. Число 0 убирает ограничение.\n' +
      '4. Выберите частоту и нажмите «Применить». Кнопка «Текущие настройки» покажет сохранённые параметры; в меню редактирования показан черновик.\n\n' +
      '📏 Радиус: для Realt и Kufar — от выбранных станций; достаточно одной. Для Onliner — от ближайшей к квартире станции, если она на выбранной линии. Если метро не выбрано, радиус считается от площади Якуба Коласа. Без радиуса расстояние не ограничено. Исключение: «Возле метро» в Onliner означает до 1 км, если свой радиус не указан.\n\n' +
      'Уже присланные объявления повторно не отправляются.',
    inline_keyboard: [[pick('⚙️ К настройкам', 'home')]],
  };
  if (screen === 'districts') return {
    text: '🗺 Районы Минска\nВыберите один или несколько районов. Без выбора фильтр по району не применяется. Если также выбрано метро, квартира должна соответствовать обоим условиям.',
    inline_keyboard: [
      ...DISTRICTS.map((name, index) => [pick(`${selected.districts.includes(name) ? '☑️' : '☐'} ${name}`, `district:${index}`)]),
      [pick('Сбросить районы', 'reset:districts'), pick('⬅️ Настройки', 'home')],
    ],
  };
  if (screen === 'city-districts:Brest') return {
    text: '🗺 Районы Бреста\nОтметьте нужные районы города. Если ничего не отмечено, фильтр по районам Бреста не применяется.',
    inline_keyboard: [
      ...CITY_DISTRICTS.Брест.map((name, index) =>
        [pick(`${selected.cityDistricts.Брест.includes(name) ? '☑️' : '☐'} ${name}`,
          `city-district:Brest:${index}`)]),
      [pick('Сбросить районы', 'reset:city-districts:Brest'), pick('⬅️ Настройки', 'home')],
    ],
  };
  if (screen === 'frequency') return {
    text: '⏱ Частота проверки\nВремя — минское. Каждый запуск проверяет объявления с момента предыдущей успешной проверки. Каждые 10 минут могут быстро исчерпать бесплатный лимит Cloudflare и вызвать ограничения сайтов.',
    inline_keyboard: [
      ...FREQUENCIES.map(id => [pick(`${selected.frequency === id ? '🔘' : '⚪️'} ${FREQUENCY_LABELS[id]}`, `frequency:${id}`)]),
      [pick('⬅️ Настройки', 'home')],
    ],
  };
  if (screen.startsWith('stations:')) {
    const line = Number(screen.split(':')[1]);
    const title = LINES.find(x => x.id === line)?.name || LINES[0].name;
    const index = LINES.some(x => x.id === line) ? line : 1;
    const stationButtons = STATIONS.flatMap((station, i) => station[1] === index
      ? [pick(`${selected.stations.includes(i) ? '☑️' : '☐'} ${station[0]}`, `station:${i}`)] : []);
    return {
      text: `🚇 Realt и Kufar · ${title}\nОтметьте станции. Если ни одна не выбрана, метро не ограничивает поиск.`,
      inline_keyboard: [
        LINES.map(x => pick(`${index === x.id ? '• ' : ''}${x.id}-я линия`, `stations:${x.id}`)),
        ...stationButtons.map(button => [button]),
        [pick('Сбросить станции', 'reset:stations'), pick('⬅️ Настройки', 'home')],
      ],
    };
  }
  if (screen === 'onliner') {
    const options = [['near', 'Возле метро'], ...LINES.map(x => [String(x.id), x.name])];
    return {
      text: '🚇 Onliner\nВыберите линии или «возле метро». Линия определяется по ближайшей станции. ' +
        '«Возле метро» означает до 1 км, если вы не задали свой радиус. Без выбора метро не ограничивает поиск.',
      inline_keyboard: [
        ...options.map(([id, name]) => [pick(`${selected.onliner.includes(id) ? '☑️' : '☐'} ${name}`, `option:${id}`)]),
        [pick('Сбросить Onliner', 'reset:onliner'), pick('⬅️ Настройки', 'home')],
      ],
    };
  }
  const stationNames = selected.stations.map(i => STATIONS[i]?.[0]).filter(Boolean);
  const onlinerNames = selected.onliner.map(id => id === 'near' ? 'возле метро' : LINES.find(x => String(x.id) === id)?.name).filter(Boolean);
  const minsk = isMinskSelected(selected);
  return {
    text: '⚙️ Настройки поиска · черновик\n' +
      `Города: ${selected.cities.map(cityName).join(', ') || 'не выбраны'}\n` +
      (selected.cities.some(i => cityName(i) === 'Брест') ?
        `Районы Бреста: ${selected.cityDistricts.Брест.join(', ') || 'фильтр не задан'}\n` : '') +
      (minsk ? `Realt + Kufar, метро: ${stationNames.join(', ') || 'фильтр не задан'}\n` +
        `Onliner, метро: ${onlinerNames.join(', ') || 'фильтр не задан'}\n` +
        `Районы Минска: ${selected.districts.join(', ') || 'фильтр не задан'}\n` : '') +
      `Цена: ${selected.maxByn ? `до ${selected.maxByn} BYN` : 'без ограничения'}\n` +
      (minsk ? `Радиус: ${selected.radiusKm ? `${selected.radiusKm} км` : 'не задан'}\n` : '') +
      `Проверка: ${FREQUENCY_LABELS[selected.frequency]}\n\n` +
      'Сохраните изменения кнопкой «Применить». Уже отправленные объявления не повторяются.',
    inline_keyboard: [
      [pick('📍 Область → район → город', 'locations')],
      ...(selected.cities.some(i => cityName(i) === 'Брест') ?
        [[pick('🗺 Районы Бреста', 'city-districts:Brest')]] : []),
      ...(minsk ? [[pick('🚇 Станции Realt + Kufar', 'stations:1')],
        [pick('🚇 Линии Onliner', 'onliner')], [pick('🗺 Районы Минска', 'districts')]] : []),
      [pick('💰 Цена, BYN', 'input:price'), ...(minsk ? [pick('📏 Радиус, км', 'input:radius')] : [])],
      [pick('⏱ Частота проверки', 'frequency')],
      [pick(HELP_BUTTON, 'help')],
      [pick('✅ Применить', 'apply'), pick('Отмена', 'cancel')],
    ],
  };
}

function settingsSummary(selected) {
  if (!selected) return '📋 Текущие настройки\nПоиск ещё не настроен.';
  const stationNames = selected.stations.map(i => STATIONS[i]?.[0]).filter(Boolean);
  const onlinerNames = selected.onliner.map(id => id === 'near' ? 'возле метро' :
    LINES.find(x => String(x.id) === id)?.name).filter(Boolean);
  const minsk = isMinskSelected(selected);
  return '📋 Текущие настройки поиска\n' +
    `Города: ${selected.cities.map(cityName).join(', ')}\n` +
    (selected.cities.some(i => cityName(i) === 'Брест') ?
      `Районы Бреста: ${selected.cityDistricts.Брест.join(', ') || 'фильтр не задан'}\n` : '') +
    (minsk ? `Realt + Kufar, метро: ${stationNames.join(', ') || 'фильтр не задан'}\n` +
      `Onliner, метро: ${onlinerNames.join(', ') || 'фильтр не задан'}\n` +
      `Районы Минска: ${selected.districts.join(', ') || 'фильтр не задан'}\n` : '') +
    `Цена: ${selected.maxByn ? `до ${selected.maxByn} BYN` : 'без ограничения'}\n` +
    (minsk ? `Радиус: ${selected.radiusKm ? `${selected.radiusKm} км` : 'не задан'}\n` : '') +
    `Частота: ${FREQUENCY_LABELS[selected.frequency]}`;
}

async function showMenu(env, screen, messageId) {
  const { selected } = await readDraft(env);
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
        const selected = await step.do('read-settings', () => readActive(env));
        if (!selected) return { skipped: true, reason: 'search_not_configured' };
        const cursor = await step.do('read-cursor', async () =>
          (await env.DB.prepare("SELECT value FROM meta WHERE key='covered_until'").first())?.value || null);
        const bounds = interval(kind, event.payload?.requestedAt || event.schedule?.scheduledTime || Date.now(), cursor);
        if (bounds.start >= bounds.end) return { skipped: true, bounds };
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
          const params = new URLSearchParams({ cat: '1010', typ: 'let', size: '100', sort: 'lst.d', lang: 'ru' });
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
        await step.sleep(`pace-${item.key}`, '2 seconds');
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
    if (controller.cron !== '*/10 * * * *') throw Error(`Unexpected Cron Trigger: ${controller.cron}`);
    ctx.waitUntil((async () => {
      const selected = await readActive(env);
      if (!selected) return;
      const kind = dueScan(selected.frequency, controller.scheduledTime);
      if (!kind) return;
      const lock = await env.DB.prepare("SELECT expires FROM locks WHERE name='scan'").first();
      if (lock && lock.expires > Date.now()) return;
      await env.SCAN.create({ params: { kind, requestedAt: controller.scheduledTime } });
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
    if (url.pathname !== '/telegram' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
    try {
    const update = await request.json();
    if (String(update.callback_query?.message?.chat?.id) === env.TELEGRAM_CHAT_ID) {
      const callback = update.callback_query;
      const data = callback.data || '';
      if (data === 'check_updates') {
        if (!(await readActive(env))) {
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id,
            text: 'Сначала сохраните настройки поиска.', show_alert: true });
          return Response.json({ ok: true });
        }
        const instance = await env.SCAN.create({ params: { kind: 'check', requestedAt: Date.now() } });
        await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Проверяю новые квартиры…' });
        return Response.json({ ok: true, id: instance.id });
      }
      if (data.startsWith('prefs:')) {
        let screen = 'home';
        const action = data.slice(6);
        const { selected, awaiting } = await readDraft(env);
        if (action === 'locations' || /^oblast:\d$/.test(action) ||
          /^rayon:\d:\d+(?::\d+)?$/.test(action)) screen = action;
        else if (/^city:\d+:\d:\d+:\d+$/.test(action)) {
          const [, cityIndex, oblastIndex, rayonIndex, page] = action.split(':').map(Number);
          screen = `rayon:${oblastIndex}:${rayonIndex}:${page}`;
          if (CITIES[cityIndex]) await saveDraft(env, { ...selected,
            cities: selected.cities.includes(cityIndex) ? selected.cities.filter(x => x !== cityIndex) :
              [...selected.cities, cityIndex] });
        } else if (action === 'city-districts:Brest') screen = action;
        else if (/^city-district:Brest:[01]$/.test(action)) {
          screen = 'city-districts:Brest';
          const name = CITY_DISTRICTS.Брест[Number(action.split(':')[2])];
          const old = selected.cityDistricts.Брест;
          await saveDraft(env, { ...selected, cityDistricts: { ...selected.cityDistricts,
            Брест: old.includes(name) ? old.filter(x => x !== name) : [...old, name] } });
        } else if (action === 'reset:city-districts:Brest') {
          screen = 'city-districts:Brest';
          await saveDraft(env, { ...selected, cityDistricts: { ...selected.cityDistricts, Брест: [] } });
        } else if (/^station:\d+$/.test(action)) {
          const index = Number(action.split(':')[1]);
          screen = `stations:${STATIONS[index]?.[1] || 1}`;
          if (STATIONS[index]) await saveDraft(env, toggleStation(selected, index));
        } else if (/^stations:[123]$/.test(action)) screen = action;
        else if (/^option:(near|[123])$/.test(action)) {
          screen = 'onliner';
          await saveDraft(env, toggleOnliner(selected, action.split(':')[1]));
        } else if (action === 'onliner') screen = 'onliner';
        else if (action === 'districts' || action === 'frequency') screen = action;
        else if (/^district:\d+$/.test(action)) {
          screen = 'districts';
          const name = DISTRICTS[Number(action.split(':')[1])];
          if (name) await saveDraft(env, { ...selected, districts: selected.districts.includes(name)
            ? selected.districts.filter(x => x !== name) : [...selected.districts, name] });
        } else if (/^frequency:(scheduled|10m|30m|1h|4h|8h)$/.test(action)) {
          screen = 'frequency';
          await saveDraft(env, { ...selected, frequency: action.slice(10) });
        }
        else if (action === 'help') screen = 'help';
        else if (['reset:stations', 'reset:onliner', 'reset:districts'].includes(action)) {
          const target = action.split(':')[1];
          await saveDraft(env, { ...selected, [target]: [] });
          screen = target === 'stations' ? 'stations:1' : target;
        } else if (action === 'input:price' || action === 'input:radius') {
          const field = action.split(':')[1];
          await saveDraft(env, selected, field);
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id });
          await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
            text: field === 'price' ? 'Введите максимальную цену в BYN. Отправьте 0, чтобы убрать лимит.' :
              'Введите радиус в километрах. Отправьте 0, чтобы убрать ограничение по радиусу.',
            reply_markup: { force_reply: true, input_field_placeholder: field === 'price' ? 'Например, 1500' : 'Например, 2,5' } });
          return Response.json({ ok: true });
        } else if (action === 'apply') {
          if (awaiting) {
            await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id,
              text: 'Сначала отправьте число или 0 для сброса.' });
            return Response.json({ ok: true });
          }
          if (!selected.cities.length) {
            await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id,
              text: 'Выберите хотя бы один город.', show_alert: true });
            return Response.json({ ok: true });
          }
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO search_preferences(chat_id,settings) VALUES (?,?)
              ON CONFLICT(chat_id) DO UPDATE SET settings=excluded.settings`)
              .bind(env.TELEGRAM_CHAT_ID, JSON.stringify(selected)),
            env.DB.prepare('DELETE FROM search_drafts WHERE chat_id=?').bind(env.TELEGRAM_CHAT_ID),
          ]);
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Настройки применены' });
          await telegram(env, 'editMessageText', { chat_id: env.TELEGRAM_CHAT_ID,
            message_id: callback.message.message_id, text: '✅ Настройки применены. Следующая проверка использует сохранённый выбор.' });
          await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
            text: 'Можете проверить новые объявления сейчас или изменить настройки позже.', reply_markup: keyboard });
          return Response.json({ ok: true });
        } else if (action === 'cancel') {
          await env.DB.prepare('DELETE FROM search_drafts WHERE chat_id=?').bind(env.TELEGRAM_CHAT_ID).run();
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id });
          await telegram(env, 'editMessageText', { chat_id: env.TELEGRAM_CHAT_ID,
            message_id: callback.message.message_id, text: 'Изменения отменены.' });
          return Response.json({ ok: true });
        }
        await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id });
        await showMenu(env, screen, callback.message.message_id);
        return Response.json({ ok: true });
      }
    }
    if (String(update.message?.chat?.id) !== env.TELEGRAM_CHAT_ID) return Response.json({ ok: true });
    const draft = await env.DB.prepare('SELECT settings,awaiting FROM search_drafts WHERE chat_id=?')
      .bind(env.TELEGRAM_CHAT_ID).first();
    if (update.message?.text === HELP_BUTTON || update.message?.text === '/help') {
      await showMenu(env, 'help');
      return Response.json({ ok: true });
    }
    if (update.message?.text === CURRENT_BUTTON || update.message?.text === '/current') {
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: settingsSummary(await readActive(env)), reply_markup: keyboard });
      return Response.json({ ok: true });
    }
    if (draft?.awaiting && ([SETTINGS_BUTTON, OLD_SETTINGS_BUTTON, '/cancel', '/start'].includes(update.message?.text))) {
      await saveDraft(env, preferences(JSON.parse(draft.settings)));
      await showMenu(env, 'home');
      return Response.json({ ok: true });
    }
    if (draft?.awaiting && !update.message?.text?.startsWith('/')) {
      const input = update.message?.text?.trim().replace(',', '.');
      const limit = draft.awaiting === 'price' ? 100000 : 50;
      const numeric = /^\d+(?:\.\d{1,2})?$/.test(input || '') ? Number(input) : NaN;
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > limit) {
        await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
          text: `Введите число от 0 до ${limit}. Ноль убирает ограничение.`,
          reply_markup: { force_reply: true } });
        return Response.json({ ok: true });
      }
      const selected = preferences(JSON.parse(draft.settings));
      selected[draft.awaiting === 'price' ? 'maxByn' : 'radiusKm'] = numeric || null;
      await saveDraft(env, selected);
      await showMenu(env, 'home');
      return Response.json({ ok: true });
    }
    if (update.message?.text?.startsWith('/start')) {
      const active = await readActive(env);
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: active ? 'Внизу чата доступны проверка квартир и настройка поиска.' :
          'Задайте параметры поиска и нажмите «Применить». После этого заработают проверки по кнопке и расписанию.',
        reply_markup: keyboard });
      await showMenu(env, 'home');
    } else if (update.message?.text === BUTTON) {
      if (!(await readActive(env))) {
        await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
          text: 'Сначала настройте поиск и нажмите «Применить».', reply_markup: keyboard });
        await showMenu(env, 'home');
        return Response.json({ ok: true });
      }
      const instance = await env.SCAN.create({ params: { kind: 'check', requestedAt: Date.now() } });
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: 'Проверяю новые квартиры…', reply_markup: keyboard });
      return Response.json({ ok: true, id: instance.id });
    } else if ([SETTINGS_BUTTON, OLD_SETTINGS_BUTTON, '/settings'].includes(update.message?.text)) {
      await showMenu(env, 'home');
    }
    return Response.json({ ok: true });
    } catch (error) {
      console.error('Telegram webhook failed', error);
      return Response.json({ ok: false, error: String(error) }, { status: 500 });
    }
  },
};
