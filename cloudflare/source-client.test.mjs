import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchListing, kufarWebData } from './source-client.mjs';
import { commercialKufar } from './commercial.mjs';
const endpoint='https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=1050&typ=let&size=100';
const ad={category:1050,type:'let',ad_id:1,ad_link:'https://re.kufar.by/vi/1',ad_parameters:[]};
const page=(token='web-next')=>'<script id="__NEXT_DATA__">'+JSON.stringify({props:{initialState:{listing:{ads:[ad],pagination:token?[{label:'next',token}]:[]}}}})+'</script>';
test('blocked Kufar API falls back to public web data and keeps pagination on the same transport',async t=>{
 const requests=[];t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));return String(url).includes('api.kufar.by')?new Response('',{status:403}):new Response(page());});
 const first=await fetchListing(endpoint,commercialKufar);assert.equal(first.items.length,1);assert.equal(first.transport,'web');assert.equal(first.next,'web:web-next');
 await fetchListing(endpoint+'&cursor='+encodeURIComponent(first.next),commercialKufar);
 assert.equal(requests.length,3);assert.equal(new URL(requests[2]).hostname,'re.kufar.by');assert.equal(new URL(requests[2]).searchParams.get('cursor'),'web-next');
});
test('API-to-web fallback resets pagination instead of reusing an incompatible API cursor',async t=>{
 const requests=[];t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));return String(url).includes('api.kufar.by')?new Response('',{status:403}):new Response(page(null));});
 const result=await fetchListing(endpoint+'&cursor=api-page-5',commercialKufar);
 assert.equal(new URL(requests[1]).searchParams.has('cursor'),false);assert.equal(result.next,null);
});
test('rate limits and Retry-After are respected without immediate fallback requests',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'120'}});});
 const result=await fetchListing(endpoint,commercialKufar);assert.equal(result.unavailable.status,429);assert.equal(result.unavailable.retryAfter,120000);assert.equal(calls,1);
});
test('transient server errors can be retried but access-denied responses fail without repeated requests',async t=>{
 let status=503,calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('',{status});});
 await assert.rejects(fetchListing('https://realt.by/belarus/rent/services/',()=>({items:[]}),true),/Source HTTP 503/);
 status=403;const result=await fetchListing('https://realt.by/belarus/rent/services/',()=>({items:[]}),true);assert.equal(result.unavailable.status,403);assert.equal(calls,2);
 assert.throws(()=>kufarWebData('<html>Forbidden</html>'),/format/);assert.throws(()=>kufarWebData('<script id="__NEXT_DATA__">{"props":{}}</script>'),/data missing/);
});
