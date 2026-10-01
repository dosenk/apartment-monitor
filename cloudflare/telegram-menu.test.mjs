import test from 'node:test';
import assert from 'node:assert/strict';
import { menu, settingsSummary } from './telegram-menu.mjs';
import { preferences } from './metro.mjs';
import { CITIES, RAYONS } from './geography.mjs';
import { cities, rayons } from './location.mjs';

const labels = view => view.inline_keyboard.flat().map(button => button.text);
const minsk = CITIES.findIndex(row => row[0] === 'Минск');
const brest = CITIES.findIndex(row => row[0] === 'Брест' && row[3] === 'г.');

test('fresh settings and legacy implicit Minsk do not expose city filters', () => {
  for (const selected of [preferences({ cities: [] }), preferences(null)]) {
    const view = menu('home', selected);
    assert.ok(view.text.includes('Города: не выбраны'));
    assert.deepEqual(labels(view), ['📍 Область', '🗺 Район области', '🏙 Город / населённый пункт',
      '💰 Цена, BYN', '⏱ Частота проверки', 'ℹ️ Как пользоваться', '✅ Применить', 'Отмена']);
    assert.deepEqual(labels(menu('stations:1', selected)), labels(view));
  }
});

test('Minsk filters appear only after explicit Minsk selection; radius is removed', () => {
  const selected = preferences({ cities: [minsk], locationChosen: true, radiusKm: 3 });
  const buttons = labels(menu('home', selected));
  assert.ok(buttons.includes('🚇 Станции Realt + Kufar'));
  assert.ok(buttons.includes('🚇 Линии Onliner'));
  assert.ok(buttons.includes('🗺 Районы Минска'));
  assert.ok(!buttons.some(text => /Радиус/.test(text)));
  assert.equal(selected.radiusKm, null);
  assert.ok(!/Радиус/.test(settingsSummary(selected)));
  const other = labels(menu('home', preferences({ cities: [brest], locationChosen: true })));
  assert.ok(other.includes('🗺 Районы Бреста'));
  assert.ok(!other.some(text => /Станции|Линии|Минска/.test(text)));
  assert.ok(!labels(menu('home', { ...selected, cities: [] })).some(text => /Станции|Линии|Минска/.test(text)));
});

test('all 118 rayons are independent of city records and province cities have separate buttons', () => {
  assert.deepEqual(RAYONS.map(rows => rows.length), [16, 21, 21, 17, 22, 21]);
  const names = rayons('Минская');
  for (const name of ['Клецкий', 'Воложинский', 'Дзержинский', 'Минский']) assert.ok(names.includes(name));
  assert.ok(!names.includes('Жодинский'));
  const view = menu('oblast:4', preferences({ cities: [] }));
  assert.ok(labels(view)[0].includes('🏙 Минск'));
  assert.ok(labels(view)[1].includes('🏙 Жодино'));
  assert.ok(labels(view).includes('🗺 Клецкий район'));
  assert.ok(!view.text.includes('без района'));
  const entries = cities('Минская', 'Минский');
  for (const name of ['Заславль', 'Мачулищи', 'Боровляны', 'Ждановичи'])
    assert.ok(entries.some(({ row }) => row[0] === name), name);
  assert.ok(entries.length > 2);
  assert.ok(cities('Минская', 'Минский', 'боров').some(({ row }) => row[0] === 'Боровляны'));
});

test('location pages stay inside Telegram message and callback limits', () => {
  const selected = preferences({ cities: [], browseOblast: 4,
    browseRayon: rayons('Минская').indexOf('Минский') });
  for (const screen of ['home', 'locations', 'oblast:4', `rayon:4:${selected.browseRayon}:0`, 'help']) {
    const view = menu(screen, selected);
    assert.ok(view.text.length <= 4096);
    assert.ok(view.inline_keyboard.length <= 100);
    for (const button of view.inline_keyboard.flat()) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});
