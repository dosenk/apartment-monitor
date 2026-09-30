"""Runs publishing-window scans at 09:00, 14:00, 22:00 Minsk time."""
import logging
import subprocess
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
ZONE = ZoneInfo("Europe/Minsk")
HOURS = {9: "morning", 14: "midday", 22: "evening"}


def run(window):
    result = subprocess.run([sys.executable, "monitor.py", "--window", window], check=False)
    if result.returncode:
        logging.error("Monitor exited with status %s", result.returncode)


if __name__ == "__main__":
    while True:
        now = datetime.now(ZONE)
        candidates = [(d if d > now else d + timedelta(days=1), kind)
                      for h, kind in HOURS.items()
                      for d in [now.replace(hour=h, minute=0, second=0, microsecond=0)]]
        next_run, window = min(candidates)
        logging.info("Next run: %s", next_run.isoformat())
        time.sleep(max(1, (next_run - now).total_seconds()))
        run(window)
