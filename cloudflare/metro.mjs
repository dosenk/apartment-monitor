// Station coordinates and line membership from the public Minsk Metro/OSM station map.
// Coordinates are [latitude, longitude]. Keep names compatible with listing feeds.
export const LINES = [
  { id: 1, name: 'Московская линия' },
  { id: 2, name: 'Автозаводская линия' },
  { id: 3, name: 'Зеленолужская линия' },
];

export const STATIONS = [
  ['Малиновка', 1, 53.84992, 27.47481],
  ['Петровщина', 1, 53.86472, 27.48616],
  ['Михалово', 1, 53.87689, 27.49710],
  ['Грушевка', 1, 53.88673, 27.51487],
  ['Институт культуры', 1, 53.88589, 27.54071],
  ['Площадь Ленина', 1, 53.89241, 27.54793],
  ['Октябрьская', 1, 53.90211, 27.56215],
  ['Площадь Победы', 1, 53.90948, 27.57623],
  ['Площадь Якуба Коласа', 1, 53.91584, 27.58404],
  ['Академия наук', 1, 53.92176, 27.59934],
  ['Парк Челюскинцев', 1, 53.92423, 27.61371],
  ['Московская', 1, 53.92804, 27.62813],
  ['Восток', 1, 53.93441, 27.65138],
  ['Борисовский тракт', 1, 53.93874, 27.66666],
  ['Уручье', 1, 53.94538, 27.68790],
  ['Каменная горка', 2, 53.90691, 27.43590],
  ['Кунцевщина', 2, 53.90623, 27.45398],
  ['Спортивная', 2, 53.90843, 27.47954],
  ['Пушкинская', 2, 53.90967, 27.49774],
  ['Молодежная', 2, 53.90664, 27.52291],
  ['Фрунзенская', 2, 53.90534, 27.53931],
  ['Немига', 2, 53.90584, 27.55403],
  ['Купаловская', 2, 53.90093, 27.56181],
  ['Первомайская', 2, 53.89384, 27.57092],
  ['Пролетарская', 2, 53.88997, 27.58628],
  ['Тракторный завод', 2, 53.88992, 27.61450],
  ['Партизанская', 2, 53.87630, 27.62888],
  ['Автозаводская', 2, 53.86922, 27.64795],
  ['Могилевская', 2, 53.86199, 27.67425],
  ['Юбилейная площадь', 3, 53.90479, 27.54046],
  ['Площадь Богушевича', 3, 53.89638, 27.53783],
  ['Вокзальная', 3, 53.88996, 27.54622],
  ['Ковальская Слобода', 3, 53.87741, 27.54967],
  ['Аэродромная', 3, 53.86775, 27.54700],
  ['Неморшанский сад', 3, 53.85025, 27.53648],
  ['Слуцкий Гостинец', 3, 53.84273, 27.53396],
];

import { DISTRICTS } from './districts.mjs';

export const FREQUENCIES = ['scheduled', '10m', '30m', '1h', '4h', '8h'];
export const DEFAULT_PREFERENCES = Object.freeze({ stations: [], onliner: [], districts: [],
  maxByn: null, radiusKm: null, frequency: 'scheduled' });

export function preferences(value) {
  const stations = Array.isArray(value?.stations) ? value.stations : [];
  const onliner = Array.isArray(value?.onliner) ? value.onliner : [];
  const districts = Array.isArray(value?.districts) ? value.districts : [];
  return {
    stations: [...new Set(stations.filter(x => Number.isInteger(x) && x >= 0 && x < STATIONS.length))],
    onliner: [...new Set(onliner.filter(x => ['near', '1', '2', '3'].includes(x)))],
    districts: [...new Set(districts.filter(x => DISTRICTS.includes(x)))],
    maxByn: Number.isFinite(value?.maxByn) && value.maxByn > 0 ? value.maxByn : null,
    radiusKm: Number.isFinite(value?.radiusKm) && value.radiusKm > 0 ? value.radiusKm : null,
    frequency: FREQUENCIES.includes(value?.frequency) ? value.frequency : 'scheduled',
  };
}

export function toggleStation(value, index) {
  const current = preferences(value);
  if (!Number.isInteger(index) || index < 0 || index >= STATIONS.length) return current;
  current.stations = current.stations.includes(index)
    ? current.stations.filter(x => x !== index) : [...current.stations, index];
  return current;
}

export function toggleOnliner(value, option) {
  const current = preferences(value);
  if (!['near', '1', '2', '3'].includes(option)) return current;
  if (option === 'near') current.onliner = current.onliner.includes('near') ? [] : ['near'];
  else {
    const lines = current.onliner.filter(x => x !== 'near');
    current.onliner = lines.includes(option) ? lines.filter(x => x !== option) : [...lines, option];
  }
  return current;
}

function canonical(name) {
  return String(name || '').toLocaleLowerCase('ru-RU')
    .replace('слуцкі гасцінец', 'слуцкий гостинец')
    .replace('немаршанскі сад', 'неморшанский сад')
    .replaceAll('ё', 'е')
    .replace(/\s*\(2024\)/g, '').replace(/[^а-я0-9]+/g, ' ').trim()
    .replace('площадь франтишка богушевича', 'площадь богушевича')
    .replace('аэрадромная', 'аэродромная')
    .replace('немаршанский сад', 'неморшанский сад');
}

export function matchesMetro(item, value, distanceKm, defaultCenter) {
  const selected = preferences(value);
  const source = item.key?.split(':')[0];
  const radiusKm = selected.radiusKm;
  const hasCoords = Number.isFinite(item.latitude) && Number.isFinite(item.longitude);
  if (source === 'onliner') {
    if (!selected.onliner.length) return radiusKm === null || (hasCoords &&
      distanceKm(item.latitude, item.longitude, ...defaultCenter) <= radiusKm);
    if (!hasCoords) return false;
    const distances = STATIONS.map(station => distanceKm(item.latitude, item.longitude, station[2], station[3]));
    const nearest = distances.indexOf(Math.min(...distances));
    if (selected.onliner.includes('near')) return distances[nearest] <= (radiusKm ?? 1);
    return selected.onliner.includes(String(STATIONS[nearest][1])) &&
      (radiusKm === null || distances[nearest] <= radiusKm);
  } else if (source === 'realt' || source === 'kufar') {
    if (!selected.stations.length) return radiusKm === null || (hasCoords &&
      distanceKm(item.latitude, item.longitude, ...defaultCenter) <= radiusKm);
    const stations = selected.stations.map(index => STATIONS[index]).filter(Boolean)
      .filter(station => (item.metroNames || []).some(name => canonical(name) === canonical(station[0])));
    return stations.some(station => radiusKm === null || (hasCoords &&
      distanceKm(item.latitude, item.longitude, station[2], station[3]) <= radiusKm));
  } else return false;
}
