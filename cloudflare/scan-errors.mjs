export function sourceFailure(error) {
  const message = String(error);
  const code = message.match(/Source HTTP (\d{3})/)?.[1];
  if (code === '403') return 'доступ ограничен площадкой (HTTP 403)';
  if (code === '429') return 'слишком частые запросы (HTTP 429)';
  if (code) return `ошибка площадки (HTTP ${code})`;
  if (/page limit/i.test(message)) return 'достигнут предел страниц';
  if (/timeout|abort/i.test(message)) return 'превышено время ожидания';
  if (/format|data missing|JSON/i.test(message)) return 'изменился формат данных';
  return 'ошибка получения данных';
}

export function scanHeading(period, total, failures, propertyType = 'apartments') {
  const names = { onliner: 'Onliner', realt: 'Realt', kufar: 'Kufar' };
  return `${propertyType === 'commercial' ? '🏢 Коммерческая недвижимость' : '🏠 Квартиры'} за период ${period}\n` +
    (total ? `Новых объявлений: ${total}` : failures.length ? 'В доступных данных новых объявлений нет' : 'Новых объявлений нет') +
    (failures.length ? '\n\n⚠️ Проверка неполная:\n' + failures.map(x => `${names[x.source] || (x.source?.startsWith('realt-') ? 'Realt (' + ({ offices: 'офисы', shops: 'торговые помещения', warehouses: 'склады', storages: 'свободные помещения', services: 'услуги', production: 'производство', 'restorant-cafe': 'общепит' }[x.source.slice(6)] || 'коммерция') + ')' : 'Площадка')}: ${x.reason}`).join('\n') +
      '\nПовторю проверку по расписанию. Период сохранён для повторной проверки; присланные объявления не повторятся.' : '');
}
