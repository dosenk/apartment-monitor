import test from 'node:test';
import assert from 'node:assert/strict';
import { interval, matches, onliner, realt, kufar, dueScan } from './logic.mjs';
import { STATIONS, toggleStation, toggleOnliner, preferences } from './metro.mjs';
import { DISTRICTS, matchesDistrict, matchesCityDistrict } from './districts.mjs';
import { CITIES } from './geography.mjs';
import { OBLASTS, rayons, cities, directCities } from './location.mjs';

test('oblast, rayon and city selection searches whole non-Minsk city without Minsk metro filter', () => {
  assert.equal(OBLASTS.length, 6);
  const minsk = CITIES.findIndex(row => row[0] === 'Минск');
  const zaslavl = CITIES.findIndex(row => row[0] === 'Заславль');
  const brest = CITIES.findIndex(row => row[0] === 'Брест');
  assert.ok(rayons('Минская').includes('Минский'));
  assert.ok(cities('Минская', 'Минский').some(x => x.index === zaslavl));
  assert.ok(directCities('Брестская').some(x => x.index === brest));
  const selected = { ...preferences(null), cities: [minsk, zaslavl], districts: ['Советский'],
    onliner: ['near'], radiusKm: 2 };
  const base = { key: 'onliner:42', byn: 800, publishedAt: '2026-10-01T07:00:00Z' };
  const start = '2026-10-01T06:00:00Z', end = '2026-10-01T08:00:00Z';
  assert.ok(matches({ ...base, city: 'Заславль' }, start, end, selected));
  assert.ok(!matches({ ...base, city: 'Брест' }, start, end, selected));
  assert.ok(!matches({ ...base, city: 'Минск', latitude: 53.7, longitude: 27.1 }, start, end, selected));
  assert.ok(matches({ ...base, city: 'Брест' }, start, end, { ...selected, cities: [brest] }));
  assert.ok(matches({ ...base, key: 'kufar:42', city: null,
    address: 'Московская ул, 11, Брест, Брестская область' }, start, end,
  { ...selected, cities: [brest] }));
  const kufarItem = kufar({ pagination: { pages: [] }, ads: [{
    ad_id: 44, ad_link: 'https://re.kufar.by/vi/44', list_time: base.publishedAt,
    price_usd: '20000', price_byn: '60000', images: [],
    account_parameters: [{ p: 'address', v: 'Московская ул, 11, Брест, Брестская область' }],
    ad_parameters: [{ p: 'region', vl: 'Брестская область', v: 1 },
      { p: 'area', vl: 'Брест', v: 11 }, { p: 'coordinates', v: [23.73, 52.10] }],
  }] }).items[0];
  assert.ok(matches(kufarItem, start, end, { ...selected, cities: [brest] }));
  const sample = new Map();
  for (let lat = 52.05; lat < 52.16; lat += 0.002) {
    for (let lon = 23.6; lon < 23.85; lon += 0.002) {
      for (const name of ['Ленинский', 'Московский']) {
        if (matchesCityDistrict({ latitude: lat, longitude: lon },
          { cityDistricts: { Брест: [name] } }, 'Брест')) sample.set(name, [lat, lon]);
      }
    }
  }
  assert.equal(sample.size, 2);
  const [lat, lon] = sample.get('Ленинский');
  assert.ok(matches({ ...base, city: 'Брест', latitude: lat, longitude: lon }, start, end,
    { ...selected, cities: [brest], cityDistricts: { Брест: ['Ленинский'] } }));
  assert.ok(!matches({ ...base, city: 'Брест', latitude: lat, longitude: lon }, start, end,
    { ...selected, cities: [brest], cityDistricts: { Брест: ['Московский'] } }));
});

test('frequency choices fire on Minsk clock boundaries', () => {
  assert.equal(dueScan('scheduled', Date.parse('2026-10-01T06:00:00Z')), 'morning');
  assert.equal(dueScan('scheduled', Date.parse('2026-10-01T11:00:00Z')), 'midday');
  assert.equal(dueScan('scheduled', Date.parse('2026-10-01T19:00:00Z')), 'evening');
  assert.equal(dueScan('scheduled', Date.parse('2026-10-01T06:10:00Z')), null);
  assert.equal(dueScan('10m', Date.parse('2026-10-01T06:10:00Z')), 'check');
  assert.equal(dueScan('30m', Date.parse('2026-10-01T06:10:00Z')), null);
  assert.equal(dueScan('1h', Date.parse('2026-10-01T06:00:00Z')), 'check');
  assert.equal(dueScan('4h', Date.parse('2026-10-01T09:00:00Z')), 'check');
  assert.equal(dueScan('8h', Date.parse('2026-10-01T05:00:00Z')), 'check');
});

