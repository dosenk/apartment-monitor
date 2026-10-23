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

export function scanHeading(period, total, failures, propertyType = 'apartments', automatic = true) {
  const grouped = new Map();
  for (const entry of failures) {
    const name = entry.source === 'kufar' ? 'Kufar' : entry.source === 'onliner' ? 'Onliner' : entry.source === 'realt' || entry.source?.startsWith('realt-') ? 'Realt' : 'Площадка';
    const key = `${name}: ${entry.reason}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  const lines = [...grouped].map(([message, count]) => message + (count > 1 ? ` (${count} разделов)` : ''));
  return `${propertyType === 'commercial' ? '🏢 Коммерческая недвижимость' : '🏠 Квартиры'} за период ${period}\n` +
    (total ? `Новых объявлений: ${total}` : failures.length ? 'В доступных данных новых объявлений нет' : 'Новых объявлений нет') +
    (failures.length ? '\n\n⚠️ Проверка неполная:\n' + lines.join('\n') +
      (automatic ? '\nПовторю проверку по расписанию.' : '\nПовторите проверку кнопкой «Проверить».') +
      ' Период сохранён для повторной проверки; присланные объявления не повторятся.' : '');
}
