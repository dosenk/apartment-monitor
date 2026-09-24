import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import monitor


class MonitorTests(unittest.TestCase):
    def test_parse_onliner_price_date_and_rooms(self):
        item = {"id": 42, "price": {"converted": {"BYN": {"amount": "1500.00"}, "USD": {"amount": "490.00"}}},
                "rent_type": "2_rooms", "location": {"user_address": "Минск", "latitude": 53.9, "longitude": 27.6},
                "created_at": "2026-09-24T09:00:00+03:00", "url": "https://r.onliner.by/ak/apartments/42"}
        apartment = monitor.parse_onliner({"apartments": [item]})[0]
        self.assertEqual((apartment.key, apartment.price_byn, apartment.rooms), ("onliner:42", 1500, 2))
        self.assertEqual(apartment.price_usd, 490)

    def test_parse_realt_conversion_and_link(self):
        item = {"code": 99, "price": 700, "priceCurrency": 840, "priceRates": {"933": 1990, "840": 700},
                "address": "Минск", "rooms": 2, "location": [27.6, 53.9],
                "createdAt": "2026-09-24T09:00:00+03:00"}
        payload = {"props": {"pageProps": {"objects": [item], "pagination": {"totalCount": 1}}}}
        page = '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(payload) + '</script>'
        apartments, total = monitor.parse_realt(page)
        self.assertEqual(total, 1)
        self.assertEqual((apartments[0].price_byn, apartments[0].price_usd), (1990, 700))
        self.assertEqual(apartments[0].url, "https://realt.by/rent-flat-for-long/object/99/")

    def test_polygon_and_filters(self):
        polygon = [[27.5, 53.8], [27.7, 53.8], [27.7, 54], [27.5, 54]]
        item = monitor.Apartment("realt", "99", "url", "Минск", 1700, 2, 53.9, 27.6, datetime.now(timezone.utc), 490)
        self.assertTrue(monitor.matches(item, 500, None, {2}, polygon, None, None))
        self.assertFalse(monitor.matches(item, 480, None, {2}, polygon, None, None))
        self.assertFalse(monitor.matches(item, 500, None, {1}, polygon, None, None))
        self.assertFalse(monitor.inside_polygon(54.1, 27.6, polygon))
        self.assertTrue(monitor.matches(item, 500, None, set(), None, (53.9, 27.6), 3))
        self.assertFalse(monitor.matches(item, 500, None, set(), None, (53.95, 27.6), 3))

    def test_sqlite_seen_survives_reopen(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {"SQLITE_PATH": temp + "/history.db"}, clear=True):
                first = monitor.Store()
                first.add("onliner:42")
                first.db.close()
                second = monitor.Store()
                self.assertTrue(second.has("onliner:42"))
                self.assertFalse(second.has("onliner:43"))
                second.db.close()


if __name__ == "__main__":
    unittest.main()
