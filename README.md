# Apartment monitor

Checks Onlíner, Realt and Kufar for newly published long-term rental apartments in Minsk. Search preferences are saved from the bot's Telegram menu for the configured chat ID. No price or radius is preset; sent listing IDs are remembered in Cloudflare D1.

Only listings with publication timestamps in the selected half-open Minsk-time interval are sent:

Each Telegram listing includes the first photo with address, monthly price, room count and a direct link. If the listing has no accessible photo, the same information is sent as text.

| Scan | Publication interval |
| --- | --- |
| 09:00 | Previous day 22:00 to 09:00 |
| 14:00 | 09:00 to 14:00 |
| 22:00 | 14:00 to 22:00 |

Each completed check sends one heading with the exact Minsk-time publication period and the number of new listings (or that there were none), followed by the individual listings. The Cloudflare D1 `covered_until` cursor advances after all three sources succeed. A button press scans from the last completed boundary until now; the next scheduled check resumes from that point.

## Search settings in Telegram

Send `/start` to the bot in your private chat. The persistent keyboard has **🔄 Проверить новые квартиры** and **⚙️ Настройки поиска**. Open settings to edit a draft:

- **🚇 Станции Realt + Kufar:** select one or several individual metro stations using the checkbox buttons. With none selected, these sites are not limited by metro.
- **🚇 Линии Onliner:** select one or several of the three lines, or **Возле метро**. Onliner listing data has no station field in this integration, so the line is inferred from the closest station to the listing coordinates. **Возле метро** means within 1 km of the nearest station when no custom radius is set.
- **💰 Цена, BYN:** reply with a monthly ceiling in Belarusian rubles. Enter `0` to remove the ceiling.
- **📏 Радиус, км:** reply with a distance in kilometers. Enter `0` to leave it unset. If selected metro stations exist, the radius is measured from those stations; otherwise it is measured from Ploshcha Yakuba Kolasa. Onliner line selection uses the distance from the closest station.

Press **✅ Применить** to save the draft for your chat. **Отмена** discards it. You can return to the menu at any time to change the settings. Until the first application, scheduled and manual checks wait without advancing the publication cursor. Once applied, both the button and the 09:00/14:00/22:00 scheduled checks use the saved settings. Already delivered listing IDs are not resent when filters change.

`TELEGRAM_BOT_TOKEN` is the BotFather secret. `TELEGRAM_CHAT_ID` is the numeric ID of the chat allowed to configure and receive alerts; it differs from the bot ID. Keep both as repository Actions secrets, never commit them. Telegram's reply keyboard is available in a private chat with the bot, not a broadcast channel.

## Free Cloudflare deployment

The active bot runs on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with a free D1 database and a Workflow. Worker Cron starts checks at **09:00, 14:00 and 22:00 Minsk time** (06:00, 11:00 and 19:00 UTC). Telegram sends button presses to the protected Worker webhook. Each check reads from the last successfully completed interval boundary, filters publication timestamps and remembers sent listing IDs in D1. A failed source keeps the boundary unchanged so a later check can catch up. Listings removed in the meantime cannot be recovered.

The repository keeps `.github/workflows/monitor.yml` for an emergency manual run; its GitHub schedule is disabled. Running that legacy workflow uses the separate `state.json` cursor, so it may duplicate messages sent by Cloudflare. Use the Telegram button for normal manual checks.

To configure or redeploy, add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `CLOUDFLARE_API_TOKEN` as repository Actions secrets, and `CLOUDFLARE_ACCOUNT_ID` as an Actions variable. The Cloudflare token needs Workers Scripts Edit and D1 Edit permissions. The [deployment workflow](.github/workflows/deploy-cloudflare.yml) creates D1 if necessary, deploys the Worker and Workflow, configures secrets, and installs the Telegram webhook. Pushes to `cloudflare/**` deploy automatically. No payment method or paid Workflow schedule is required; Cron is attached to the Worker. The free plan has usage limits, and source sites can temporarily reject server requests.

## Local / Debian deployment

Copy `.env.example` to `.env`, fill the two Telegram values (and adjust the search if desired), then run `docker compose up -d --build`. The container checks every day at **09:00, 14:00 and 22:00 Minsk time**. The JSON state file persists in `./data` via a bind mount. Run `docker compose logs -f monitor` to check results. To inspect an interval without changing state or sending messages: `docker compose run --rm monitor python monitor.py --dry-run --window evening`.

Without Docker, install `requirements.txt`, export the same environment variables, then run `python scheduler.py` as a systemd service. Run `python monitor.py --dry-run --window evening` first to verify your area.

## Operational limits

All three sites use undocumented listing data formats that can change. A failed provider makes the job fail after completed sources are processed. Realt's default sort is not strictly by creation date, so the monitor scans all result pages (up to 100) on each run. Onlíner and Kufar sort by listing time and stop at older listings (up to 30 and 100 pages respectively). Site access can be rate limited or blocked from a particular host. An interruption between Telegram delivery and recording an ID in D1 can result in one duplicate. Apartments newly posted and removed between two checks cannot be found later.
