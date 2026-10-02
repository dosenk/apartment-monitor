"""Create the free D1 database and prepare Wrangler config and migration SQL."""
import json
import os
import urllib.request
from pathlib import Path

account = os.environ['CLOUDFLARE_ACCOUNT_ID']
token = os.environ['CLOUDFLARE_API_TOKEN']
base = f'https://api.cloudflare.com/client/v4/accounts/{account}'

def api(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(base + path, data=data, headers={
        'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if not result['success']:
        raise RuntimeError(f'Cloudflare API failed for {path}: {result.get("errors")}')
    return result['result']

dbs = api('/d1/database?name=apartment-monitor-state&per_page=100')
db = next((d for d in dbs if d['name'] == 'apartment-monitor-state'), None)
if db is None:
    db = api('/d1/database', {'name': 'apartment-monitor-state'})
config = {
    'name': 'apartment-monitor-bot',
    'main': 'cloudflare/worker.mjs',
    'compatibility_date': '2026-09-30',
    'workers_dev': True,
    'assets': {'directory': './cloudflare/public', 'binding': 'ASSETS'},
    'vars': {'MINI_APP_URL': 'https://apartment-monitor-bot.' + api('/workers/subdomain')['subdomain'] + '.workers.dev/app/'},
    'd1_databases': [{'binding': 'DB', 'database_name': 'apartment-monitor-state', 'database_id': db['uuid']}],
    'triggers': {'crons': ['*/10 * * * *']},
    'workflows': [{'name': 'apartment-monitor-scan', 'binding': 'SCAN',
                   'class_name': 'ApartmentScan'}],
}
Path('wrangler.jsonc').write_text(json.dumps(config, indent=2) + '\n')
state = json.loads(Path('state.json').read_text()) if Path('state.json').exists() else {}
def quote(value):
    return "'" + str(value).replace("'", "''") + "'"
lines = ['INSERT OR IGNORE INTO sent(key,sent_at) VALUES (' + quote(key) + ", 'migrated');"
         for key in state.get('seen', [])]
if state.get('covered_until'):
    lines.append("INSERT OR IGNORE INTO meta(key,value) VALUES ('covered_until', " + quote(state['covered_until']) + ');')
owner = os.environ['TELEGRAM_CHAT_ID'].strip()
lines.extend([
    'INSERT OR IGNORE INTO bot_users(chat_id,authorized) VALUES (' + quote(owner) + ',1);',
    'INSERT OR IGNORE INTO scan_recipients(run_id,chat_id) SELECT id,' + quote(owner) + ' FROM scan_runs;',
    'INSERT OR IGNORE INTO locks(name,owner,expires) SELECT ' + quote('scan:' + owner) + ",owner,expires FROM locks WHERE name='scan';",
    'INSERT OR IGNORE INTO user_sent(chat_id,key,sent_at) SELECT ' + quote(owner) + ',key,sent_at FROM sent;',
    'INSERT OR IGNORE INTO meta(key,value) SELECT ' + quote('covered_until:' + owner) + ",value FROM meta WHERE key='covered_until';",
])
Path('cloudflare/seed.sql').write_text('\n'.join(lines) + '\n')
print('D1 database and Wrangler config ready; migrated IDs:', len(state.get('seen', [])))
