# Apartment monitor

Checks Onlíner, Realt and Kufar for newly published long-term rental apartments in Minsk and sends matches to a private Telegram chat. The configured search covers a **3 km straight-line radius around Ploshcha Yakuba Kolasa metro station** and listings at **$500 USD per month or less**, with any room count. These coordinates are an approximate station center, not the verified location of the Rassvetay studio. Listing feeds provide USD conversions; the monitor does not rely on a hard-coded exchange rate. It remembers sent listing IDs.

Only listings with publication timestamps in the selected half-open Minsk-time interval are sent:

Each Telegram listing includes the first photo with address, monthly price, room count and a direct link. If the listing has no accessible photo, the same information is sent as text.

| Scan | Publication interval |
| --- | --- |
| 09:00 | Previous day 22:00 to 09:00 |
| 14:00 | 09:00 to 14:00 |
| 22:00 | 14:00 to 22:00 |

Each completed check sends one heading with the exact Minsk-time publication period and the number of new listings (or that there were none), followed by the individual listings. The Cloudflare D1 `covered_until` cursor advances after all three sources succeed. A button press scans from the last completed boundary until now; the next scheduled check resumes from that point.

A manual `--window current` run uses the evening interval ending at the current time (or at 22:00 if run later); when a saved boundary exists, it resumes from that boundary without repeating delivered IDs.

## Configuration

`PRICE_MAX_USD`: maximum monthly rent in US dollars. For another search, `PRICE_MAX_BYN` is also supported, and can be combined with the USD cap.

`ROOMS`: comma-separated numbers, e.g. `1,2`, or blank for any room count. The current search allows all counts.

`SEARCH_CENTER_LAT`, `SEARCH_CENTER_LON`, `SEARCH_RADIUS_KM`: center and straight-line radius. The current center is the metro station, approximately `53.915833, 27.583333`, with a radius of `3`. If a precise studio address is provided, replace the center coordinates. Alternatively, `AREA_POLYGON` accepts a JSON array of map corners in `[longitude,latitude]` order. Apartments without coordinates are skipped.

`TELEGRAM_BOT_TOKEN`: secret from BotFather. `TELEGRAM_CHAT_ID`: the numeric ID of your own private chat after you send `/start` to the bot; this differs from the bot's own ID. If your bot manager shows a list of registered users, you may find your Telegram user/chat ID there. Otherwise obtain it privately through the Telegram Bot API. Do not post the token publicly or commit it to GitHub. Send `/start` in the private chat with the bot. It displays a persistent one-button keyboard («🔄 Проверить новые квартиры») below the input field; pressing it scans from the last completed check and advances the next scheduled window. The keyboard is also attached to each interval heading. Telegram does not support reply keyboards in broadcast channels.

## Free Cloudflare deployment

The active bot runs on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with a free D1 database and a Workflow. Worker Cron starts checks at **09:00, 14:00 and 22:00 Minsk time** (06:00, 11:00 and 19:00 UTC). Telegram sends button presses to the protected Worker webhook. Each check reads from the last successfully completed interval boundary, filters publication timestamps and remembers sent listing IDs in D1. A failed source keeps the boundary unchanged so a later check can catch up. Listings removed in the meantime cannot be recovered.

The repository keeps `.github/workflows/monitor.yml` for an emergency manual run; its GitHub schedule is disabled. Running that legacy workflow uses the separate `state.json` cursor, so it may duplicate messages sent by Cloudflare. Use the Telegram button for normal manual checks.

To configure or redeploy, add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `CLOUDFLARE_API_TOKEN` as repository Actions secrets, and `CLOUDFLARE_ACCOUNT_ID` as an Actions variable. The Cloudflare token needs Workers Scripts Edit and D1 Edit permissions. The [deployment workflow](.github/workflows/deploy-cloudflare.yml) creates D1 if necessary, deploys the Worker and Workflow, configures secrets, and installs the Telegram webhook. Pushes to `cloudflare/**` deploy automatically. No payment method or paid Workflow schedule is required; Cron is attached to the Worker. The free plan has usage limits, and source sites can temporarily reject server requests.

## Local / Debian deployment

Copy `.env.example` to `.env`, fill the two Telegram values (and adjust the search if desired), then run `docker compose up -d --build`. The container checks every day at **09:00, 14:00 and 22:00 Minsk time**. The JSON state file persists in `./data` via a bind mount. Run `docker compose logs -f monitor` to check results. To inspect an interval without changing state or sending messages: `docker compose run --rm monitor python monitor.py --dry-run --window evening`.

Without Docker, install `requirements.txt`, export the same environment variables, then run `python scheduler.py` as a systemd service. Run `python monitor.py --dry-run --window evening` first to verify your area.

## Operational limits

All three sites use undocumented listing data formats that can change. A failed provider makes the job fail after completed sources are processed. Realt's default sort is not strictly by creation date, so the monitor scans all result pages (up to 100) on each run. Onlíner and Kufar sort by listing time and stop at older listings (up to 30 and 100 pages respectively). Site access can be rate limited or blocked from a particular host. An interruption between Telegram delivery and committing `state.json` can result in one duplicate. Apartments newly posted and removed between two checks cannot be found later.
