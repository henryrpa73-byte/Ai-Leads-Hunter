"""
SPYDIALER TYPE CHECKER  (cell / landline)                                   spydialer_bot.py  v7
================================================================================================
What it does
  1. Reads your Excel file (the one made by the Blue Book bot).
  2. Takes every number from the "Phone number" column (column B), types it into spydialer.com,
     reads the result ("You entered landline number ...") and writes  cell / landline / voip ...
     into the "Type" column (column E).
  3. Runs several browser tabs in parallel (fast) with a global speed limiter, random pauses and
     auto slow-down after a block (safe).
  4. Duplicate numbers are looked up only once. Rows already filled are skipped (so you can re-run).
  5. Progress is saved every 25 numbers (Excel + progress file) -> Ctrl+C / crash never loses work.
  6. CAPTCHA / "verify you are human" / rate-limit: all tabs PAUSE, a pop-up + beeps call you, you solve
     it in the Chrome window, and the bot continues by itself (or press ENTER in the terminal).

Run:            python spydialer_bot.py                      (a file picker opens)
                python spydialer_bot.py "BlueBook_Leads.xlsx"
Options:        --test            only 5 numbers (quick check that everything works)
                --workers=3       parallel tabs (default 3; 1 = slowest/safest, 4-5 = fastest/riskier)
                --redo            re-check numbers even if Type is already filled
                --inplace         write into the SAME Excel file (default: new file  <name>_typed.xlsx)
                --mychrome        use YOUR Chrome (see the command below) if the site blocks the bot's browser
                --sheet=Leads     sheet name (default: first/active sheet)

Use your own Chrome (optional): close ALL Chrome windows, then in PowerShell:
      & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\sd_chrome"
   then:  python spydialer_bot.py --mychrome

Install once:   pip install playwright openpyxl
                playwright install chromium
IMPORTANT: close the Excel file before running (Excel locks it and nothing can be saved).
"""

import re
import sys
import json
import time
import random
import asyncio
import threading
from datetime import datetime
from pathlib import Path

import openpyxl
from playwright.async_api import async_playwright

# ================================= SETTINGS (edit freely) =================================
SITE = "https://spydialer.com/"
WORKERS = 3                         # parallel tabs
MIN_INTERVAL = 0.7                  # seconds between the START of any two lookups (all tabs together)
JITTER = (0.3, 0.9)                 # extra random pause after each lookup in a tab
MAX_TRIES = 3                       # attempts per number in one round
RESULT_TIMEOUT = 25                 # seconds to wait for "You entered ... number"
PAGE_TIMEOUT = 45000                # ms for page loads
SAVE_EVERY = 25                     # save Excel after this many new results
BLOCK_HEAVY = True                  # skip videos/fonts (faster). Images stay ON so CAPTCHAs are visible
MAX_INTERVAL = 4.0                  # the bot never slows down beyond this (seconds between lookups)
PROFILE_DIR = "spydialer_profile"   # browser memory (cookies) -> fewer CAPTCHAs
CHECKPOINT = "spydialer_checkpoint.json"
DEBUG_DIR = "spydialer_debug"        # screenshots/HTML of failures are saved here
BLOCK_HOSTS = ("googlesyndication.com", "doubleclick.net", "ezojs.com", "ezoic.net", "ezoic.com", "google-analytics.com",
               "googletagmanager.com", "connect.facebook.net", "facebook.com/plugins", "platform.twitter.com",
               "cloudflareinsights.com")   # ads / social widgets: not needed, they only slow the pages (set () to disable)
PHONE_HEADER_WORDS = ("phone",)     # column whose header contains this = numbers
TYPE_HEADER = "type"                # column whose header is exactly this = output
FALLBACK_PHONE_COL = 2              # B
FALLBACK_TYPE_COL = 5               # E
# ==========================================================================================

ARGS = sys.argv[1:]
TEST = "--test" in ARGS
REDO = "--redo" in ARGS
INPLACE = "--inplace" in ARGS
MY_CHROME = "--mychrome" in ARGS


