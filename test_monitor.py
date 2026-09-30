import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
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

    def test_kufar_parses_price_location_time_and_direct_link(self):
        listing = {"ad_id": 123, "ad_link": "https://re.kufar.by/vi/123",
                   "list_time": "2026-09-30T15:25:23Z", "price_byn": "140000",
                   "price_usd": "46228", "ad_parameters": [
                       {"p": "rooms", "v": "2"}, {"p": "coordinates", "v": [27.583, 53.915]}],
                   "account_parameters": [{"p": "address", "v": "Минск, ул. Якуба Коласа"}]}
        apartment = monitor.parse_kufar({"ads": [listing], "pagination": {"pages": []}})[0]
        self.assertEqual((apartment.key, apartment.rooms, apartment.price_byn, apartment.price_usd),
                         ("kufar:123", 2, 1400, 462.28))
        self.assertEqual((apartment.latitude, apartment.longitude), (53.915, 27.583))
        self.assertEqual(apartment.url, listing["ad_link"])
        self.assertEqual(apartment.published_at.isoformat(), "2026-09-30T15:25:23+00:00")

    def test_windows_are_adjacent_at_minsk_boundaries(self):
        now = datetime(2026, 9, 30, 20, 0, tzinfo=timezone.utc)
        morning = monitor.window_for("morning", now)
        midday = monitor.window_for("midday", now)
        evening = monitor.window_for("evening", now)
        self.assertEqual(morning, (datetime(2026, 9, 29, 19, tzinfo=timezone.utc),
                                   datetime(2026, 9, 30, 6, tzinfo=timezone.utc)))
        self.assertEqual(midday[0], morning[1])
        self.assertEqual(evening[0], midday[1])
        self.assertEqual(evening[1], datetime(2026, 9, 30, 19, tzinfo=timezone.utc))
        self.assertEqual(monitor.window_for("current", datetime(2026, 9, 30, 14, tzinfo=timezone.utc)),
                         (datetime(2026, 9, 30, 11, tzinfo=timezone.utc),
                          datetime(2026, 9, 30, 14, tzinfo=timezone.utc)))

    def test_sends_only_unseen_ads_published_inside_window(self):
        start = datetime(2026, 9, 30, 11, tzinfo=timezone.utc)
        end = start + timedelta(hours=8)
        def item(source, number, published):
            return monitor.Apartment(source, str(number), "https://example.test/" + str(number),
                                     "Минск", 1400, 1, 53.915, 27.583, published, 450)
        in_window = item("onliner", 42, start)
        at_end = item("onliner", 43, end)
        from_realt = item("realt", 44, start + timedelta(hours=1))
        from_kufar = item("kufar", 45, start + timedelta(hours=2))
        with tempfile.TemporaryDirectory() as temp:
            env = {"STATE_PATH": temp + "/state.json", "TELEGRAM_BOT_TOKEN": "test",
                   "TELEGRAM_CHAT_ID": "123", "PRICE_MAX_USD": "500",
                   "SEARCH_CENTER_LAT": "53.915833", "SEARCH_CENTER_LON": "27.583333",
                   "SEARCH_RADIUS_KM": "3", "WINDOW_KIND": "evening"}
            with patch.dict(os.environ, env, clear=True), patch("sys.argv", ["monitor.py"]), \
                    patch.object(monitor, "window_for", return_value=(start, end)), \
                    patch.object(monitor, "telegram_send") as send, \
                    patch.object(monitor, "fetch_onliner", return_value=[in_window, at_end]), \
                    patch.object(monitor, "fetch_realt", return_value=[from_realt]), \
                    patch.object(monitor, "fetch_kufar", return_value=[from_kufar]):
                monitor.main()
                self.assertEqual([call.args[2].key for call in send.call_args_list],
                                 [in_window.key, from_realt.key, from_kufar.key])
                send.reset_mock()
                monitor.main()
                send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
