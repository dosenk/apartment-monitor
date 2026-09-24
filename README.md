# Apartment monitor

Checks Onlíner and Realt for newly published long-term rental apartments in Minsk and sends matches to a private Telegram chat. The configured search covers a **3 km straight-line radius around Ploshcha Yakuba Kolasa metro station** and listings at **$500 USD per month or less**, with any room count. These coordinates are an approximate station center, not the verified location of the Rassvetay studio. The original listing feeds provide their own USD conversions; the monitor does not rely on a hard-coded exchange rate. It remembers listing IDs, so a listing is sent once. The first successful run for each site seeds the baseline without sending old listings. Later runs send only listings published within the last 24 hours that were not already sent.

## Configuration

`PRICE_MAX_USD`: maximum monthly rent in US dollars. For another search, `PRICE_MAX_BYN` is also supported, and can be combined with the USD cap.

`ROOMS`: comma-separated numbers, e.g. `1,2`, or blank for any room count. The current search allows all counts.

`SEARCH_CENTER_LAT`, `SEARCH_CENTER_LON`, `SEARCH_RADIUS_KM`: center and straight-line radius. The current center is the metro station, approximately `53.915833, 27.583333`, with a radius of `3`. If a precise studio address is provided, replace the center coordinates. Alternatively, `AREA_POLYGON` accepts a JSON array of map corners in `[longitude,latitude]` order. Apartments without coordinates are skipped.

`TELEGRAM_BOT_TOKEN`: secret from BotFather. `TELEGRAM_CHAT_ID`: the ID of the private chat that sent `/start` to the bot; this differs from the bot's own ID. To find it, after sending `/start`, open `https://api.telegram.org/bot<TOKEN>/getUpdates` privately and copy `message.chat.id`. Do not post the token publicly or commit it to GitHub. The bot does not listen for commands; change filters in configuration.

## Local / Debian deployment

Copy `.env.example` to `.env`, fill the two Telegram values (and adjust the search if desired), then run `docker compose up -d --build`. The container seeds the initial baseline at startup and checks every day at **09:00, 15:00 and 21:00 Minsk time**. SQLite persists in `./data` via a bind mount. Run `docker compose logs -f monitor` to check results. To inspect matches without changing state or sending messages: `docker compose run --rm monitor python monitor.py --dry-run`.

Without Docker, install `requirements.txt`, export the same environment variables, then run `python scheduler.py` as a systemd service. Run `python monitor.py --dry-run` first to verify your area.

## Render deployment

The `render.yaml` Blueprint creates a cron job at **06:00, 12:00 and 18:00 UTC**, corresponding to 09:00, 15:00 and 21:00 Minsk. It also creates a **paid, persistent Key Value** instance for listing history. Render Cron has no persistent disk, and the free Key Value plan loses its data on restart. Review Render's current prices before applying the Blueprint. Connect this repository, fill `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the Dashboard, then apply. The search settings are already included. The first run seeds the baseline.

## Operational limits

Both sites use undocumented listing data formats that can change. A failed provider is logged and retried at the next scheduled run; if both fail, the job exits unsuccessfully. Realt's default sort is not strictly by creation date, so the monitor scans all result pages (up to 55) on each run. Onlíner sorts by creation date and stops after reaching older listings (up to 30 pages). Site access can be rate limited or blocked from a particular host. An interruption between Telegram delivery and saving a seen ID can result in one duplicate. Apartments newly posted and removed between two checks cannot be found later.