def opt(name, default=None):
    for a in ARGS:
        if a.startswith(f"--{name}="):
            return a.split("=", 1)[1]
    return default


def log(msg=""):
    print(msg, flush=True)


# ------------------------------------------------------------------------------------------
#  Helpers
# ------------------------------------------------------------------------------------------
def to_digits(raw):
    """-> 10-digit string, 'INVALID' (has text but not a US number) or None (empty / N/A -> skip)."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        s = str(int(raw))
    else:
        s = str(raw).strip()
    if not s or s.upper() in ("N/A", "NA", "NONE", "-", "NULL"):
        return None
    s = re.sub(r"(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$", "", s, flags=re.I)
    d = re.sub(r"\D", "", s)
    if len(d) == 11 and d[0] == "1":
        d = d[1:]
    return d if len(d) == 10 and d[0] not in "01" else "INVALID"


def pretty(d):
    return f"({d[:3]}) {d[3:6]}-{d[6:]}"


RESULT_RE = re.compile(r"you\s+entered\s+(?:an?\s+)?(.{2,40}?)\s+number", re.I | re.S)


def classify(raw):
    t = re.sub(r"\s+", " ", raw.lower()).strip()
    if "landline" in t or "land line" in t:
        return "landline"
    if re.search(r"cell|mobile|wireless", t):
        return "cell"
    if "voip" in t:
        return "voip"
    if "toll" in t:
        return "toll free"
    return t


def parse_result(body, digits):
    """Return the type if the page shows the result for OUR number, else None."""
    flat = re.sub(r"\s+", " ", body or "")
    m = RESULT_RE.search(flat)
    if not m:
        return None
    window = flat[m.end(): m.end() + 80]
    wd = re.sub(r"\D", "", window)
    if len(wd) >= 10 and digits not in wd:       # a stale page for another number
        return None
    return classify(m.group(1))


def is_stale(body, digits):
    """True when the page shows a result for a DIFFERENT number (another tab changed the session)."""
    flat = re.sub(r"\s+", " ", body or "")
    m = RESULT_RE.search(flat)
    if not m:
        return False
    wd = re.sub(r"\D", "", flat[m.end(): m.end() + 80])
    return len(wd) >= 10 and digits not in wd


REMOVED_RE = re.compile(r"owner of this phone number has been\s+removed|owner has removed their information", re.I)


def is_removed(body):
    """The 'Sorry, the owner of this phone number has been REMOVED' page (the footer 'Remove My Info' link does NOT match)."""
    return bool(REMOVED_RE.search(re.sub(r"\s+", " ", body or "")))


BLOCK_RE = re.compile(
    r"access verification|captcha|verify (that )?you are (a )?human|are you (a )?(robot|human)|i'?m not a robot|unusual traffic|"
    r"access denied|too many (requests|searches|lookups)|rate limit|temporarily blocked|request blocked|attention required|"
    r"just a moment|checking your browser|security check", re.I)

JS_CHALLENGE = r"""
(anchor) => {
  for (const f of document.querySelectorAll('iframe')) {
    const s = (f.src || ''); const r = f.getBoundingClientRect(); const cs = getComputedStyle(f);
    if (cs.visibility === 'hidden' || cs.display === 'none' || r.width < 1) continue;
    if (/hcaptcha|challenges\.cloudflare|turnstile/i.test(s) && r.width > 100 && r.height > 50) return true;
    if (/recaptcha/i.test(s) && /bframe/.test(s) && r.width > 200 && r.height > 200) return true;
    if (anchor && /recaptcha/i.test(s) && /anchor/.test(s) && r.width >= 290 && r.height >= 70) return true;
  }
  return false;
}
"""

POPUP_TEXTS = ["Accept All", "Accept all", "Accept", "I Agree", "I agree", "Agree", "Got it", "Got It", "Allow all",
               "No thanks", "No Thanks", "Maybe later", "Dismiss"]


async def dismiss_popups(page):
    for t in POPUP_TEXTS:
        try:
            el = page.locator(f"button:has-text('{t}'), a[role=button]:has-text('{t}')").first
            if await el.count() and await el.is_visible(timeout=150):
                if len((await el.inner_text()).strip()) <= 22:
                    await el.click(timeout=700)
                    await page.wait_for_timeout(200)
        except Exception:
            pass


async def body_text(page):
    """Text of the page AND of every iframe on it (the search form may live inside an iframe)."""
    parts = []
    for fr in page.frames:
        try:
            parts.append(await fr.inner_text("body", timeout=2500))
        except Exception:
            pass
    return "\n".join(parts)


async def is_blocked(page, anchor=False):
    try:
        head = (await page.title()) + " " + (await body_text(page))[:800]
        if BLOCK_RE.search(head):
            return True
        return bool(await page.evaluate(JS_CHALLENGE, anchor))
    except Exception:
        return False


def beep():
    try:
        import winsound
        for _ in range(3):
            winsound.Beep(1200, 350)
            time.sleep(0.1)
    except Exception:
        print("\a", end="", flush=True)


def alert_user(why):
    def popup():
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                0, f"SpyDialer needs you!\n\n{why}\n\nGo to the Chrome window and solve the verification / CAPTCHA.\n"
                   f"The bot continues by itself when the page is normal again.",
                "BOT PAUSED - ACTION NEEDED", 0x40000 | 0x1000 | 0x30)
        except Exception:
            pass
    threading.Thread(target=popup, daemon=True).start()


def enter_pressed():
    try:
        import msvcrt
    except ImportError:
        return False
    hit = False
    while msvcrt.kbhit():
        if msvcrt.getwch() in ("\r", "\n"):
            hit = True
    return hit


async def blocker(route):
    req = route.request
    if (BLOCK_HEAVY and req.resource_type in ("media", "font")) or any(h in req.url for h in BLOCK_HOSTS):
        await route.abort()
    else:
        await route.continue_()


class BrowserClosed(Exception):
    pass


def closed_error(e):
    m = str(e).lower()
    return "has been closed" in m or "target closed" in m or "browser has been closed" in m or "context or browser" in m


# ------------------------------------------------------------------------------------------
#  Excel
# ------------------------------------------------------------------------------------------
def pick_input_file():
    for a in ARGS:
        if not a.startswith("--"):
            return a
    try:
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        f = filedialog.askopenfilename(title="Choose the Excel file with the phone numbers",
                                       filetypes=[("Excel", "*.xlsx *.xlsm")])
        root.destroy()
        if f:
            return f
    except Exception:
        pass
    return input("Path of the Excel file: ").strip().strip('"')


class Sheet:
    def __init__(self, path):
        self.path = Path(path)
        self.out = self.path if INPLACE else self.path.with_name(self.path.stem.replace("_typed", "") + "_typed.xlsx")
        self.wb = openpyxl.load_workbook(self.path)
        name = opt("sheet")
        self.ws = self.wb[name] if name else self.wb.active
        ws = self.ws
        self.pc = self.tc = None
        for c in range(1, ws.max_column + 1):
            h = str(ws.cell(1, c).value or "").strip().lower()
            if self.pc is None and any(w in h for w in PHONE_HEADER_WORDS):
                self.pc = c
            if self.tc is None and h == TYPE_HEADER:
                self.tc = c
        self.pc = self.pc or FALLBACK_PHONE_COL
        self.tc = self.tc or FALLBACK_TYPE_COL
        if not str(ws.cell(1, self.tc).value or "").strip():
            ws.cell(1, self.tc).value = "Type"
        self.rows = {}              # digits -> [row numbers]
        self.invalid_rows = []
        self.skipped_filled = 0
        for r in range(2, ws.max_row + 1):
            d = to_digits(ws.cell(r, self.pc).value)
            if d is None:
                continue
            cur = str(ws.cell(r, self.tc).value or "").strip()
            if cur and not REDO:
                self.skipped_filled += 1
                continue
            if d == "INVALID":
                self.invalid_rows.append(r)
                continue
            self.rows.setdefault(d, []).append(r)
        self.warned_lock = False

    def write(self, results):
        ws = self.ws
        for r in self.invalid_rows:
            ws.cell(r, self.tc).value = "invalid"
        for d, t in results.items():
            for r in self.rows.get(d, []):
                ws.cell(r, self.tc).value = t
        try:
            self.wb.save(self.out)
            return self.out
        except PermissionError:
            alt = self.out.with_name(f"{self.out.stem}_{datetime.now():%H%M%S}.xlsx")
            self.wb.save(alt)
            if not self.warned_lock:
                log(f"   ! '{self.out.name}' is open in Excel and locked - saved to '{alt.name}' instead. Close Excel!")
                self.warned_lock = True
            return alt


# ------------------------------------------------------------------------------------------
#  The bot
# ------------------------------------------------------------------------------------------
class Bot:
    def __init__(self, ctx, sheet, results, workers):
        self.ctx = ctx                          # ONE browser window / session shared by all tabs
        self.sheet = sheet
        self.results = results                  # digits -> type
        self.workers = workers
        self.interval = MIN_INTERVAL
        self.last_start = 0.0
        self.gate_lock = asyncio.Lock()
        self.human_lock = asyncio.Lock()
        self.search_lock = asyncio.Lock()       # tabs take turns for: type -> Search -> read result (SpyDialer keeps the
                                                # last searched number in the shared session, so searches must not overlap)
        self.running = asyncio.Event()
        self.running.set()
        self.waiting = 0
        self.clean = 0
        self.done = 0
        self.total = 0
        self.t0 = time.monotonic()
        self.failed = []
        self.since_save = 0
        self.dumped = 0

    # ---- speed limiter ----
    async def gate(self):
        async with self.gate_lock:
            wait = self.last_start + self.interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self.last_start = time.monotonic()

    def slow_down(self):
        self.interval = min(self.interval * 1.4, MAX_INTERVAL)
        self.clean = 0
        log(f"   (slowing down: one lookup every {self.interval:.1f}s from now on)")

    def speed_up_a_bit(self):
        self.clean += 1
        if self.clean >= 60 and self.interval > MIN_INTERVAL:
            self.interval = max(MIN_INTERVAL, self.interval * 0.9)
            self.clean = 0

    # ---- CAPTCHA / block: pause every tab until a human solves it ----
    async def human(self, page, why):
        self.waiting += 1
        self.running.clear()
        try:
            async with self.human_lock:
                try:
                    await page.goto(SITE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT)
                except Exception:
                    pass
                if not await is_blocked(page):
                    return                               # somebody else already solved it
                self.slow_down()
                log(f"\n!! SpyDialer is showing {why}.  >>> ALL TABS PAUSED - THE BOT WAITS FOR YOU <<<")
                log("   Solve it in the Chrome window. The bot continues by itself (or press ENTER here).")
                try:
                    await page.bring_to_front()
                except Exception:
                    pass
                alert_user(why)
                last_beep = 0.0
                while True:
                    if time.monotonic() - last_beep > 8:
                        await asyncio.to_thread(beep)
                        last_beep = time.monotonic()
                    if enter_pressed():
                        break
                    await asyncio.sleep(1.5)
                    if not await is_blocked(page):
                        log("   Page looks normal again - continuing...")
                        await asyncio.sleep(1.5)
                        break
        finally:
            self.waiting -= 1
            if self.waiting == 0:
                self.running.set()

    # ---- find the search box (main page OR any iframe) and submit ----
    BOX_SELECTORS = ("input[placeholder*='123']", "input[type='tel']", "input[name*='phone' i]", "input[id*='phone' i]",
                     "input[type='search']", "input[type='text']", "input:not([type])")

    async def find_box(self, page, wait=12):
        end = time.monotonic() + wait
        while True:
            for sel in self.BOX_SELECTORS:
                for fr in page.frames:
                    try:
                        loc = fr.locator(sel)
                        for i in range(min(await loc.count(), 6)):
                            el = loc.nth(i)
                            if await el.is_visible():
                                return el, fr
                    except Exception:
                        continue
            if time.monotonic() >= end:
                return None, None
            await asyncio.sleep(0.5)

    async def submit(self, page, box, fr):
        rx = re.compile(r"^\s*search\s*$", re.I)
        for scope in (fr, page):
            for loc in (scope.get_by_role("button", name=rx), scope.locator("input[type=submit], button[type=submit]"),
                        scope.get_by_text(rx)):
                try:
                    for i in range(min(await loc.count(), 5)):
                        el = loc.nth(i)
                        if await el.is_visible():
                            await el.click(timeout=3000, no_wait_after=True)
                            return
                except Exception:
                    continue
        try:
            await box.press("Enter", timeout=2500)
        except Exception:
            pass

    async def wait_result(self, page, popups, digits, timeout):
        """-> type string | 'BLOCK' | 'STALE' | None (timeout). Also watches pop-up tabs the site may open."""
        end = time.monotonic() + timeout
        n = 0
        while time.monotonic() < end:
            for pg in [page] + [x for x in popups if not x.is_closed()]:
                text = await body_text(pg)
                res = parse_result(text, digits)
                if res:
                    return res
                if is_removed(text):
                    return "N/A"                                  # owner removed the info -> write N/A, no retries
                if pg is page and is_stale(text, digits):
                    return "STALE"
            n += 1
            if n % 3 == 0 and await is_blocked(page):
                return "BLOCK"
            await asyncio.sleep(0.35)
        return "BLOCK" if await is_blocked(page, anchor=True) else None

    async def dump(self, page, digits, why):
        """Save a screenshot + HTML so a failure can be diagnosed (first 3 failures only)."""
        if self.dumped >= 3:
            return
        self.dumped += 1
        Path(DEBUG_DIR).mkdir(exist_ok=True)
        tag = f"{datetime.now():%H%M%S}_{digits}_{why}"
        try:
            await page.screenshot(path=f"{DEBUG_DIR}/{tag}.png")
        except Exception:
            pass
        try:
            Path(f"{DEBUG_DIR}/{tag}.html").write_text(await page.content(), encoding="utf-8")
        except Exception:
            pass
        try:
            info = [f"url: {page.url}"] + [f"frame: {fr.url}" for fr in page.frames]
            Path(f"{DEBUG_DIR}/{tag}.txt").write_text("\n".join(info) + "\n\n" + (await body_text(page))[:3000], encoding="utf-8")
        except Exception:
            pass
        log(f"    (debug files saved in the '{DEBUG_DIR}' folder: {tag}.*)")

    # ---- one number ----
    async def lookup(self, page, digits):
        fmt = f"{digits[:3]}-{digits[3:6]}-{digits[6:]}"
        popups = []

        def on_popup(pg):
            popups.append(pg)
        page.on("popup", on_popup)
        try:
            for attempt in range(1, MAX_TRIES + 1):
                await self.running.wait()
                await self.gate()
                tag = f"try {attempt}/{MAX_TRIES} {pretty(digits)}"
                try:
                    resp = await page.goto(SITE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT)
                    status = resp.status if resp else 200
                    if status in (429, 503):
                        log(f"    ({tag}: rate limited, status {status} - cooling down {10 * attempt}s)")
                        self.slow_down()
                        await asyncio.sleep(10 * attempt)
                        continue
                    if await is_blocked(page):
                        await self.human(page, "a CAPTCHA / verification page")
                        continue
                    await dismiss_popups(page)
                    box, fr = await self.find_box(page)
                    if box is None:
                        if await is_blocked(page, anchor=True):
                            await self.human(page, "a CAPTCHA / verification page")
                        else:
                            log(f"    ({tag}: search box NOT found - frames on page: {len(page.frames)})")
                            await self.dump(page, digits, "nobox")
                            await asyncio.sleep(2 * attempt)
                        continue
                    await box.click()
                    await box.fill("")
                    await box.press_sequentially(fmt, delay=20)           # real key presses (works with JS-masked inputs)
                    if re.sub(r"\D", "", await box.input_value()) != digits:
                        await box.fill(fmt)
                    # Only ONE tab at a time may press Search and read its result (the site keeps the last number in the
                    # shared session). Loading pages and typing still happen in all tabs at once.
                    async with self.search_lock:
                        await self.submit(page, box, fr)
                        res = await self.wait_result(page, popups, digits, 8)
                        if res is None:                                   # click did nothing? press Enter too
                            try:
                                await box.press("Enter", timeout=2000)
                            except Exception:
                                pass
                            res = await self.wait_result(page, popups, digits, RESULT_TIMEOUT)
                    if res == "BLOCK":
                        await self.human(page, "a CAPTCHA / block after the search")
                        continue
                    if res == "STALE":
                        log(f"    ({tag}: the site showed another number - retrying)")
                        await asyncio.sleep(0.6 * attempt)
                        continue
                    if res:
                        for pg in popups:
                            try:
                                await pg.close()
                            except Exception:
                                pass
                        return res
                    log(f"    ({tag}: number typed + Search pressed, but no result appeared)")
                    await self.dump(page, digits, "noresult")
                    await asyncio.sleep(1.5 * attempt)
                except Exception as e:
                    if closed_error(e):
                        raise BrowserClosed("The Chrome window was closed.")
                    log(f"    ({tag}: {str(e)[:80]})")
                    await asyncio.sleep(2 * attempt)
            return None
        finally:
            try:
                page.remove_listener("popup", on_popup)
            except Exception:
                pass

    def progress(self, digits, res):
        el = max(1.0, time.monotonic() - self.t0)
        rate = self.done / el
        left = (self.total - self.done) / rate if rate > 0 else 0
        eta = f"{int(left // 60)}m{int(left % 60):02d}s"
        log(f"  [{self.done}/{self.total}] {pretty(digits)} -> {res:<9} | {rate * 60:.0f}/min | ETA {eta}")

    async def worker(self, queue, idx=0):
        ctx = self.ctx
        page = await ctx.new_page()
        try:
            while True:
                try:
                    d = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                if page.is_closed():
                    page = await ctx.new_page()
                res = await self.lookup(page, d)
                if res:
                    self.results[d] = res
                    self.done += 1
                    self.since_save += 1
                    self.speed_up_a_bit()
                    self.progress(d, res)
                    if self.since_save >= SAVE_EVERY:
                        self.save()
                else:
                    self.failed.append(d)
                    log(f"    ! no result for {pretty(d)} (will retry later)")
                await asyncio.sleep(random.uniform(*JITTER))
        finally:
            try:
                await page.close()
            except Exception:
                pass

    def save(self):
        self.since_save = 0
        try:
            Path(CHECKPOINT).write_text(json.dumps(self.results, indent=0), encoding="utf-8")
        except Exception:
            pass
        try:
            self.sheet.write(self.results)
        except Exception as e:
            log(f"   ! Excel save problem: {e}")

    async def run_round(self, numbers, n_workers):
        queue = asyncio.Queue()
        for d in numbers:
            queue.put_nowait(d)
        self.failed = []
        outs = await asyncio.gather(*[self.worker(queue, i) for i in range(n_workers)], return_exceptions=True)
        for o in outs:
            if isinstance(o, BrowserClosed):
                raise o
            if isinstance(o, Exception) and not isinstance(o, asyncio.CancelledError):
                log(f"   ! worker error: {str(o)[:80]}")


# ------------------------------------------------------------------------------------------
#  Browser launch
# ------------------------------------------------------------------------------------------
async def launch(p):
    """ONE Chrome window / session; all tabs live inside it."""
    if MY_CHROME:
        try:
            br = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        except Exception:
            log("\n!! Could not connect to your Chrome on port 9222.\n"
                "   Close ALL Chrome windows, start Chrome with the command shown at the top of this file, then run again.")
            sys.exit(1)
        ctx = br.contexts[0] if br.contexts else await br.new_context()
        log("Connected to your own Chrome.")
        return ctx, False
    args = ["--disable-blink-features=AutomationControlled", "--start-maximized", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
    last = None
    for channel in ("chrome", None):
        try:
            kw = dict(headless=False, args=args, viewport=None, ignore_default_args=["--enable-automation"])
            if channel:
                kw["channel"] = channel
            return await p.chromium.launch_persistent_context(PROFILE_DIR, **kw), True
        except Exception as e:
            last = e
    raise last


async def main():
    path = pick_input_file()
    if not path or not Path(path).exists():
        log("No Excel file chosen / found.")
        return
    sheet = Sheet(path)
    results = {}
    if not REDO and Path(CHECKPOINT).exists():
        try:
            results = {k: v for k, v in json.loads(Path(CHECKPOINT).read_text(encoding="utf-8")).items() if v}
        except Exception:
            results = {}
    cached = [d for d in sheet.rows if d in results]
    todo = [d for d in sheet.rows if d not in results]
    if TEST:
        todo = todo[:5]
    workers = max(1, min(8, int(opt("workers", WORKERS))))
    log(f"File: {Path(path).name}  | sheet '{sheet.ws.title}' | phone column {sheet.pc} -> Type column {sheet.tc}")
    log(f"Rows already filled (skipped): {sheet.skipped_filled} | unique numbers to check: {len(todo)} "
        f"| answered from earlier runs: {len(cached)} | invalid numbers: {len(sheet.invalid_rows)}")
    if not todo:
        out = sheet.write(results)
        log(f"Nothing new to look up. Saved: {out}")
        return
    est = len(todo) / max(1, workers) * (4 + MIN_INTERVAL) / 60
    log(f"Starting {workers} tab(s) in one Chrome window. Rough time: {est:.0f}+ minutes. Don't close the Chrome window.\n")

    async with async_playwright() as p:
        ctx, own = await launch(p)
        await ctx.route("**/*", blocker)
        bot = Bot(ctx, sheet, results, workers)
        bot.total = len(todo)
        try:
            await bot.run_round(todo, workers)
            for rnd in (2, 3):                                   # retry the failed ones after a cool-down
                if not bot.failed:
                    break
                again = list(bot.failed)
                log(f"\n{len(again)} numbers failed - cooling down 20s, then retry round {rnd - 1}...")
                bot.slow_down()
                await asyncio.sleep(20)
                await bot.run_round(again, max(1, workers // 2))
        except (KeyboardInterrupt, asyncio.CancelledError):
            log("\nStopped by you. Saving what was collected so far...")
        except BrowserClosed:
            log("\n!! The Chrome window was closed. Saving everything so far - run again to continue.")
        except Exception as e:
            log(f"\n!! Unexpected error: {e}\n   Saving everything so far (run again to continue).")
        finally:
            bot.save()
            if own:
                try:
                    await ctx.close()
                except Exception:
                    pass
    out = sheet.out
    kinds = {}
    for d in sheet.rows:
        if d in results:
            kinds[results[d]] = kinds.get(results[d], 0) + 1
    log(f"\nDone. Saved: {out}")
    log("Results: " + ", ".join(f"{k}: {v}" for k, v in sorted(kinds.items())) if kinds else "No results.")
    missing = [d for d in sheet.rows if d not in results]
    if missing:
        log(f"{len(missing)} numbers still have no result - just run the bot again, it continues with those.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass