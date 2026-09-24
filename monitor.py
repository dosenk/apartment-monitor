"""Three-times-daily Minsk long-term rental monitor.

Configuration is read from environment variables; see README.md.
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import math
import os
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

LOG = logging.getLogger("apartments")
USER_AGENT = "ApartmentMonitor/1.0 (personal rental alerts)"
ONLINER = "https://ak.api.onliner.by/search/apartments"
REALT = "https://realt.by/rent/flat-for-long/"
NEXT_DATA = re.compile(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


@dataclass(frozen=True)
class Apartment:
    source: str
    external_id: str
    url: str
    address: str
    price_byn: float
    rooms: int | None
    latitude: float | None
    longitude: float | None
    published_at: datetime
    price_usd: float | None = None

    @property
    def key(self) -> str:
        return f"{self.source}:{self.external_id}"


def get(url: str, timeout: int = 25) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json,text/html"})
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8")
        except Exception as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Cannot retrieve {url}: {last_error}")


def parse_onliner(payload: dict) -> list[Apartment]:
    result = []
    for item in payload.get("apartments", []):
        try:
            loc = item.get("location") or {}
            price = item["price"]["converted"]["BYN"]["amount"]
            room = item.get("rent_type", "")
            rooms = int(room.split("_")[0]) if re.match(r"^\d+_rooms?$", room) else None
            result.append(Apartment("onliner", str(item["id"]), item["url"],
                loc.get("user_address") or loc.get("address") or "Минск",
                float(price), rooms, loc.get("latitude"), loc.get("longitude"),
                datetime.fromisoformat(item["created_at"]),
                float(item["price"]["converted"]["USD"]["amount"])))
        except (KeyError, TypeError, ValueError) as exc:
            LOG.warning("Skipped malformed Onliner listing: %s", exc)
    return result


def parse_realt(page_html: str) -> tuple[list[Apartment], int]:
    match = NEXT_DATA.search(page_html)
    if not match:
        raise ValueError("Realt page has no __NEXT_DATA__; site layout may have changed")
    props = json.loads(html.unescape(match.group(1)))["props"]["pageProps"]
    if "objects" not in props or "pagination" not in props:
        raise ValueError("Realt listing data missing; site layout may have changed")
    result = []
    for item in props["objects"]:
        try:
            location = item.get("location") or []
            rates = item.get("priceRates") or {}
            price = rates.get("933") if item.get("priceCurrency") != 933 else item.get("price")
            usd = rates.get("840") if item.get("priceCurrency") != 840 else item.get("price")
            if price is None or usd is None:
                continue
            result.append(Apartment("realt", str(item["code"]),
                f"https://realt.by/rent-flat-for-long/object/{item['code']}/",
                item.get("address") or "Минск", float(price), item.get("rooms"),
                location[1] if len(location) == 2 else None,
                location[0] if len(location) == 2 else None,
                datetime.fromisoformat(item["createdAt"]), float(usd)))
        except (KeyError, TypeError, ValueError) as exc:
            LOG.warning("Skipped malformed Realt listing: %s", exc)
    return result, int(props["pagination"]["totalCount"])


def fetch_onliner(cutoff: datetime, max_pages: int = 30) -> list[Apartment]:
    params = [("rent_type[]", t) for t in ("1_room", "2_rooms", "3_rooms", "4_rooms", "5_rooms", "6_rooms")]
    params.append(("order", "created_at:desc"))
    listings = []
    for page in range(1, max_pages + 1):
        url = ONLINER + "?" + urllib.parse.urlencode(params + [("page", page)])
        data = json.loads(get(url))
        parsed = parse_onliner(data)
        listings.extend(item for item in parsed if item.published_at >= cutoff)
        if not parsed or page >= data["page"]["last"] or min(a.published_at for a in parsed) < cutoff:
            break
        time.sleep(0.2)
    else:
        LOG.warning("Onliner page limit reached; some new listings may be missed")
    return listings


def fetch_realt(cutoff: datetime, max_pages: int = 55) -> list[Apartment]:
    listings = []
    page = 1
    while page <= max_pages:
        url = REALT if page == 1 else REALT + "?page=" + str(page)
        parsed, total = parse_realt(get(url))
        listings.extend(item for item in parsed if item.published_at >= cutoff)
        # Page 1 contains 90 cards; ?page=2 corresponds to backend page 4.
        # Public page numbers still advance by one on each subsequent request.
        page += 1
        if not parsed or page > math.ceil(total / 30) - 2:
            break
        time.sleep(0.2)
    if page > max_pages:
        LOG.warning("Realt page limit reached; some new listings may be missed")
    return listings


def inside_polygon(lat: float, lon: float, polygon: list[list[float]]) -> bool:
    """Ray casting; vertices are [longitude, latitude] as in GeoJSON."""
    inside = False
    for i, (x1, y1) in enumerate(polygon):
        x2, y2 = polygon[(i + 1) % len(polygon)]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two WGS84 points."""
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def matches(item: Apartment, max_price_usd: float | None, max_price_byn: float | None,
            rooms: set[int], polygon: list[list[float]] | None,
            center: tuple[float, float] | None, radius_km: float | None) -> bool:
    if item.latitude is None or item.longitude is None:
        return False
    if max_price_usd is not None and (item.price_usd is None or item.price_usd > max_price_usd):
        return False
    if max_price_byn is not None and item.price_byn > max_price_byn:
        return False
    if rooms and item.rooms not in rooms:
        return False
    if center is not None and radius_km is not None:
        return distance_km(item.latitude, item.longitude, *center) <= radius_km
    return polygon is not None and inside_polygon(item.latitude, item.longitude, polygon)


