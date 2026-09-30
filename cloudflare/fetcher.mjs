// Private Service Binding target: one external listing page per invocation.
const sources = new Map([
  ['ak.api.onliner.by', '/search/apartments'],
  ['realt.by', '/rent/flat-for-long/'],
  ['api.kufar.by', '/search-api/v2/search/rendered-paginated'],
]);

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('Missing URL', { status: 400 });
    let url;
    try { url = new URL(target); } catch { return new Response('Invalid URL', { status: 400 }); }
    if (url.protocol !== 'https:' || sources.get(url.hostname) !== url.pathname || url.port || url.username || url.password)
      return new Response('Source not permitted', { status: 403 });
    const headers = url.hostname === 'api.kufar.by' ? {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      Accept: 'application/json', Referer: 'https://re.kufar.by/',
    } : { 'User-Agent': 'ApartmentMonitor/1.0 (personal rental alerts)', Accept: 'application/json,text/html' };
    return fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  },
};
