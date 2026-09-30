# Apartment monitor

Checks Onlíner, Realt and Kufar for newly published long-term rental apartments in Minsk and sends matches to a private Telegram chat. The configured search covers a **3 km straight-line radius around Ploshcha Yakuba Kolasa metro station** and listings at **$500 USD per month or less**, with any room count. These coordinates are an approximate station center, not the verified location of the Rassvetay studio. Listing feeds provide USD conversions; the monitor does not rely on a hard-coded exchange rate. It remembers sent listing IDs.

Only listings with publication timestamps in the selected half-open Minsk-time interval are sent:

| Scan | Publication interval |
| --- | --- |
| 09:00 | Previous day 22:00 to 09:00 |
| 14:00 | 09:00 to 14:00 |
| 22:00 | 14:00 to 22:00 |

An empty window produces no Telegram message. A manual `--window current` run scans today's 14:00 to the current time (or to 22:00 if it runs later), without repeating IDs already delivered.

## Configuration

`PRICE_MAX_USD`: maximum monthly rent in US dollars. For another search, `PRICE_MAX_BYN` is also supported, and can be combined with the USD cap.

`ROOMS`: comma-separated numbers, e.g. `1,2`, or blank for any room count. The current search allows all counts.

`SEARCH_CENTER_LAT`, `SEARCH_CENTER_LON`, `SEARCH_RADIUS_KM`: center and straight-line radius. The current center is the metro station, approximately `53.915833, 27.583333`, with a radius of `3`. If a precise studio address is provided, replace the center coordinates. Alternatively, `AREA_POLYGON` accepts a JSON array of map corners in `[longitude,latitude]` order. Apartments without coordinates are skipped.

`TELEGRAM_BOT_TOKEN`: secret from BotFather. `TELEGRAM_CHAT_ID`: the numeric ID of your own private chat after you send `/start` to the bot; this differs from the bot's own ID. If your bot manager shows a list of registered users, you may find your Telegram user/chat ID there. Otherwise obtain it privately through the Telegram Bot API. Do not post the token publicly or commit it to GitHub. The bot does not listen for commands; change filters in configuration.

## Free GitHub Actions deployment

This public repository uses standard GitHub-hosted runners, which are free for public repositories. The workflow `.github/workflows/monitor.yml` requests runs at **09:00, 14:00 and 22:00 Minsk time**, and can also be run manually from the **Actions** tab with a selected publishing window. GitHub has delayed this repository's scheduled jobs by hours before, so these are best-effort times; a different free scheduler is needed if the delivery time itself must be reliable. The publishing intervals remain fixed even when GitHub starts a job late.

To activate it without editing code:

1. Open **Settings → Secrets and variables → Actions → New repository secret**.
2. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as two separate repository secrets. Never put either value in a file or commit message.
3. Open **Actions → Check new apartments → Run workflow**, select a window, and inspect the job log for all three source results. A manual `current` scan is intended for the 14:00–22:00 interval.

The workflow writes `state.json` to the repository after each run. It contains sent listing IDs and a last-check timestamp, **not bot credentials**. This repository is public, so the IDs are public as well. Each successful run creates a state commit; this keeps a history of checks and avoids GitHub's 60-day no-activity disabling of scheduled workflows. If a scheduled job is dropped and the next job only scans its own window, listings from the dropped window are missed. This design needs no paid hosting or external database.

## Local / Debian deployment

Copy `.env.example` to `.env`, fill the two Telegram values (and adjust the search if desired), then run `docker compose up -d --build`. The container checks every day at **09:00, 14:00 and 22:00 Minsk time**. The JSON state file persists in `./data` via a bind mount. Run `docker compose logs -f monitor` to check results. To inspect an interval without changing state or sending messages: `docker compose run --rm monitor python monitor.py --dry-run --window evening`.

Without Docker, install `requirements.txt`, export the same environment variables, then run `python scheduler.py` as a systemd service. Run `python monitor.py --dry-run --window evening` first to verify your area.

## Operational limits

All three sites use undocumented listing data formats that can change. A failed provider makes the job fail after completed sources are processed. Realt's default sort is not strictly by creation date, so the monitor scans all result pages (up to 100) on each run. Onlíner and Kufar sort by listing time and stop at older listings (up to 30 and 100 pages respectively). Site access can be rate limited or blocked from a particular host. An interruption between Telegram delivery and committing `state.json` can result in one duplicate. Apartments newly posted and removed between two checks cannot be found later.
