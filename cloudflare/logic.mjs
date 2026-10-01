import { matchesMetro } from './metro.mjs';

export const CENTER = [53.915833, 27.583333];
export const BUTTON = "🔄 Проверить новые квартиры";
const MINSK_OFFSET = 3 * 60 * 60 * 1000;

export function interval(kind, now, cursor = null) {
  const timestamp = new Date(now).getTime();
  const local = new Date(timestamp + MINSK_OFFSET);
  const date = (hour) => Date.UTC(local.getUTCFullYear(), local.getUTCMonth(),
    local.getUTCDate(), hour - 3);
  let end = timestamp;
  let start;
  if (kind === "morning" || kind === "midday" || kind === "evening") {
    const hour = { morning: 9, midday: 14, evening: 22 }[kind];
    const duration = { morning: 11, midday: 5, evening: 8 }[kind];
    end = date(hour);
    if (end > timestamp) end -= 86400000;
    start = end - duration * 3600000;
  } else {
    const hour = local.getUTCHours();
    start = hour >= 22 ? date(22) : hour >= 14 ? date(14) :
      hour >= 9 ? date(9) : date(22) - 86400000;
  }
  if (cursor) start = new Date(cursor).getTime();
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function label(start, end) {
  const format = (stamp) => new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Minsk", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(stamp)).replace(",", "");
  return `с ${format(start)} по ${format(end)}`;
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = x => x * Math.PI / 180;
  const dlat = rad(lat2 - lat1), dlon = rad(lon2 - lon1);
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(rad(lat1)) *
    Math.cos(rad(lat2)) * Math.sin(dlon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export function matches(item, start, end, selected) {
  const time = Date.parse(item.publishedAt);
  const maxByn = preferencesPrice(selected);
  return Number.isFinite(time) && time >= Date.parse(start) && time < Date.parse(end) &&
    (maxByn === null || (Number.isFinite(item.byn) && item.byn <= maxByn)) &&
    matchesMetro(item, selected, distanceKm, CENTER);
}

function preferencesPrice(selected) {
  return Number.isFinite(selected?.maxByn) && selected.maxByn > 0 ? selected.maxByn : null;
}

export function onliner(data) {
  if (!Array.isArray(data.apartments) || !data.page) throw Error("Onliner format changed");
  return {
    items: data.apartments.map(x => {
      try {
        return {
          key: `onliner:${x.id}`, url: x.url,
          address: x.location?.user_address || x.location?.address || "Минск",
          byn: Number(x.price.converted.BYN.amount),
          usd: Number(x.price.converted.USD.amount),
          rooms: /^\d+_rooms?$/.test(x.rent_type) ? Number(x.rent_type.split("_")[0]) : null,
          latitude: Number(x.location?.latitude), longitude: Number(x.location?.longitude),
        publishedAt: x.created_at, photo: x.photo || null,
        };
      } catch { return null; }
    }).filter(Boolean),
    lastPage: Number(data.page.last),
  };
}

export function realt(raw) {
  const match = raw.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) throw Error("Realt page format changed");
  const props = JSON.parse(match[1])?.props?.pageProps;
  if (!Array.isArray(props?.objects) || !props?.pagination) throw Error("Realt data missing");
  return {
    items: props.objects.map(x => {
      const rate = x.priceRates || {};
      const byn = Number(x.priceCurrency === 933 ? x.price : rate["933"]);
      const usd = Number(x.priceCurrency === 840 ? x.price : rate["840"]);
      if (!Number.isFinite(byn) || !Number.isFinite(usd)) return null;
      return {
        key: `realt:${x.code}`,
        url: `https://realt.by/rent-flat-for-long/object/${x.code}/`,
        address: x.address || "Минск", byn, usd, rooms: x.rooms || null,
        latitude: Number(x.location?.[1]), longitude: Number(x.location?.[0]),
        publishedAt: x.createdAt, photo: x.images?.[0] || null,
        metroNames: x.metroStationName ? [x.metroStationName] : [],
      };
    }).filter(Boolean),
    total: Number(props.pagination.totalCount),
  };
}

export function kufar(data) {
  if (!Array.isArray(data.ads) || !data.pagination?.pages) throw Error("Kufar format changed");
  return {
    items: data.ads.map(x => {
      try {
        const attrs = Object.fromEntries((x.ad_parameters || []).map(p => [p.p, p.v]));
        const account = Object.fromEntries((x.account_parameters || []).map(p => [p.p, p.v]));
        const coords = attrs.coordinates;
        if (!Array.isArray(coords) || coords.length !== 2) return null;
        const first = x.images?.[0];
        const photo = first?.media_storage === "rms" && /^adim1\/[\w./-]+\.jpe?g$/i.test(first.path)
          ? `https://rms.kufar.by/v1/gallery/${first.path}` : null;
        return {
          key: `kufar:${x.ad_id}`, url: x.ad_link,
          address: account.address || x.subject || "Минск",
          byn: Number(x.price_byn) / 100, usd: Number(x.price_usd) / 100,
          rooms: /^\d+$/.test(String(attrs.rooms)) ? Number(attrs.rooms) : null,
          latitude: Number(coords[1]), longitude: Number(coords[0]),
          publishedAt: x.list_time, photo,
          metroNames: (() => {
            const names = (x.ad_parameters || []).find(p => p.p === 'metro')?.vl;
            return Array.isArray(names) ? names : names ? [names] : [];
          })(),
        };
      } catch { return null; }
    }).filter(Boolean),
    next: data.pagination.pages.find(p => p.label === "next")?.token || null,
  };
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function caption(item) {
  return `🏠 ${item.rooms || "?"} комн. · ${escapeHtml(item.key.split(":")[0])}\n` +
    `📍 ${escapeHtml(item.address)}\n💰 $${item.usd} / ${item.byn} BYN в месяц\n` +
    `🔗 ${escapeHtml(item.url)}`;
}
