import { LINES, STATIONS, FREQUENCIES } from './metro.mjs';
import { DISTRICTS, CITY_DISTRICTS } from './districts.mjs';
import { CITIES } from './geography.mjs';
import { OBLASTS, rayons, cities, cityName, isMinskSelected, directCities } from './location.mjs';

export const SETTINGS_BUTTON = '⚙️ Настройки поиска';
export const OLD_SETTINGS_BUTTON = '⚙️ Настроить метро';
export const PAUSE_BUTTON = '⏸ Пауза';
export const RESUME_BUTTON = '▶️ Продолжить';
export const CHECK_BUTTON = '🔄 Проверить';
export const HELP_BUTTON = 'ⓘ Помощь';
export const CURRENT_BUTTON = '📋 Мой поиск';
const FREQUENCY_LABELS = { scheduled: '09:00, 14:00, 22:00', '10m': 'каждые 10 минут',
  '30m': 'каждые 30 минут', '1h': 'каждый час', '4h': 'каждые 4 часа', '8h': 'каждые 8 часов' };
export const keyboardFor = paused => ({ keyboard: [[{ text: CHECK_BUTTON }, { text: CURRENT_BUTTON },
  { text: HELP_BUTTON }, { text: paused ? RESUME_BUTTON : PAUSE_BUTTON }]],
  resize_keyboard: true, is_persistent: true });
export const keyboard = keyboardFor(false);

