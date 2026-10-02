const $ = id => document.getElementById(id);
const tg = window.Telegram?.WebApp;
let settings, catalog, saved, configured = false, busy = false;
const places = new Map();
let step = 'oblast', oblast, rayon, offset = 0, query = '', generation = 0, debounce;
const frequencyLabels = { scheduled: '09:00, 14:00, 22:00', '10m': '10 минут', '30m': '30 минут', '1h': '1 час', '4h': '4 часа', '8h': '8 часов' };
function status(text = '', error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
async function api(path, data = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, initData: tg?.initData || '' }), signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос.');
    return result;
  } catch (error) { if (error.name === 'AbortError') throw new Error('Сервер не ответил. Попробуйте ещё раз.'); throw error; }
  finally { clearTimeout(timeout); }
}
const dirty = () => JSON.stringify(settings) !== saved;
function refresh() {
  $('chosen').replaceChildren();
  for (const id of settings.cities) {
    const p = places.get(id), button = document.createElement('button'); button.type = 'button'; button.className = 'chip';
    button.textContent = `${p?.name || 'Населённый пункт'} ×`; button.title = `${p?.oblast || ''}, ${p?.rayon || ''}`; button.setAttribute('aria-label', `Убрать ${p?.name || ''}`);
    button.onclick = () => { settings.cities = settings.cities.filter(x => x !== id); refresh(); };
    $('chosen').append(button);
  }
  const names = settings.cities.map(id => places.get(id)?.name);
  $('minsk').hidden = !names.includes('Минск');
  $('other-districts').replaceChildren();
  for (const [city, districts] of Object.entries(catalog.cityDistricts)) {
    if (!names.includes(city)) continue;
    const section = document.createElement('section'), title = document.createElement('h2'); title.textContent = `Районы города · ${city}`;
    const group = document.createElement('div'); group.className = 'choices';
    choices(group, districts.map(name => ({ name, id: name })), settings.cityDistricts[city] || [], ids => { settings.cityDistricts[city] = ids; refresh(); });
    section.append(title, group); $('other-districts').append(section);
  }
  $('save').disabled = busy || !settings.cities.length || !dirty();
  $('check').disabled = busy || !configured || dirty();
  $('save-hint').textContent = dirty() ? 'Изменения ещё не сохранены' : `Сохранено · проверка: ${frequencyLabels[settings.frequency]}`;
  if (dirty()) tg?.enableClosingConfirmation?.(); else tg?.disableClosingConfirmation?.();
}
function choices(container, options, selected, change) {
  container.replaceChildren();
  for (const option of options) {
    const label = document.createElement('label'); label.className = 'choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.includes(option.id);
    input.onchange = () => change(input.checked ? [...selected, option.id] : selected.filter(x => x !== option.id));
    label.append(input, document.createTextNode(option.name)); container.append(label);
  }
}
function filters() {
  $('stations').replaceChildren();
  for (const line of catalog.lines) {
    const details = document.createElement('details'), summary = document.createElement('summary'), group = document.createElement('div');
    summary.textContent = line.name; group.className = 'choices';
    choices(group, catalog.stations.filter(s => s.line === line.id), settings.stations, ids => { settings.stations = ids; filters(); refresh(); });
    details.append(summary, group); details.open = true; $('stations').append(details);
  }
  choices($('lines'), [{ id: 'near', name: 'Возле метро' }, ...catalog.lines.map(l => ({ id: String(l.id), name: l.name }))], settings.onliner, ids => {
    const added = ids.find(x => !settings.onliner.includes(x));
    settings.onliner = added === 'near' ? ['near'] : ids.filter(x => x !== 'near'); filters(); refresh();
  });
  choices($('districts'), catalog.districts.map(name => ({ id: name, name })), settings.districts, ids => { settings.districts = ids; filters(); refresh(); });
}
function button(text, click, small = '', selected = false) {
  const el = document.createElement('button'); el.type = 'button'; el.className = `place-button${selected ? ' selected' : ''}`; el.textContent = text;
  if (small) { const label = document.createElement('small'); label.textContent = small; el.append(label); }
  el.onclick = click; $('location-list').append(el);
}
function choose(p) {
  places.set(p.id, p);
  if (!settings.cities.includes(p.id)) settings.cities.push(p.id);
  closeLocations(); refresh(); status('Город добавлен. Сохраните настройки, чтобы применить поиск.');
}
function closeLocations() { generation++; clearTimeout(debounce); $('locations').close(); tg?.BackButton?.hide(); }
async function browse(append = false) {
  const version = ++generation; $('location-error').textContent = ''; $('more').hidden = true;
  $('search').hidden = step !== 'places'; $('back').disabled = step === 'oblast';
  $('location-title').textContent = step === 'oblast' ? 'Выберите область' : step === 'region' ? 'Город или район области' : 'Выберите населённый пункт';
  $('breadcrumb').textContent = step === 'oblast' ? 'Шаг 1 · Область' : `${catalog.oblasts[oblast]} область${step === 'places' ? ' → ' + rayon.name + ' район' : ''}`;
  if (!append) $('location-list').replaceChildren();
  if (step === 'oblast') { catalog.oblasts.forEach((name, id) => button(name + ' область', () => { oblast = id; step = 'region'; browse(); })); return; }
  try {
    if (step === 'region') {
      const result = await api('region', { oblast }); if (version !== generation) return;
      result.direct.forEach(p => button(`🏙 ${p.name}`, () => choose(p), 'Город · выбрать сразу', settings.cities.includes(p.id)));
      result.rayons.forEach((name, id) => button(`📍 ${name} район`, () => { rayon = { id, name }; step = 'places'; offset = 0; query = ''; $('search').value = ''; browse(); }, 'Выбрать населённый пункт'));
    } else {
      const result = await api('places', { oblast, rayon: rayon.id, offset, query }); if (version !== generation) return;
      result.places.forEach(p => button(`${settings.cities.includes(p.id) ? '✓ ' : ''}${p.name}`, () => choose(p), p.type, settings.cities.includes(p.id)));
      if (!result.total) $('location-list').textContent = 'Ничего не найдено. Попробуйте другое название.';
      $('more').hidden = offset + result.places.length >= result.total;
    }
  } catch (error) { if (version === generation) { $('location-error').textContent = error.message; button('Повторить загрузку', () => browse()); } }
}
function back() { if (step === 'places') step = 'region'; else if (step === 'region') step = 'oblast'; else { closeLocations(); return; } browse(); }
$('add').onclick = () => { step = 'oblast'; $('locations').showModal(); tg?.BackButton?.show(); browse(); };
$('close').onclick = closeLocations; $('locations').addEventListener('cancel', e => { e.preventDefault(); closeLocations(); });
$('back').onclick = back; tg?.BackButton?.onClick(back);
$('more').onclick = () => { offset += 30; browse(true); };
$('search').oninput = () => { clearTimeout(debounce); generation++; debounce = setTimeout(() => { query = $('search').value; offset = 0; browse(); }, 300); };
$('price').oninput = () => { settings.maxByn = $('price').value === '' ? null : Number($('price').value); refresh(); };
$('frequency').onchange = () => { settings.frequency = $('frequency').value; refresh(); };
$('form').onsubmit = async e => {
  e.preventDefault(); if (busy || !dirty()) return; busy = true; refresh(); status('Сохраняем…');
  try { const result = await api('preferences', { settings }); settings = result.settings; saved = JSON.stringify(settings); configured = true; status('Настройки сохранены. Поиск по расписанию включён.'); tg?.HapticFeedback?.notificationOccurred('success'); }
  catch (error) { status(error.message, true); }
  finally { busy = false; filters(); refresh(); }
};
$('check').onclick = async () => {
  if (busy || dirty()) return; busy = true; refresh();
  try { const result = await api('check'); status(result.running ? 'Проверка уже идёт. Результат придёт в ваш чат.' : 'Проверка запущена. Объявления придут в ваш чат Telegram.'); }
  catch (error) { status(error.message, true); }
  finally { busy = false; refresh(); }
};
async function init() {
  $('retry').hidden = true;
  if (!tg?.initData) { status('Откройте из Telegram'); $('outside').hidden = false; return; }
  tg.ready(); tg.expand();
  try {
    const session = await api('session'); settings = session.settings; catalog = session.catalog; configured = session.configured;
    session.places.forEach(p => places.set(p.id, p)); saved = configured ? JSON.stringify(settings) : '';
    $('welcome').textContent = `${session.user.firstName ? session.user.firstName + ', н' : 'Н'}астройте свой поиск. Новые объявления придут в ваш чат.`;
    $('price').value = settings.maxByn ?? ''; $('frequency').value = settings.frequency;
    filters(); refresh(); $('form').hidden = false; status();
  } catch (error) { status(error.message, true); $('retry').hidden = false; }
}
$('retry').onclick = init;
init();
