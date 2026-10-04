import { miniApi } from './mini-app.mjs';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { telegram } from './telegram-api.mjs';
import { access, scope, scanLock, cursorKey, schedulePaused, setSchedulePaused } from './access.mjs';
import { sourceFailure, scanHeading } from './scan-errors.mjs';
import { BUTTON, interval, label, matches, onliner, realt, kufar, caption, dueScan } from './logic.mjs';
import { STATIONS, preferences, toggleStation, toggleOnliner } from './metro.mjs';
import { DISTRICTS, CITY_DISTRICTS } from './districts.mjs';
import { CITIES } from './geography.mjs';
import { OBLASTS, rayons, isMinskSelected } from './location.mjs';
import { SETTINGS_BUTTON, OLD_SETTINGS_BUTTON, CHECK_BUTTON, HELP_BUTTON, CURRENT_BUTTON, PAUSE_BUTTON, RESUME_BUTTON, keyboardFor, menu, settingsSummary } from './telegram-menu.mjs';

const AGENT = 'ApartmentMonitor/1.0 (personal rental alerts)';
const chatKeyboard = async env => keyboardFor(await schedulePaused(env));

async function readActive(env) {
  const row = await env.DB.prepare('SELECT settings FROM search_preferences WHERE chat_id=?')
    .bind(env.TELEGRAM_CHAT_ID).first();
  return row ? preferences(JSON.parse(row.settings)) : null;
}

async function readDraft(env) {
  let row = await env.DB.prepare('SELECT settings,awaiting FROM search_drafts WHERE chat_id=?')
    .bind(env.TELEGRAM_CHAT_ID).first();
  if (!row) {
    const selected = (await readActive(env)) || preferences({ cities: [] });
    if (!selected.locationChosen) {
      selected.cities = [];
      selected.browseOblast = null;
      selected.browseRayon = null;
    }
    await env.DB.prepare('INSERT OR IGNORE INTO search_drafts(chat_id,settings,awaiting) VALUES (?,?,NULL)')
      .bind(env.TELEGRAM_CHAT_ID, JSON.stringify(selected)).run();
    row = { settings: JSON.stringify(selected), awaiting: null };
  }
  const selected = preferences(JSON.parse(row.settings));
  if (!selected.locationChosen) selected.cities = [];
  return { selected, awaiting: row.awaiting === 'radius' ? null : row.awaiting };
}

async function saveDraft(env, selected, awaiting = null) {
  await env.DB.prepare(`INSERT INTO search_drafts(chat_id,settings,awaiting) VALUES (?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET settings=excluded.settings, awaiting=excluded.awaiting`)
    .bind(env.TELEGRAM_CHAT_ID, JSON.stringify(preferences(selected)), awaiting).run();
}

async function showMenu(env, screen, messageId) {
  if (screen === 'home' && env.MINI_APP_URL) {
    return telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
      text: 'Настройте поиск в приложении: города, цену, метро и частоту проверки. Настройки сохраняются только для вас.',
      reply_markup: { inline_keyboard: [[{ text: '🏠 Открыть настройки', web_app: { url: env.MINI_APP_URL } }]] } });
  }
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
  const result = await env.DB.prepare(`INSERT INTO locks (name, owner, expires) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires=excluded.expires
    WHERE locks.expires < ?`).bind(scanLock(env.TELEGRAM_CHAT_ID), owner, now + 30 * 60 * 1000, now).run();
  return result.meta.changes > 0;
}

