"""Build the bot's oblast/rayon/settlement directory from public factual data."""
import collections
import json
import math
import re
import urllib.request
from pathlib import Path

URL = 'https://raw.githubusercontent.com/jug-it/geolocation-cities/master/coord_cities_belarus.sql'
OBLASTS = ['БРЕСТСКАЯ ОБЛАСТЬ', 'ВИТЕБСКАЯ ОБЛАСТЬ', 'ГОМЕЛЬСКАЯ ОБЛАСТЬ',
           'ГРОДНЕНСКАЯ ОБЛАСТЬ', 'МИНСКАЯ ОБЛАСТЬ', 'МОГИЛЕВСКАЯ ОБЛАСТЬ']
DIRECT = [['Брест', 'Барановичи', 'Пинск'], ['Витебск', 'Новополоцк'], ['Гомель'],
          ['Гродно'], ['Минск', 'Жодино'], ['Могилев', 'Бобруйск']]
CAPITAL_COORDS = [(52.0976, 23.7341), (55.1848, 30.2016), (52.4345, 30.9754),
                  (53.6694, 23.8131), (53.9023, 27.5619), (53.9007, 30.3314)]


def build(raw):
    pattern = r"^\s*\(\d+, '([^']*)', '([^']*)', (?:'([^']*)'|NULL), (?:'[^']*'|NULL), '([^']*)', '([^']*)', '([^']*)'"
    rows = []
    for match in re.finditer(pattern, raw, re.M):
        name, oblast, rayon, kind, lat, lon = match.groups()
        if oblast not in OBLASTS:
            continue
        try:
            coords = [float(lat.replace(',', '.')), float(lon.replace(',', '.'))]
        except ValueError:
            continue
        rows.append([name, oblast, rayon, kind, *coords])
    datasets = []
    for i, oblast in enumerate(OBLASTS):
        regional = [r for r in rows if r[1] == oblast]
        rayons = sorted({r[2] for r in regional if r[2] and r[2] not in DIRECT[i]})
        candidates = [r for r in regional if r[2] in rayons and not
            (r[0] in DIRECT[i] and r[3] == 'г.')]
        inferred = []
        for row in regional:
            if row[0] in DIRECT[i] and row[3] == 'г.':
                row[2] = None
            elif not row[2]:
                near = sorted(candidates, key=lambda r: (r[4] - row[4]) ** 2 +
                    ((r[5] - row[5]) * math.cos(math.radians(row[4]))) ** 2)[:12]
                row[2] = collections.Counter(r[2] for r in near).most_common(1)[0][0]
                inferred.append([row[0], row[2]])
        for name in DIRECT[i]:
            if not any(r[0] == name and r[3] == 'г.' for r in regional):
                lat, lon = CAPITAL_COORDS[i] if name == DIRECT[i][0] else (0, 0)
                regional.append([name, oblast, None, 'г.', lat, lon])
        places = sorted({(r[0], r[2], r[3], r[4], r[5]) for r in regional},
                        key=lambda r: (r[0], r[1] or '', r[3], r[4]))
        data = {'rayons': rayons, 'direct': DIRECT[i], 'places': places}
        datasets.append(data)
        print(oblast, 'rayons=', rayons, 'places=', len(places), 'inferred_centres=', inferred)
    return datasets


if __name__ == '__main__':
    req = urllib.request.Request(URL, headers={'User-Agent': 'ApartmentMonitor-directory/1.0'})
    with urllib.request.urlopen(req, timeout=30) as response:
        datasets = build(response.read().decode('utf-8'))
    assert [len(d['rayons']) for d in datasets] == [16, 21, 21, 17, 22, 21], 'Unexpected administrative rayon counts'
    for i, data in enumerate(datasets):
        Path(f'cloudflare/geography-{i}.json').write_text(json.dumps(data, ensure_ascii=False,
            separators=(',', ':')) + '\n')
