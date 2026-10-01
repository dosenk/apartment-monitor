import { CITIES, RAYONS, DIRECT_NAMES, CANONICAL_CITY } from './geography.mjs';

export const OBLASTS = ['Брестская', 'Витебская', 'Гомельская', 'Гродненская', 'Минская', 'Могилевская'];
export const DEFAULT_CITY = CITIES.findIndex(([city]) => city === 'Минск');
export const cityName = index => CITIES[index]?.[0];
export const isMinskSelected = value => value?.cities?.some(index => cityName(index) === 'Минск');

export function rayons(oblast) {
  return RAYONS[OBLASTS.indexOf(oblast)] || [];
}

const groups = new Map();
const kindRank = kind => kind === 'г.' ? 0 : ['гп', 'рп'].includes(kind) ? 1 : kind === 'аг.' ? 2 : 3;
for (const [index, row] of CITIES.entries()) {
  if (CANONICAL_CITY[index] !== index) continue;
  const key = `${row[1]}|${row[2]}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ row, index });
}
for (const entries of groups.values()) entries.sort((a, b) => kindRank(a.row[3]) - kindRank(b.row[3]) || a.row[0].localeCompare(b.row[0], 'ru'));

export function cities(oblast, rayon, query = '') {
  const entries = groups.get(`${oblast.toUpperCase()} ОБЛАСТЬ|${rayon}`) || [];
  return query ? entries.filter(({ row }) => canonical(row[0]).includes(canonical(query))) : entries;
}

export function directCities(oblast) {
  const region = OBLASTS.indexOf(oblast);
  return (DIRECT_NAMES[region] || []).flatMap(name => {
    const index = CITIES.findIndex(row => row[0] === name && row[1] === `${oblast.toUpperCase()} ОБЛАСТЬ` && row[3] === 'г.');
    return index < 0 ? [] : [{ row: CITIES[index], index: CANONICAL_CITY[index] }];
  });
}

const canonical = s => String(s || '').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')
  .replaceAll('і', 'и').replaceAll('ў', 'у').trim()
  .replace(/^(?:г\.|город|аг\.|агрогородок|гп|поселок|деревня|д\.)\s+/u, '').trim();

export function selectedCity(item, selected) {
  const tokens = [item.city, ...(item.address || '').split(',')].map(canonical).filter(Boolean);
  return (selected?.cities || []).find(index => {
    if (!tokens.includes(canonical(cityName(index)))) return false;
    const oblast = CITIES[index]?.[1];
    const regionMatches = !item.region || canonical(item.region) === canonical(oblast) ||
      (cityName(index) === 'Минск' && canonical(item.region) === 'минск');
    const rayon = CITIES[index]?.[2];
    return regionMatches && (!item.rayon || !rayon ||
      canonical(item.rayon).replace(/ район$/, '') === canonical(rayon));
  }) ?? null;
}