export class ApartmentScan extends WorkflowEntrypoint {
  async run(event, step) {
    const runId = event.payload?.runId || event.instanceId;
    const chatId = event.payload?.chatId || (event.payload?.runId ?
      (await this.env.DB.prepare('SELECT chat_id FROM scan_recipients WHERE run_id=?').bind(runId).first())?.chat_id : null) || this.env.TELEGRAM_CHAT_ID;
    const env = scope(this.env, chatId);
    let handoff = false, stopped = false;
    const modeKey = `automatic_scan:${runId}`;
    const initialKind = event.payload?.kind || ({ '0 6 * * *': 'morning', '0 11 * * *': 'midday', '0 19 * * *': 'evening' }[event.schedule?.cron]);
    const automatic = event.payload?.runId ?
      (await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(modeKey).first())?.value !== '0' : event.payload?.automatic === true || initialKind !== 'check';
    const shouldStop = async () => {
      stopped = automatic && (await schedulePaused(env) || (await readActive(env))?.frequency === 'manual');
      return stopped;
    };
    const nextInstance = async () => ({ id: (await env.SCAN.create({ params: { runId, chatId } })).id });
    try {
      if (await shouldStop()) return { paused: true };
      if (!event.payload?.runId) {
        const kind = event.payload?.kind || ({ '0 6 * * *': 'morning', '0 11 * * *': 'midday', '0 19 * * *': 'evening' }[event.schedule?.cron]);
        if (!kind) throw Error('Unknown scan type');
        await step.do('save-scan-mode', () => env.DB.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').bind(modeKey, automatic ? '1' : '0').run());
        let locked = false;
        for (let attempt = 0; attempt < 90; attempt++) {
          if (await shouldStop()) return { paused: true };
          locked = await step.do(`acquire-${attempt}`, () => acquire(env, runId));
          if (locked) break;
          await step.sleep(`wait-${attempt}`, '20 seconds');
        }
        if (!locked) throw Error('Scan lock held too long');
        const selected = await step.do('read-settings', () => readActive(env));
        if (!selected) return { skipped: true, reason: 'search_not_configured' };
        const cursor = await step.do('read-cursor', async () =>
          (await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind(cursorKey(chatId)).first())?.value || null);
        const bounds = interval(kind, event.payload?.requestedAt || event.schedule?.scheduledTime || Date.now(), cursor);
        if (bounds.start >= bounds.end) return { skipped: true, bounds };
        await step.do('init-run', () => env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO scan_runs
            (id,start,end,stage,page,cursor,header_sent) VALUES (?,?,?,'onliner',1,NULL,0)`)
            .bind(runId, bounds.start, bounds.end),
          env.DB.prepare('INSERT OR IGNORE INTO scan_preferences(run_id,settings) VALUES (?,?)')
            .bind(runId, JSON.stringify(selected)),
          env.DB.prepare('INSERT OR IGNORE INTO scan_recipients(run_id,chat_id) VALUES (?,?)').bind(runId, chatId),
        ]));
      } else {
        const renewed = await step.do('renew-lock', async () => env.DB.prepare(
          "UPDATE locks SET expires=? WHERE name=? AND owner=?")
          .bind(Date.now() + 30 * 60 * 1000, scanLock(chatId), runId).run());
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
        if (await shouldStop()) return { paused: true };
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
        let batch;
        try {
          batch = await step.do(`fetch-${source}-${page}`, { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 seconds' }, () => fetchPage(url, parser));
        } catch (error) {
          const reason = sourceFailure(error);
          console.warn('Apartment source unavailable', source, reason);
          const next = ({ onliner: 'realt', realt: 'kufar', kufar: 'send' })[source];
          await step.do(`skip-unavailable-${source}-${page}`, () => env.DB.batch([
            env.DB.prepare('INSERT OR REPLACE INTO scan_errors(run_id,source,reason) VALUES (?,?,?)').bind(runId, source, reason),
            env.DB.prepare('UPDATE scan_runs SET stage=?,page=1,cursor=NULL WHERE id=?').bind(next, runId),
          ]));
          state = { ...state, stage: next, page: 1, cursor: null };
          fetched++;
          continue;
        }
        const candidates = batch.items.filter(x => matches(x, state.start, state.end, selected));
        const older = batch.items.some(x => Date.parse(x.publishedAt) < cutoff);
        let done;
        if (source === 'onliner') done = !batch.items.length || page >= batch.lastPage || older;
        else if (source === 'realt') done = !batch.items.length || page + 1 > Math.ceil(batch.total / 30) - 2;
        else done = !batch.items.length || batch.items.every(x => Date.parse(x.publishedAt) < cutoff) || !batch.next;
        if (!done && ((source === 'onliner' && page >= 30) || page >= 100)) {
          await step.do(`page-limit-${source}`, () => env.DB.prepare(
            'INSERT OR REPLACE INTO scan_errors(run_id,source,reason) VALUES (?,?,?)')
            .bind(runId, source, sourceFailure('page limit')).run());
          done = true;
        }
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
      if (await shouldStop()) return { paused: true };
      if (state.stage !== 'send') {
        const instance = await step.do('continue-pages', nextInstance);
        handoff = true;
        return { continued: instance.id, source: state.stage, page: state.page };
      }
      const count = async () => (await env.DB.prepare(`SELECT count(*) AS n FROM pending p
        LEFT JOIN user_sent s ON s.key=p.key AND s.chat_id=? WHERE p.run_id=? AND s.key IS NULL`).bind(chatId, runId).first()).n;
      const failures = await step.do('load-source-errors', async () =>
        (await env.DB.prepare('SELECT source,reason FROM scan_errors WHERE run_id=? ORDER BY source').bind(runId).all()).results);
      if (!state.header_sent) {
        const total = await step.do('count-pending', count);
        const heading = scanHeading(label(state.start, state.end), total, failures);
        const headerSent = await step.do('send-header', async () => {
          if (await shouldStop()) return false;
          await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: heading, reply_markup: await chatKeyboard(env) });
          await env.DB.prepare('UPDATE scan_runs SET header_sent=1 WHERE id=?').bind(runId).run();
          return true;
        });
        if (!headerSent) return { paused: true };
      }
      const batch = await step.do('pending-batch', async () => (await env.DB.prepare(`SELECT p.item FROM pending p
        LEFT JOIN user_sent s ON s.key=p.key AND s.chat_id=? WHERE p.run_id=? AND s.key IS NULL
        ORDER BY p.published_at,p.key LIMIT 12`).bind(chatId, runId).all()).results);
      for (const row of batch) {
        const item = JSON.parse(row.item);
        await step.sleep(`pace-${item.key}`, '2 seconds');
        const sent = await step.do(`send-${item.key}`, async () => {
          if (await shouldStop()) return false;
          await sendListing(env, item);
          return true;
        });
        if (!sent) return { paused: true };
        await step.do(`save-${item.key}`, () => env.DB.prepare('INSERT OR IGNORE INTO user_sent(chat_id,key,sent_at) VALUES (?,?,?)')
          .bind(chatId, item.key, new Date().toISOString()).run());
      }
      const remaining = await step.do('remaining', count);
      if (remaining) {
        const instance = await step.do('continue-delivery', nextInstance);
        handoff = true;
        return { continued: instance.id, remaining };
      }
      if (await shouldStop()) return { paused: true };
      await step.do('finish', () => env.DB.batch([
        ...(!failures.length ? [env.DB.prepare(`INSERT INTO meta(key,value) VALUES (?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(cursorKey(chatId), state.end)] :
          [env.DB.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').bind(cursorKey(chatId), state.start)]),
        env.DB.prepare('DELETE FROM pending WHERE run_id=?').bind(runId),
        env.DB.prepare('DELETE FROM scan_runs WHERE id=?').bind(runId),
        env.DB.prepare('DELETE FROM scan_preferences WHERE run_id=?').bind(runId),
        env.DB.prepare('DELETE FROM scan_recipients WHERE run_id=?').bind(runId),
        env.DB.prepare('DELETE FROM scan_errors WHERE run_id=?').bind(runId),
      ]));
      return { bounds: { start: state.start, end: state.end }, delivered: true, partial: failures.length > 0 };
    } finally {
      if (stopped) await step.do('discard-paused-run', () => env.DB.batch([
        ...['pending', 'scan_preferences', 'scan_recipients', 'scan_errors'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE run_id=?`).bind(runId)),
        env.DB.prepare('DELETE FROM scan_runs WHERE id=?').bind(runId),
      ]));
      if (!handoff) await step.do('clear-scan-mode', () => env.DB.prepare('DELETE FROM meta WHERE key=?').bind(modeKey).run());
      if (!handoff) await step.do('release-lock', () => env.DB.prepare("DELETE FROM locks WHERE name=? AND owner=?").bind(scanLock(chatId), runId).run());
    }
  }
}
export default {
  async scheduled(controller, env, ctx) {
    if (controller.cron !== '*/10 * * * *') throw Error(`Unexpected Cron Trigger: ${controller.cron}`);
    ctx.waitUntil((async () => {
      const users = (await env.DB.prepare(`SELECT p.chat_id,p.settings FROM search_preferences p
        JOIN bot_users u ON u.chat_id=p.chat_id WHERE u.authorized=1`).all()).results;
      for (const user of users) {
        if (await schedulePaused(env, user.chat_id)) continue;
        const selected = preferences(JSON.parse(user.settings));
        const kind = dueScan(selected.frequency, controller.scheduledTime);
        if (!kind) continue;
        const lock = await env.DB.prepare('SELECT expires FROM locks WHERE name=?').bind(scanLock(user.chat_id)).first();
        if (lock && lock.expires > Date.now()) continue;
        await env.SCAN.create({ params: { chatId: user.chat_id, automatic: true, kind, requestedAt: controller.scheduledTime } });
      }
    })());
  },
  async fetch(request, bindings) {
    let env = bindings;
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return miniApi(request, env);
    if (url.pathname.startsWith('/app')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true, multi_user: true, login_ready: Boolean(env.BOT_ACCESS_PASSWORD) });
    if (url.pathname !== '/telegram' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET?.trim()) return new Response('Forbidden', { status: 403 });
    try {
    const update = await request.json();
    const chat = update.callback_query?.message?.chat || update.message?.chat;
    const wasAuthorized = chat?.type === 'private' ?
      (await env.DB.prepare('SELECT authorized FROM bot_users WHERE chat_id=?').bind(String(chat.id)).first())?.authorized : false;
    if (!(await access(env, update))) return Response.json({ ok: true });
    env = scope(env, chat.id);
    if (!wasAuthorized) {
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: 'У каждого пользователя свои настройки и история объявлений.', reply_markup: await chatKeyboard(env) });
      await showMenu(env, 'home');
      return Response.json({ ok: true });
    }
    if (String(update.callback_query?.message?.chat?.id) === env.TELEGRAM_CHAT_ID) {
      const callback = update.callback_query;
      const data = callback.data || '';
      if (data === 'check_updates') {
        if (!(await readActive(env))) {
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id,
            text: 'Сначала сохраните настройки поиска.', show_alert: true });
          return Response.json({ ok: true });
        }
        const instance = await env.SCAN.create({ params: { chatId: env.TELEGRAM_CHAT_ID, kind: 'check', requestedAt: Date.now() } });
        await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, text: 'Проверяю новые квартиры…' });
        return Response.json({ ok: true, id: instance.id });
      }
      if (data.startsWith('prefs:')) {
        let screen = 'home';
        const action = data.slice(6);
        const { selected, awaiting } = await readDraft(env);
        if (/^(?:station:|stations:|option:|onliner$|district:|districts$|reset:(?:stations|onliner|districts)$)/.test(action) &&
          (!selected.locationChosen || !isMinskSelected(selected))) {
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id,
            text: 'Сначала выберите Минск в списке городов.' });
          await showMenu(env, 'home', callback.message.message_id);
          return Response.json({ ok: true });
        }
        if (action === 'locations') screen = action;
        else if (action === 'browse:rayon' || action === 'browse:city') {
          screen = selected.browseOblast === null ? 'locations' : `oblast:${selected.browseOblast}`;
          if (action === 'browse:city' && selected.browseRayon !== null)
            screen = `rayon:${selected.browseOblast}:${selected.browseRayon}:0`;
        } else if (/^oblast:\d$/.test(action)) {
          screen = action;
          const index = Number(action.split(':')[1]);
          if (OBLASTS[index]) await saveDraft(env, { ...selected, browseOblast: index, browseRayon: null, placeQuery: '' });
        } else if (/^rayon:\d:\d+(?::\d+)?$/.test(action)) {
          screen = action;
          const [, oblastIndex, rayonIndex] = action.split(':').map(Number);
          if (OBLASTS[oblastIndex] && rayons(OBLASTS[oblastIndex])[rayonIndex])
            await saveDraft(env, { ...selected, browseOblast: oblastIndex, browseRayon: rayonIndex,
              placeQuery: selected.browseOblast === oblastIndex && selected.browseRayon === rayonIndex ? selected.placeQuery : '' });
        } else if (/^capital:\d+:\d$/.test(action)) {
          const [, cityIndex, oblastIndex] = action.split(':').map(Number);
          if (CITIES[cityIndex]) await saveDraft(env, { ...selected, locationChosen: true,
            browseOblast: oblastIndex, browseRayon: null, placeQuery: '',
            cities: selected.cities.includes(cityIndex) ? selected.cities.filter(x => x !== cityIndex) : [...selected.cities, cityIndex] });
        }
        else if (/^city:\d+:\d:\d+:\d+$/.test(action)) {
          const [, cityIndex, oblastIndex, rayonIndex] = action.split(':').map(Number);
          if (CITIES[cityIndex]) await saveDraft(env, { ...selected, locationChosen: true,
            browseOblast: oblastIndex, browseRayon: rayonIndex,
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
        } else if (/^frequency:(manual|scheduled|10m|30m|1h|4h|8h)$/.test(action)) {
          screen = 'frequency';
          await saveDraft(env, { ...selected, frequency: action.slice(10) });
        }
        else if (action === 'help') screen = 'help';
        else if (['reset:stations', 'reset:onliner', 'reset:districts'].includes(action)) {
          const target = action.split(':')[1];
          await saveDraft(env, { ...selected, [target]: [] });
          screen = target === 'stations' ? 'stations:1' : target;
        } else if (/^clear-query:\d:\d+$/.test(action)) {
          const [, oblastIndex, rayonIndex] = action.split(':').map(Number);
          screen = `rayon:${oblastIndex}:${rayonIndex}:0`;
          await saveDraft(env, { ...selected, browseOblast: oblastIndex, browseRayon: rayonIndex, placeQuery: '' });
        } else if (/^input:place:\d:\d+$/.test(action)) {
          const [, , oblastIndex, rayonIndex] = action.split(':').map(Number);
          await saveDraft(env, { ...selected, browseOblast: oblastIndex, browseRayon: rayonIndex }, `place:${oblastIndex}:${rayonIndex}`);
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id });
          await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
            text: 'Введите название или часть названия населённого пункта.',
            reply_markup: { force_reply: true, input_field_placeholder: 'Например, Боровляны' } });
          return Response.json({ ok: true });
        } else if (action === 'input:price') {
          await saveDraft(env, selected, 'price');
          await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id });
          await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
            text: 'Введите максимальную цену в BYN. Отправьте 0, чтобы убрать лимит.',
            reply_markup: { force_reply: true, input_field_placeholder: 'Например, 1500' } });
          return Response.json({ ok: true });
        } else if (action === 'apply') {
          if (awaiting) {
            await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id,
              text: 'Сначала завершите ввод или откройте настройки, чтобы отменить ввод.' });
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
            text: 'Можете проверить новые объявления сейчас или изменить настройки позже.', reply_markup: await chatKeyboard(env) });
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
    if ([PAUSE_BUTTON, RESUME_BUTTON, '/pause', '/resume'].includes(update.message?.text)) {
      const paused = [PAUSE_BUTTON, '/pause'].includes(update.message.text);
      await setSchedulePaused(env, paused);
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: paused ? '⏸ Поиск по расписанию приостановлен. Настройки сохранены. Ручная проверка доступна кнопкой «Проверить». Чтобы вернуть расписание, нажмите «Продолжить».' :
          (await readActive(env))?.frequency === 'manual' ? 'Пауза снята. Выбран режим «Только по кнопке». Чтобы включить расписание, выберите частоту проверки в Mini App.' : '▶️ Поиск по расписанию включён. Использую ваши сохранённые настройки.',
        reply_markup: await chatKeyboard(env) });
      return Response.json({ ok: true });
    }
    if ([HELP_BUTTON, 'ℹ️ Как пользоваться', '/help'].includes(update.message?.text)) {
      await showMenu(env, 'help');
      return Response.json({ ok: true });
    }
    if ([CURRENT_BUTTON, '📋 Текущие настройки', '/current'].includes(update.message?.text)) {
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: settingsSummary(await readActive(env)) + ((await readActive(env))?.frequency === 'manual' ? '\n\nПроверка только по кнопке. Расписание отключено.' : await schedulePaused(env) ? '\n\n⏸ Поиск по расписанию на паузе.' : '\n\n▶️ Поиск по расписанию включён.'), reply_markup: await chatKeyboard(env) });
      return Response.json({ ok: true });
    }
    if (draft?.awaiting && ([SETTINGS_BUTTON, OLD_SETTINGS_BUTTON, '/cancel', '/start'].includes(update.message?.text))) {
      await saveDraft(env, preferences(JSON.parse(draft.settings)));
      await showMenu(env, 'home');
      return Response.json({ ok: true });
    }
    if (draft?.awaiting === 'radius') {
      await saveDraft(env, preferences(JSON.parse(draft.settings)));
      await showMenu(env, 'home');
      return Response.json({ ok: true });
    }
    if (draft?.awaiting?.startsWith('place:') && !update.message?.text?.startsWith('/')) {
      const query = update.message?.text?.trim();
      if (!query || query.length > 80) {
        await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
          text: 'Введите название длиной до 80 символов.', reply_markup: { force_reply: true } });
        return Response.json({ ok: true });
      }
      const [, oblastIndex, rayonIndex] = draft.awaiting.split(':').map(Number);
      await saveDraft(env, { ...preferences(JSON.parse(draft.settings)),
        browseOblast: oblastIndex, browseRayon: rayonIndex, placeQuery: query });
      await showMenu(env, `rayon:${oblastIndex}:${rayonIndex}:0`);
      return Response.json({ ok: true });
    }
    if (draft?.awaiting && !update.message?.text?.startsWith('/')) {
      const input = update.message?.text?.trim().replace(',', '.');
      const limit = 100000;
      const numeric = /^\d+(?:\.\d{1,2})?$/.test(input || '') ? Number(input) : NaN;
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > limit) {
        await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
          text: `Введите число от 0 до ${limit}. Ноль убирает ограничение.`,
          reply_markup: { force_reply: true } });
        return Response.json({ ok: true });
      }
      const selected = preferences(JSON.parse(draft.settings));
      selected.maxByn = numeric || null;
      await saveDraft(env, selected);
      await showMenu(env, 'home');
      return Response.json({ ok: true });
    }
    if (update.message?.text?.startsWith('/start')) {
      const active = await readActive(env);
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: active ? 'Внизу чата доступны проверка квартир и настройка поиска.' :
          'Задайте параметры поиска и нажмите «Сохранить настройки». После этого заработают проверки по кнопке и расписанию.',
        reply_markup: await chatKeyboard(env) });
      await showMenu(env, 'home');
    } else if ([BUTTON, CHECK_BUTTON].includes(update.message?.text)) {
      if (!(await readActive(env))) {
        await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
          text: 'Сначала настройте поиск и нажмите «Сохранить настройки».', reply_markup: await chatKeyboard(env) });
        await showMenu(env, 'home');
        return Response.json({ ok: true });
      }
      const instance = await env.SCAN.create({ params: { chatId: env.TELEGRAM_CHAT_ID, kind: 'check', requestedAt: Date.now() } });
      await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID,
        text: 'Проверяю новые квартиры…', reply_markup: await chatKeyboard(env) });
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
