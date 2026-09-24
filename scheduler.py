"""Runs once at startup to seed the baseline, then at 09:00, 15:00, 21:00 Minsk time."""
import logging
import subprocess
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
ZONE = ZoneInfo("Europe/Minsk")
HOURS = (9, 15, 21)


def run():
    result = subprocess.run([sys.executable, "monitor.py"], check=False)
    if result.returncode:
        logging.error("Monitor exited with status %s", result.returncode)


if __name__ == "__main__":
    run()
    while True:
        now = datetime.now(ZONE)
        candidates = [now.replace(hour=h, minute=0, second=0, microsecond=0) for h in HOURS]
        next_run = min((d if d > now else d + timedelta(days=1)) for d in candidates)
        logging.info("Next run: %s", next_run.isoformat())
        time.sleep(max(1, (next_run - now).total_seconds()))
        run()
