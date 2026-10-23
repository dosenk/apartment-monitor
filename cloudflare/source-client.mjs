const AGENT = 'ApartmentMonitor/1.0 (personal rental alerts)';
const HEADERS = { 'User-Agent': AGENT, Accept: 'application/json,text/html' };
function failure(response, transport) {
  const value = response.headers.get('Retry-After');
  const seconds = value === null ? 0 : /^\d+$/.test(value) ? Number(value) : Math.max(0, (Date.parse(value) - Date.now()) / 1000);
  return { unavailable: { status: response.status, transport, retryAfter: Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0 } };
}
const transient = status => status >= 500 || status === 408;
function sourceError(status) { return Error(`Source HTTP ${status}`); }
export function kufarWebData(raw) {
  const match = raw.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) throw Error('Kufar page format changed');
  const listing = JSON.parse(match[1])?.props?.initialState?.listing;
  if (!Array.isArray(listing?.ads) || !Array.isArray(listing?.pagination) || listing.error || listing.isNetworkError) throw Error('Kufar listing data missing');
  return { ads: listing.ads, pagination: { pages: listing.pagination } };
}
async function get(url, headers) { return fetch(url, { headers, signal: AbortSignal.timeout(25000) }); }
export async function fetchListing(url, parser, isHtml = false) {
  const target = new URL(url);
  if (target.hostname !== 'api.kufar.by') {
    const response = await get(url, HEADERS);
    if (!response.ok) {
      if (transient(response.status) && !response.headers.has('Retry-After')) throw sourceError(response.status);
      return failure(response, 'direct');
    }
    return { ...parser(isHtml ? await response.text() : await response.json()), transport: 'direct' };
  }
  const cursor = target.searchParams.get('cursor');
  const webOnly = cursor?.startsWith('web:');
  if (!webOnly) {
    const response = await get(url, { ...HEADERS, Accept: 'application/json', Referer: 'https://re.kufar.by/' });
    if (response.ok) return { ...parser(await response.json()), transport: 'api' };
    if (response.headers.has('Retry-After') || ![403, 500, 502, 503, 504].includes(response.status)) return failure(response, 'api');
  }
  // Reset at page one on switching transport: API and web can use different page sizes.
  // Keep web pagination sticky so a later API recovery cannot jump over web pages.
  const commercial = target.searchParams.get('cat') === '1050';
  const web = new URL(commercial ? 'https://re.kufar.by/l/belarus/snyat/kommercheskaya' : 'https://re.kufar.by/l/belarus/snyat/kvartiru');
  web.searchParams.set('sort', 'lst.d');
  if (webOnly) web.searchParams.set('cursor', cursor.slice(4));
  const response = await get(web.href, HEADERS);
  if (!response.ok) {
    if (transient(response.status) && !response.headers.has('Retry-After')) throw sourceError(response.status);
    return failure(response, 'web');
  }
  const result = parser(kufarWebData(await response.text()));
  return { ...result, next: result.next ? `web:${result.next}` : null, transport: 'web' };
}
export async function sourceHealth(source, parsers) {
  if (source === 'kufar') return fetchListing('https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=1050&typ=let&size=10&sort=lst.d&lang=ru', parsers.kufar);
  const slug = source.slice(6);
  if (!source.startsWith('realt-') || !parsers.categories.includes(slug)) return null;
  return fetchListing(`https://realt.by/belarus/rent/${slug}/`, raw => parsers.realt(raw, slug), true);
}
