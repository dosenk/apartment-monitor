# Apartment monitor

Checks Onlíner and Realt for newly published long-term rental apartments in Minsk and sends matches to a private Telegram chat. The configured search covers a **3 km straight-line radius around Ploshcha Yakuba Kolasa metro station** and listings at **$500 USD per month or less**, with any room count. These coordinates are an approximate station center, not the verified location of the Rassvetay studio. The original listing feeds provide their own USD conversions; the monitor does not rely on a hard-coded exchange rate. It remembers listing IDs, so a listing is sent once. The first successful run for each site seeds the baseline without sending old listings. Later runs send only listings published within the last 24 hours that were not already sent.

## Configuration

`PRICE_MAX_USD`: maximum monthly rent in US dollars. For another search, `PRICE_MAX_BYN` is also supported, and can be combined with the USD cap.

`ROOMS`: comma-separated numbers, e.g. `1,2`, or blank for any room count. The current search allows all counts.

`SEARCH_CENTER_LAT`, `SEARCH_CENTER_LON`, `SEARCH_RADIUS_KM`: center and straight-line radius. The current center is the metro station, approximately `53.915833, 27.583333`, with a radius of `3`. If a precise studio address is provided, replace the center coordinates. Alternatively, `AREA_POLYGON` accepts a JSON array of map corners in `[longitude,latitude]` order. Apartments without coordinates are skipped.

`TELEGRAM_BOT_TOKEN`: secret from BotFather. `TELEGRAM_CHAT_ID`: the ID of the private chat that sent `/start` to the bot; this differs from the bot's own ID. To find it, after sending `/start`, open `https://api.telegram.org/bot<TOKEN>/getUpdates` privately and copy `message.chat.id`. Do not post the token publicly or commit it to GitHub. The bot does not listen for commands; change filters in configuration.

## Free GitHub Actions deployment

This public repository uses standard GitHub-hosted runners, which are free for public repositories. The workflow `.github/workflows/monitor.yml` runs at **09:17, 15:17 and 21:17 Minsk time**, and can also be run manually from the **Actions** tab. GitHub sometimes delays or drops scheduled runs at busy times; the 17th minute reduces that risk. This is a best-effort schedule, not an exact-time guarantee.

To activate it without editing code:

1. Open **Settings → Secrets and variables → Actions → New repository secret**.
2. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as two separate repository secrets. Never put either value in a file or commit message.
3. Open **Actions → Check new apartments → Run workflow**. The first successful run builds the baseline without sending old listings. Future runs send only new matches. Check the logs of that first run for both provider success messages.

The workflow writes `state.json` to the repository after each run. It contains listing IDs and a last-check timestamp, **not bot credentials**. This repository is public, so the IDs are public as well. Each successful run creates a state commit; this keeps a history of checks and avoids GitHub's 60-day no-activity disabling of scheduled workflows. If a scheduled run is dropped, the next run still scans listings published within the last 24 hours. After a longer outage, some short-lived listings may be missed. This design needs no paid hosting or external database.

## Local / Debian deployment

Copy `.env.example` to `.env`, fill the two Telegram values (and adjust the search if desired), then run `docker compose up -d --build`. The container seeds the initial baseline at startup and checks every day at **09:00, 15:00 and 21:00 Minsk time**. The JSON state file persists in `./data` via a bind mount. Run `docker compose logs -f monitor` to check results. To inspect matches without changing state or sending messages: `docker compose run --rm monitor python monitor.py --dry-run`.

Without Docker, install `requirements.txt`, export the same environment variables, then run `python scheduler.py` as a systemd service. Run `python monitor.py --dry-run` first to verify your area.

## Operational limits

Both sites use undocumented listing data formats that can change. A failed provider is logged and retried at the next scheduled run; if both fail, the job exits unsuccessfully. Realt's default sort is not strictly by creation date, so the monitor scans all result pages (up to 100) on each run. Onlíner sorts by creation date and stops after reaching older listings (up to 30 pages). Site access can be rate limited or blocked from a particular host. An interruption between Telegram delivery and committing `state.json` can result in one duplicate. Apartments newly posted and removed between two checks cannot be found later.
