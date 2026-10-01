import { CITIES } from './geography.mjs';

export const OBLASTS = ['Брестская', 'Витебская', 'Гомельская', 'Гродненская', 'Минская', 'Могилевская'];
export const DEFAULT_CITY = CITIES.findIndex(([city]) => city === 'Минск');
export const cityName = index => CITIES[index]?.[0];
export const isMinskSelected = value => value?.cities?.some(index => cityName(index) === 'Минск');

export function rayons(oblast) {
  return [...new Set(CITIES.filter(row => row[1] === `${oblast.toUpperCase()} ОБЛАСТЬ`).map(row => row[2]))].sort((a, b) => a.localeCompare(b, 'ru'));
}

export function cities(oblast, rayon) {
  return CITIES.map((row, index) => ({ row, index }))
    .filter(({ row }) => row[1] === `${oblast.toUpperCase()} ОБЛАСТЬ` && row[2] === rayon)
    .sort((a, b) => a.row[0].localeCompare(b.row[0], 'ru'));
}

const canonical = s => String(s || '').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')
  .replaceAll('і', 'и').replaceAll('ў', 'у').replace(/\bг\.?\s*/g, '').trim();

export function selectedCity(item, selected) {
  const tokens = [item.city, ...(item.address || '').split(',')].map(canonical).filter(Boolean);
  return (selected?.cities || []).find(index => {
    if (!tokens.includes(canonical(cityName(index)))) return false;
    const oblast = CITIES[index]?.[1];
    return !item.region || canonical(item.region) === canonical(oblast) ||
      (cityName(index) === 'Минск' && canonical(item.region) === 'минск');
  }) ?? null;
}
