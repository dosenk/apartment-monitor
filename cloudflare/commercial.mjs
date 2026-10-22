// Commercial rental data: Kufar category 1050 and Realt's public commercial listings.
export const REALT_COMMERCIAL = ['offices', 'shops', 'warehouses', 'storages', 'services', 'production', 'restorant-cafe'];
export const COMMERCIAL_FINISHES = ['any', 'finished', 'unfinished'];
export const scanSources = selected => selected.propertyType === 'commercial'
  ? [...REALT_COMMERCIAL.map(slug => `realt-${slug}`), 'kufar'] : ['onliner', 'realt', 'kufar'];
const positive = v => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
const metroNames = names => (Array.isArray(names) ? names : names ? [names] : []).flatMap(name => String(name).replace(/\s*\(\d{4}\)/g, '').split(/\s*[()]\s*/).filter(Boolean));
const coordinate = v => v != null && Number.isFinite(Number(v)) ? Number(v) : null;
const repairNames = { 2: 'Хорошее состояние', 3: 'Нормальное состояние', 5: 'Плохое состояние', 7: 'Без отделки', 8: 'Строительная отделка' };
const kufarRepairNames = { 1: 'Офисная отделка', 5: 'Под чистовую отделку', 10: 'Требуется капитальный ремонт', 15: 'Требуется косметический ремонт' };
export function commercialMatches(item, selected) {
  if (item.propertyType !== 'commercial' || !['realt', 'kufar'].includes(item.key?.split(':')[0])) return false;
  if (selected.commercialFinish !== 'any' && item.finish !== selected.commercialFinish) return false;
  if (selected.areaMin === null && selected.areaMax === null) return true;
  const low = positive(item.areaMin), high = positive(item.areaMax);
  return low !== null && high !== null && low <= high &&
    (selected.areaMin === null || high >= selected.areaMin) && (selected.areaMax === null || low <= selected.areaMax);
}
export function commercialRealt(raw, slug = 'offices') {
  if (!REALT_COMMERCIAL.includes(slug)) throw Error('Unknown Realt category');
  const match = raw.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) throw Error('Realt page format changed');
  const props = JSON.parse(match[1])?.props?.pageProps;
  if (!Array.isArray(props?.objects) || !props.pagination) throw Error('Realt data missing');
  const page = Number(props.pagination.page) || 1;
  const multiplier = positive(props.firstPageSizeMultiplier) || 1;
  const perPage = (positive(props.pagination.pageSize) || 30) / (page === 1 ? multiplier : 1);
  const total = Number(props.pagination.totalCount);
  const links = new Map([...raw.matchAll(/href="(\/(?:[\w-]+\/)?rent-[\w-]+\/object\/(\d+)\/)"/g)].map(m => [m[2], m[1]]));
  const route = { storages: 'pomeschenie', production: 'proizvodstvo' }[slug] || slug;
  return {
    items: props.objects.flatMap(x => {
      if (!x.code) return [];
      const area = positive(x.areaTotal), low = positive(x.areaMin) || area, high = positive(x.areaMax) || area || low;
      const money = (field, rates, currency) => x.priceCurrency === Number(currency) ? positive(x[field]) : positive(x[rates]?.[currency]);
      return [{ propertyType: 'commercial', key: `realt:${x.code}`,
        url: `https://realt.by${links.get(String(x.code)) || `/rent-${route}/object/${x.code}/`}`,
        address: [x.townName, x.streetName, x.houseNumber].filter(Boolean).join(', ') || x.address || 'Адрес не указан',
        city: x.townName || null, region: x.stateRegionName || null, rayon: x.stateDistrictName || null,
        latitude: coordinate(x.location?.[1]), longitude: coordinate(x.location?.[0]),
        areaMin: low, areaMax: high, finish: [2, 3].includes(x.repairState) ? 'finished' : [7, 8].includes(x.repairState) ? 'unfinished' : 'unknown',
        finishLabel: repairNames[x.repairState] || 'Не указана',
        byn: money('price', 'priceRates', '933'), usd: money('price', 'priceRates', '840'),
        pricePerM2Byn: money('pricePerM2', 'priceRatesPerM2', '933'),
        pricePerM2Usd: money('pricePerM2', 'priceRatesPerM2', '840'),
        publishedAt: x.createdAt, photo: typeof x.images?.[0] === 'string' ? x.images[0] : null,
        metroNames: metroNames(x.metroStationName),
      }];
    }), total,
    lastPage: Math.max(1, 1 + Math.ceil(Math.max(0, total - perPage * multiplier) / perPage)),
  };
}
export function commercialKufar(data) {
  if (!Array.isArray(data.ads) || !Array.isArray(data.pagination?.pages)) throw Error('Kufar format changed');
  return { items: data.ads.flatMap(x => {
    if (String(x.category) !== '1050' || !x.ad_id || x.type !== 'let') return [];
    const parameters = x.ad_parameters || [], attrs = Object.fromEntries(parameters.map(p => [p.p, p.v]));
    const display = name => parameters.find(p => p.p === name)?.vl;
    const account = Object.fromEntries((x.account_parameters || []).map(p => [p.p, p.v]));
    const size = positive(attrs.size), repair = positive(attrs.commercial_repair), improvements = attrs.commercial_improvements || [];
    const first = x.images?.[0], metro = display('metro');
    const region = display('region'), area = display('area');
    return [{ propertyType: 'commercial', key: `kufar:${x.ad_id}`, url: x.ad_link,
      address: account.address || x.subject || 'Адрес не указан',
      city: region === 'Минск' ? 'Минск' : area || null, region: region || null,
      rayon: typeof area === 'string' && area.endsWith(' район') ? area : null,
      latitude: coordinate(attrs.coordinates?.[1]), longitude: coordinate(attrs.coordinates?.[0]),
      areaMin: size, areaMax: size,
      finish: repair === 1 ? 'finished' : repair === 5 ? 'unfinished' : repair ? 'unknown' : improvements.some(v => Number(v) === 5) ? 'finished' : 'unknown',
      finishLabel: kufarRepairNames[repair] || (improvements.some(v => Number(v) === 5) ? 'С отделкой' : 'Не указана'),
      byn: positive(x.price_byn) === null ? null : Number(x.price_byn) / 100,
      usd: positive(x.price_usd) === null ? null : Number(x.price_usd) / 100,
      pricePerM2Byn: positive(x.calculator?.find(v => v.currency === 'BYN')?.price_per_meter) === null ? null : Number(x.calculator.find(v => v.currency === 'BYN').price_per_meter) / 100,
      pricePerM2Usd: positive(x.calculator?.find(v => v.currency === 'USD')?.price_per_meter) === null ? null : Number(x.calculator.find(v => v.currency === 'USD').price_per_meter) / 100,
      publishedAt: x.list_time,
      photo: first?.media_storage === 'rms' && /^adim1\/[\w./-]+\.jpe?g$/i.test(first.path) ? `https://rms.kufar.by/v1/gallery/${first.path}` : null,
      metroNames: metroNames(metro),
    }];
  }), next: data.pagination.pages.find(p => p.label === 'next')?.token || null };
}
export const commercialArea = item => item.areaMin == null ? 'Площадь не указана' : item.areaMax && item.areaMax !== item.areaMin ? `${item.areaMin}–${item.areaMax} м²` : `${item.areaMin} м²`;
export function commercialPrice(item) {
  const format = (byn, usd) => [positive(byn) && `${byn} BYN`, positive(usd) && `$${usd}`].filter(Boolean).join(' / ');
  const total = format(item.byn, item.usd), unit = format(item.pricePerM2Byn, item.pricePerM2Usd);
  return [total && `${total} в месяц`, unit && `${unit} за м² в месяц`].filter(Boolean).join('; ') || 'Цена по запросу';
}
