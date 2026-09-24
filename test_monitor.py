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

    def test_seen_state_survives_reopen(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {"STATE_PATH": temp + "/state.json"}, clear=True):
                first = monitor.Store()
                first.add("onliner:42")
                first.touch()
                second = monitor.Store()
                self.assertTrue(second.has("onliner:42"))
                self.assertFalse(second.has("onliner:43"))
                self.assertIsNotNone(second.checked_at)

    def test_morning_reports_no_new_only_after_both_sources_succeed(self):
        item = monitor.Apartment("onliner", "42", "https://r.onliner.by/ak/apartments/42",
                                 "Минск", 1400, 1, 53.915, 27.583,
                                 datetime.now(timezone.utc), 450)
        with tempfile.TemporaryDirectory() as temp:
            env = {"STATE_PATH": temp + "/state.json", "TELEGRAM_BOT_TOKEN": "test",
                   "TELEGRAM_CHAT_ID": "123", "PRICE_MAX_USD": "500",
                   "SEARCH_CENTER_LAT": "53.915833", "SEARCH_CENTER_LON": "27.583333",
                   "SEARCH_RADIUS_KM": "3", "SEND_EMPTY_STATUS": "true"}
            with patch.dict(os.environ, env, clear=True), patch("sys.argv", ["monitor.py"]), \
                    patch.object(monitor, "telegram_send"), patch.object(monitor, "telegram_send_text") as status:
                store = monitor.Store()
                store.add("bootstrap:onliner")
                store.add("bootstrap:realt")
                store.add(item.key)
                with patch.object(monitor, "fetch_onliner", return_value=[item]), \
                        patch.object(monitor, "fetch_realt", return_value=[]):
                    monitor.main()
                    status.assert_called_once()
                    self.assertIn("Новых объявлений нет", status.call_args.args[2])
                status.reset_mock()
                with patch.object(monitor, "fetch_onliner", return_value=[item]), \
                        patch.object(monitor, "fetch_realt", side_effect=RuntimeError("site unavailable")):
                    monitor.main()
                    status.assert_called_once()
                    self.assertIn("неполный", status.call_args.args[2])


if __name__ == "__main__":
    unittest.main()