class Store:
    def __init__(self):
        self.path = Path(os.environ.get("STATE_PATH", "state.json"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.seen = set(data.get("seen", []))
        self.checked_at = data.get("checked_at")

    def has(self, key: str) -> bool:
        return key in self.seen

    def add(self, key: str):
        self.seen.add(key)
        self.save()

    def touch(self):
        self.checked_at = datetime.now(timezone.utc).isoformat()
        self.save()

    def save(self):
        temp = self.path.with_name(self.path.name + ".tmp")
        temp.write_text(json.dumps({"checked_at": self.checked_at, "seen": sorted(self.seen)},
                                   ensure_ascii=False, indent=2) + "\n")
        temp.replace(self.path)


def telegram_send(token: str, chat_id: str, item: Apartment):
    message = (f"🏠 {item.rooms or '?'} комн. · {html.escape(item.source.title())}\n"
        f"📍 {html.escape(item.address)}\n"
        f"💰 ${item.price_usd:g} / {item.price_byn:g} BYN в месяц\n"
        f"🔗 {html.escape(item.url)}")
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": message, "parse_mode": "HTML", "disable_web_page_preview": "true"}).encode()
    request = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError("Telegram rejected message")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Fetch/filter and print listings without sending or saving")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    max_price_usd = float(os.environ["PRICE_MAX_USD"]) if os.environ.get("PRICE_MAX_USD") else None
    max_price_byn = float(os.environ["PRICE_MAX_BYN"]) if os.environ.get("PRICE_MAX_BYN") else None
    if max_price_usd is None and max_price_byn is None:
        raise ValueError("Set PRICE_MAX_USD or PRICE_MAX_BYN")
    rooms = {int(x.strip()) for x in os.environ.get("ROOMS", "").split(",") if x.strip()}
    polygon = json.loads(os.environ["AREA_POLYGON"]) if os.environ.get("AREA_POLYGON") else None
    if polygon and (len(polygon) < 3 or any(len(p) != 2 for p in polygon)):
        raise ValueError("AREA_POLYGON must contain at least 3 [longitude,latitude] pairs")
    center = ((float(os.environ["SEARCH_CENTER_LAT"]), float(os.environ["SEARCH_CENTER_LON"]))
              if os.environ.get("SEARCH_CENTER_LAT") and os.environ.get("SEARCH_CENTER_LON") else None)
    radius_km = float(os.environ["SEARCH_RADIUS_KM"]) if os.environ.get("SEARCH_RADIUS_KM") else None
    if (center is None or radius_km is None) and polygon is None:
        raise ValueError("Set center + radius or AREA_POLYGON")
    if radius_km is not None and radius_km <= 0:
        raise ValueError("SEARCH_RADIUS_KM must be positive")
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not args.dry_run and (not token or not chat_id):
        raise ValueError("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required")
    store = None if args.dry_run else Store()
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    successes = 0
    for source, fetch in (("onliner", fetch_onliner), ("realt", fetch_realt)):
        try:
            entries = fetch(cutoff)
            successes += 1
        except Exception:
            LOG.exception("Failed to fetch %s", source)
            continue
        filtered = sorted((a for a in entries if matches(a, max_price_usd, max_price_byn, rooms, polygon, center, radius_km)), key=lambda a: a.published_at)
        LOG.info("%s: fetched %d recent, %d match", source, len(entries), len(filtered))
        if args.dry_run:
            for item in filtered:
                print(f"{item.key} | ${item.price_usd:g} | {item.price_byn:g} BYN | {item.address} | {item.url}")
            continue
        bootstrapped = store.has("bootstrap:" + source)
        for item in filtered:
            if store.has(item.key):
                continue
            if bootstrapped:
                telegram_send(token, chat_id, item)
                LOG.info("Sent %s", item.key)
            store.add(item.key)
        if not bootstrapped:
            store.add("bootstrap:" + source)
            LOG.info("Initialized %s baseline; future new listings will be sent", source)
    if successes == 0:
        raise SystemExit("Both sources failed")
    if store is not None:
        store.touch()


if __name__ == "__main__":
    main()