export function menu(screen, selected) {
  if (!selected.locationChosen) selected = { ...selected, cities: [] };
  if ((screen.startsWith('stations:') || screen === 'onliner' || screen === 'districts') &&
    (!selected.locationChosen || !isMinskSelected(selected))) screen = 'home';
  if (screen === 'city-districts:Brest' && !selected.cities.some(i => cityName(i) === 'Брест')) screen = 'home';
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
      text: `📍 ${OBLASTS[index]} область\n🏙 — город, 🗺 — район области. Выберите город напрямую или район, чтобы открыть населённые пункты.`,
      inline_keyboard: [
        ...directCities(OBLASTS[index]).map(({ row, index: cityIndex }) =>
          [pick(`${selected.cities.includes(cityIndex) ? '☑️' : '☐'} 🏙 ${row[0]}`, `capital:${cityIndex}:${index}`)]),
        ...names.map((name, i) => [pick(`🗺 ${name} район`, `rayon:${index}:${i}`)]),
        [pick('⬅️ Области', 'locations')],
      ],
    };
  }
  if (/^rayon:\d:\d+(?::\d+)?$/.test(screen)) {
    const [, oblastIndex, rayonIndex, pageText] = screen.split(':');
    const names = rayons(OBLASTS[Number(oblastIndex)]);
    const rayon = names[Number(rayonIndex)];
    const query = selected.browseOblast === Number(oblastIndex) && selected.browseRayon === Number(rayonIndex) ? selected.placeQuery : '';
    const entries = cities(OBLASTS[Number(oblastIndex)], rayon, query);
    const pages = Math.max(1, Math.ceil(entries.length / 8));
    const page = Math.min(Number(pageText || 0), pages - 1);
    return {
      text: `📍 ${OBLASTS[Number(oblastIndex)]} область · ${rayon} район\nВыберите город, посёлок или агрогородок — затем вернётесь в настройки. ${query ? `Поиск: «${query}». Найдено: ${entries.length}. ` : ''}Страница ${page + 1}/${pages}.`,
      inline_keyboard: [
        ...entries.slice(page * 8, (page + 1) * 8).map(({ row, index }) =>
          [pick(`${selected.cities.includes(index) ? '☑️' : '☐'} ${row[3] === 'г.' ? '🏙' : '🏡'} ${row[0]}${row[3] === 'г.' ? '' : ` (${row[3]})`}`,
            `city:${index}:${oblastIndex}:${rayonIndex}:${page}`)]),
        [
          ...(page ? [pick('◀️', `rayon:${oblastIndex}:${rayonIndex}:${page - 1}`)] : []),
          ...(page + 1 < pages ? [pick('▶️', `rayon:${oblastIndex}:${rayonIndex}:${page + 1}`)] : []),
        ].filter(Boolean),
        [pick('🔎 Найти по названию', `input:place:${oblastIndex}:${rayonIndex}`),
          ...(query ? [pick('Показать все', `clear-query:${oblastIndex}:${rayonIndex}`)] : [])],
        [pick('⬅️ Районы области', `oblast:${oblastIndex}`), pick('⚙️ Настройки', 'home')],
      ].filter(row => row.length),
    };
  }
  if (screen === 'help') return {
    text: 'ℹ️ Как пользоваться\n\n' +
      '1. Выберите область → район области → населённый пункт. Областной центр и города областного подчинения можно выбрать прямо в списке районов. После выбора места вы вернётесь в настройки. Для добавления ещё одного снова нажмите «Область». Повторное нажатие на отмеченное место убирает его.\n' +
      '2. После выбора Минска появятся станции Realt + Kufar, линии Onliner и районы Минска. Без этих отметок поиск идёт по Минску целиком. Район и метро применяются вместе. Для Бреста доступны районы города.\n' +
      '3. При желании задайте максимальную цену в BYN. Число 0 убирает ограничение.\n' +
      '4. Выберите частоту и нажмите «Применить». Кнопка «Текущие настройки» покажет сохранённые параметры; в меню редактирования показан черновик.\n\n' +
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
        '«Возле метро» означает до 1 км. Без выбора метро не ограничивает поиск.',
      inline_keyboard: [
        ...options.map(([id, name]) => [pick(`${selected.onliner.includes(id) ? '☑️' : '☐'} ${name}`, `option:${id}`)]),
        [pick('Сбросить Onliner', 'reset:onliner'), pick('⬅️ Настройки', 'home')],
      ],
    };
  }
  const stationNames = selected.stations.map(i => STATIONS[i]?.[0]).filter(Boolean);
  const onlinerNames = selected.onliner.map(id => id === 'near' ? 'возле метро' : LINES.find(x => String(x.id) === id)?.name).filter(Boolean);
  const minsk = selected.locationChosen && isMinskSelected(selected);
  return {
    text: '⚙️ Настройки поиска · черновик\n' +
      `Города: ${selected.cities.map(cityName).join(', ') || 'не выбраны'}\n` +
      (selected.cities.some(i => cityName(i) === 'Брест') ?
        `Районы Бреста: ${selected.cityDistricts.Брест.join(', ') || 'фильтр не задан'}\n` : '') +
      (minsk ? `Realt + Kufar, метро: ${stationNames.join(', ') || 'фильтр не задан'}\n` +
        `Onliner, метро: ${onlinerNames.join(', ') || 'фильтр не задан'}\n` +
        `Районы Минска: ${selected.districts.join(', ') || 'фильтр не задан'}\n` : '') +
      `Цена: ${selected.maxByn ? `до ${selected.maxByn} BYN` : 'без ограничения'}\n` +
      `Проверка: ${FREQUENCY_LABELS[selected.frequency]}\n\n` +
      'Чтобы добавить или убрать город, нажмите «Область» и пройдите выбор местоположения. Сохраните изменения кнопкой «Применить». Уже отправленные объявления не повторяются.',
    inline_keyboard: [
      [pick('📍 Область', 'locations')],
      ...(selected.cities.some(i => cityName(i) === 'Брест') ?
        [[pick('🗺 Районы Бреста', 'city-districts:Brest')]] : []),
      ...(minsk ? [[pick('🚇 Станции Realt + Kufar', 'stations:1')],
        [pick('🚇 Линии Onliner', 'onliner')], [pick('🗺 Районы Минска', 'districts')]] : []),
      [pick('💰 Цена, BYN', 'input:price')],
      [pick('⏱ Частота проверки', 'frequency')],
      [pick('ℹ️ Как пользоваться', 'help')],
      [pick('✅ Применить', 'apply'), pick('Отмена', 'cancel')],
    ],
  };
}

export function settingsSummary(selected) {
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
    `Частота: ${FREQUENCY_LABELS[selected.frequency]}`;
}
