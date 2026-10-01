# Apartment monitor

## Telegram bot on Cloudflare

The bot supports multiple users in private Telegram chats. New users enter the shared access password once before settings become available. The password is stored as the Cloudflare secret `BOT_ACCESS_PASSWORD` (set the matching GitHub Actions secret before deploying); it is case-sensitive. After five failed attempts, login is blocked for ten minutes. Each chat has its own preferences, draft, schedule, scan cursor and sent-listing history. The original owner is authorized during migration and retains existing data.

The active bot is a Cloudflare Worker with a D1 database and Telegram webhook. Open
**⚙️ Настройки поиска → 📍 Область → район → город** to select one or more places in Belarus. The settings root has only one location button; choosing a city returns to settings. Open **📍 Область** again to add or remove another city,
then set an optional BYN price limit and check frequency. Minsk listings can additionally
be filtered by metro station or line and Minsk city district. These controls appear
only after an explicit Minsk selection. Radius is disabled, including previously saved
radius values. Brest listings
can also be filtered by its Leninsky and Moskovsky city districts. Those Minsk filters
do not restrict other selected towns. With no city districts selected, the city district
filter is absent. **✅ Применить** saves the draft. **📋 Текущие настройки** displays only
the applied settings, and **🔄 Проверить новые квартиры** starts a check.
City district geometry: © OpenStreetMap contributors, ODbL.

The location choices are served immediately by the Worker from a bundled open
settlement list (source: [geolocation-cities](https://github.com/jug-it/geolocation-cities),
2019), with regional capitals and province-level cities included separately. The
directory validates all 118 administrative rayons (including 22 in Minsk oblast),
independently of settlement records. Missing rayon fields for settlement centers are
reconstructed from nearby records; Minsk-area Borovlyany has an explicit correction.
Cities, urban settlements, agrotowns and villages are selectable, with pagination and
name search. This is a cached source, not a live official administrative API. Districts *within*
a city are currently selectable for Minsk and Brest; the rayon in the location hierarchy is
the administrative rayon of an oblast. External listing feeds can omit a precise
city, in which case that listing is skipped rather than assigned to the wrong city.

The Worker scans the national listing feeds for Onliner, Realt and Kufar. Existing
saved settings without a city are interpreted as Minsk for active searches. Legacy
drafts start without an implicit city selection; a city must be chosen before applying.
Old settlement indices are preserved when expanding the directory. Telegram notifications have a heading for the publication period and
individual listing links and photos where available.

The Python and GitHub Actions instructions below describe the separate legacy runner.

Checks Onlíner, Realt and Kufar for newly published long-term rental apartments in Minsk and sends matches to a private Telegram chat. The configured search covers a **3 km straight-line radius around Ploshcha Yakuba Kolasa metro station** and listings at **$500 USD per month or less**, with any room count. These coordinates are an approximate station center, not the verified location of the Rassvetay studio. Listing feeds provide USD conversions; the monitor does not rely on a hard-coded exchange rate. It remembers sent listing IDs.

Only listings with publication timestamps in the selected half-open Minsk-time interval are sent:

Each Telegram listing includes the first photo with address, monthly price, room count and a direct link. If the listing has no accessible photo, the same information is sent as text.

| Scan | Publication interval |
| --- | --- |
| 09:00 | Previous day 22:00 to 09:00 |
| 14:00 | 09:00 to 14:00 |
| 22:00 | 14:00 to 22:00 |

Each completed check sends one heading with the exact Minsk-time publication period and the number of new listings (or that there were none), followed by the individual listings. The `covered_until` value in `state.json` advances after all three sources succeed. A manual `--window check` run scans from the last completed boundary until now; the next scheduled check resumes from that point.

A manual `--window current` run uses the evening interval ending at the current time (or at 22:00 if run later); when a saved boundary exists, it resumes from that boundary without repeating delivered IDs.

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

The workflow writes `state.json` to the repository after each run. It contains sent listing IDs and the last completed publication boundary, **not bot credentials**. This repository is public, so the IDs are public as well. Each successful run creates a state commit; this keeps a history of checks and avoids GitHub's 60-day no-activity disabling of scheduled workflows. A delayed or missed job is picked up from the last completed boundary on the next successful check, while listings removed before that check cannot be recovered. This design needs no paid hosting or external database.

## Connect Cloudflare for the Worker migration

No direct Cloudflare connector is currently available here. The manual **Verify Cloudflare connection** workflow provides a narrow CI bridge: it reads two GitHub Actions repository secrets, makes only read requests to Cloudflare Workers, D1 and Workflows, and reports whether access is working. No token is printed or committed. Once verified, a deployment workflow can use the same secrets to deploy a Cloudflare Worker and D1 database on the free plan.

1. In Cloudflare, create an account-scoped API token for the account that will host this bot. Grant **Workers Scripts Edit** and **D1 Edit** for that account. Avoid the Global API Key. [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) explains the CI token setup.
2. Find that account's **Account ID** in Cloudflare. In this GitHub repository, open **Settings → Secrets and variables → Actions**. Add repository secrets named `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with their corresponding values. Never paste the token into a chat, source file, or issue.
3. Open **Actions → Verify Cloudflare connection → Run workflow**. The job should report `Workers: API access verified`, `D1: API access verified`, and `Workflows: API access verified`. If it fails, share the error text, never the secret.

The current GitHub scheduler remains active until the Cloudflare bot is deployed and the Telegram webhook has been tested. A Cloudflare setup needs to disable the GitHub scheduler during cutover to avoid duplicate checks.

## Local / Debian deployment

Copy `.env.example` to `.env`, fill the two Telegram values (and adjust the search if desired), then run `docker compose up -d --build`. The container checks every day at **09:00, 14:00 and 22:00 Minsk time**. The JSON state file persists in `./data` via a bind mount. Run `docker compose logs -f monitor` to check results. To inspect an interval without changing state or sending messages: `docker compose run --rm monitor python monitor.py --dry-run --window evening`.

Without Docker, install `requirements.txt`, export the same environment variables, then run `python scheduler.py` as a systemd service. Run `python monitor.py --dry-run --window evening` first to verify your area.

## Operational limits

All three sites use undocumented listing data formats that can change. A failed provider makes the job fail after completed sources are processed. Realt's default sort is not strictly by creation date, so the monitor scans all result pages (up to 100) on each run. Onlíner and Kufar sort by listing time and stop at older listings (up to 30 and 100 pages respectively). Site access can be rate limited or blocked from a particular host. An interruption between Telegram delivery and committing `state.json` can result in one duplicate. Apartments newly posted and removed between two checks cannot be found later.
