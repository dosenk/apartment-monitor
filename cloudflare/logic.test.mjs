import test from 'node:test';
import assert from 'node:assert/strict';
import { interval, matches, onliner, realt, kufar } from './logic.mjs';
import { STATIONS, toggleStation, toggleOnliner, preferences } from './metro.mjs';

test('scheduled windows and a manual check share one advancing cursor', () => {
  const noon = Date.parse('2026-09-30T11:00:00Z');
  assert.deepEqual(interval('midday', noon), {
    start: '2026-09-30T06:00:00.000Z', end: '2026-09-30T11:00:00.000Z',
  });
  const check = interval('check', '2026-09-30T09:00:00Z', '2026-09-30T06:00:00Z');
  assert.deepEqual(check, { start: '2026-09-30T06:00:00.000Z', end: '2026-09-30T09:00:00.000Z' });
  assert.equal(interval('midday', '2026-09-30T11:00:00Z', check.end).start, check.end);
});

test('station selection is shared by Realt and Kufar while Onliner lines are independent', () => {
  const start = '2026-10-01T06:00:00Z', end = '2026-10-01T09:00:00Z';
  const base = { publishedAt: '2026-10-01T07:00:00Z', usd: 450, byn: 1400, latitude: 53.92176,
    longitude: 27.59934, metroNames: ['Академия наук'] };
  const index = STATIONS.findIndex(x => x[0] === 'Академия наук');
  let selected = toggleStation(preferences(null), index);
  assert.ok(matches({ ...base, key: 'realt:1' }, start, end, selected));
  assert.ok(matches({ ...base, key: 'kufar:1' }, start, end, selected));
  assert.ok(!matches({ ...base, key: 'realt:1', metroNames: ['Каменная горка'] }, start, end, selected));
  assert.ok(matches({ ...base, key: 'kufar:1', latitude: 53.84992, longitude: 27.47481 }, start, end, selected));
  assert.ok(!matches({ ...base, key: 'kufar:1', latitude: 53.84992, longitude: 27.47481 }, start, end,
    { ...selected, radiusKm: 3 }));
  selected = toggleOnliner(selected, '2');
  assert.ok(!matches({ ...base, key: 'onliner:1' }, start, end, selected));
  assert.ok(matches({ ...base, key: 'onliner:1', latitude: 53.90623, longitude: 27.45398 }, start, end, selected));
  assert.deepEqual(toggleOnliner(selected, 'near').onliner, ['near']);
  assert.deepEqual(toggleStation(selected, index).stations, []);
  assert.ok(!matches({ ...base, key: 'realt:1' }, start, end, { ...selected, maxByn: 1200 }));
  assert.ok(matches({ ...base, key: 'realt:1' }, start, end, { ...selected, maxByn: null }));
  assert.ok(matches({ ...base, key: 'realt:1', latitude: NaN, longitude: NaN }, start, end,
    { stations: [], onliner: [], maxByn: null, radiusKm: null }));
  assert.ok(!matches({ ...base, key: 'realt:1', latitude: NaN, longitude: NaN }, start, end,
    { stations: [], onliner: [], maxByn: null, radiusKm: 2 }));
});

test('three sources preserve direct links, first photo, USD price, and location', () => {
  const stamp = '2026-09-30T07:00:00Z';
  const on = onliner({ page: { last: 1 }, apartments: [{ id: 42, url: 'https://r.onliner.by/ak/apartments/42',
    created_at: stamp, rent_type: '2_rooms', photo: 'https://img.example/photo.jpg',
    location: { latitude: 53.915, longitude: 27.583, user_address: 'Коласа' },
    price: { converted: { BYN: { amount: '1400' }, USD: { amount: '450' } } } }] }).items[0];
  const r = realt(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { pagination: { totalCount: 1 },
    objects: [{ code: 99, price: 450, priceCurrency: 840, priceRates: { 933: 1400 }, createdAt: stamp,
      location: [27.583, 53.915], images: ['https://cdn.example/first.jpg'] }] } } })}</script>`).items[0];
  const k = kufar({ pagination: { pages: [] }, ads: [{ ad_id: 123, ad_link: 'https://re.kufar.by/vi/123',
    list_time: stamp, price_usd: '45000', price_byn: '140000',
    ad_parameters: [{ p: 'coordinates', v: [27.583, 53.915] }],
    images: [{ media_storage: 'rms', path: 'adim1/first.jpg' }] }] }).items[0];
  for (const item of [on, r, k]) {
    assert.equal(item.usd, 450);
    assert.ok(matches(item, '2026-09-30T06:00:00Z', '2026-09-30T09:00:00Z'));
    assert.ok(item.url.startsWith('https://'));
    assert.ok(item.photo.startsWith('https://'));
    assert.ok(!matches(item, '2026-09-30T08:00:00Z', '2026-09-30T09:00:00Z'));
  }
});