test('each Minsk district can be selected independently and combined with metro', () => {
  assert.equal(DISTRICTS.length, 9);
  const sample = new Map();
  for (let lat = 53.84; lat < 53.96; lat += 0.005) {
    for (let lon = 27.43; lon < 27.70; lon += 0.005) {
      const item = { latitude: lat, longitude: lon };
      const districts = DISTRICTS.filter(name => matchesDistrict(item, { districts: [name] }));
      if (districts.length === 1) sample.set(districts[0], item);
    }
  }
  assert.deepEqual([...sample.keys()].sort(), [...DISTRICTS].sort());
  const item = { ...sample.get('Советский'), key: 'onliner:1', city: 'Минск', byn: 1200,
    publishedAt: '2026-10-01T07:00:00Z' };
  assert.ok(matches(item, '2026-10-01T06:00:00Z', '2026-10-01T08:00:00Z',
    { districts: ['Советский'], stations: [], onliner: [], maxByn: null, radiusKm: null }));
  assert.ok(!matches(item, '2026-10-01T06:00:00Z', '2026-10-01T08:00:00Z',
    { districts: ['Октябрьский'], stations: [], onliner: [], maxByn: null, radiusKm: null }));
});

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
  const base = { city: 'Минск', publishedAt: '2026-10-01T07:00:00Z', usd: 450, byn: 1400, latitude: 53.92176,
    longitude: 27.59934, metroNames: ['Академия наук'] };
  const index = STATIONS.findIndex(x => x[0] === 'Академия наук');
  let selected = toggleStation(preferences(null), index);
  assert.ok(matches({ ...base, key: 'realt:1' }, start, end, selected));
  assert.ok(matches({ ...base, key: 'kufar:1' }, start, end, selected));
  assert.ok(!matches({ ...base, key: 'realt:1', metroNames: ['Каменная горка'] }, start, end, selected));
  assert.ok(matches({ ...base, key: 'kufar:1', latitude: 53.84992, longitude: 27.47481 }, start, end, selected));
  assert.ok(matches({ ...base, key: 'kufar:1', latitude: 53.84992, longitude: 27.47481 }, start, end,
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
  assert.ok(matches({ ...base, key: 'realt:1', latitude: NaN, longitude: NaN }, start, end,
    { stations: [], onliner: [], maxByn: null, radiusKm: 2 }));
});

test('three sources preserve direct links, first photo, USD price, and location', () => {
  const stamp = '2026-09-30T07:00:00Z';
  const on = onliner({ page: { last: 1 }, apartments: [{ id: 42, url: 'https://r.onliner.by/ak/apartments/42',
    created_at: stamp, rent_type: '2_rooms', photo: 'https://img.example/photo.jpg',
    location: { latitude: 53.915, longitude: 27.583, user_address: 'Минск, Коласа' },
    price: { converted: { BYN: { amount: '1400' }, USD: { amount: '450' } } } }] }).items[0];
  const r = realt(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { pagination: { totalCount: 1 },
    objects: [{ code: 99, price: 450, priceCurrency: 840, priceRates: { 933: 1400 }, createdAt: stamp,
      townName: 'Минск', location: [27.583, 53.915], images: ['https://cdn.example/first.jpg'] }] } } })}</script>`).items[0];
  const k = kufar({ pagination: { pages: [] }, ads: [{ ad_id: 123, ad_link: 'https://re.kufar.by/vi/123',
    list_time: stamp, price_usd: '45000', price_byn: '140000',
    account_parameters: [{ p: 'address', v: 'Минск, Коласа' }],
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

test('manual-only frequency persists and never triggers a scheduled check', () => {
  assert.equal(preferences({frequency:'manual'}).frequency,'manual');
  for (let minute=0;minute<1440;minute+=10) assert.equal(dueScan('manual',Date.parse('2026-10-04T00:00:00Z')+minute*60000),null);
});
