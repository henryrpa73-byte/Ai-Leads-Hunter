"""
LINKEDIN RPA AUTOMATION - visible Chrome, human-approved messaging.

Section 12 requirements implemented:
  A  Visible, headed, maximized Chrome; one persistent session; login preserved
  B  Visible UI interaction: click profile, scroll, find Message control, type
     subject + body, go back to results, click Next
  C  Condition-based waits (URL, visible element, loading indicators gone) with
     configurable timeouts + a FIXED (never random) short delay between actions
  D  Live terminal dashboard
  E  PAUSE / RESUME / STOP at safe points (type a command + Enter)
  F  Any browser/login/page failure -> stop, save progress, show error, no restart
  G  dev_test.py is the pre-integration test (already verified)

SAFETY RULES (hard-coded):
  * A message is NEVER sent without you typing  y  for that specific profile.
  * Only profiles whose message window shows "Free to Open Profile" are drafted.
  * Credit-required and uncertain profiles are skipped (never drafted/sent).
  * A "sending" marker is saved BEFORE clicking Send, so a crash can never lead
    to a duplicate send on resume.

Commands while running (type then press Enter in this terminal):
    p = pause     r = resume     s = stop
    y = approve & SEND the message currently on screen
    n = discard the current draft and skip that profile

Usage:
    python linkedin_rpa.py --detect-only --limit 5   # first run: classify only, types nothing
    python linkedin_rpa.py --limit 3                 # draft + ask approval, 3 profiles
    python linkedin_rpa.py                           # full run (resumes saved progress)
    python linkedin_rpa.py --fresh                   # ignore saved progress
"""

import argparse
import csv
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook, load_workbook
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
DATA = BASE / "data"          # everything user-specific lives here, so updating the code never touches it
DATA.mkdir(exist_ok=True)

# ============================== CONFIG ===================================
CONFIG = {
    # --- browser ---
    "debug_port": 9222,
    "profile_dir": str(DATA / "chrome_profile"),   # your LinkedIn login lives here
    "chrome_path": None,                            # None = auto-detect

    # --- files ---
    "excel_path": str(DATA / "messages.xlsx"),  # Subject | Messages
    "progress_file": str(DATA / "progress.json"),
    "results_csv": str(DATA / "results_log.csv"),
    "log_xlsx": str(DATA / "LinkedIn_Message_Log.xlsx"),   # readable Excel log (Sent / Skipped / Failed)
    "screenshot_dir": str(DATA / "screenshots"),

    # --- optional: where to start if no Sales Navigator search tab is open ---
    "search_url": "",
    "start_url": "https://www.linkedin.com/sales/home",   # opened if no search tab is found

    # --- condition-based wait timeouts (ms) ---
    "browser_launch_timeout_ms": 20_000,
    "search_results_timeout_ms": 20_000,
    "navigation_timeout_ms": 20_000,
    "profile_info_timeout_ms": 20_000,
    "messaging_ui_timeout_ms": 15_000,
    "field_timeout_ms": 10_000,
    "pagination_timeout_ms": 20_000,

    # --- fixed (NOT random) short delays so you can watch each step ---
    "action_delay_ms": 800,
    "typing_delay_ms": 40,
    "profile_scroll_steps": 4,
    "profile_scroll_pixels": 500,

    # --- behaviour ---
    "send_after_approval": True,   # False = type the draft, never click Send
    "max_per_day": 40,             # hard daily cap on messages sent to FREE profiles
    "max_credits_per_day": 10,     # hard daily cap on messages that USE CREDITS (mode "credit")
    "between_messages_s": 30,      # FIXED pause after each sent message (rate limiting, not random)

    # --- LinkedIn text/selectors (edit here if the UI wording differs) ---
    "free_regex": r"Free to Open Profile",
    "credit_regex": r"credits?\b",
    "lead_link": 'a[href*="/sales/lead/"]',
    "search_url_part": "/sales/search/people",
    "message_button_name": r"^\s*Message",
    "next_button_name": r"^\s*Next",
    "compose_title": "New message",
    "loading_selectors": [".artdeco-loader", "[aria-busy='true']", ".loading-spinner"],
    "login_url_parts": ["/login", "authwall", "checkpoint", "/uas/", "signup"],
}
# =========================================================================


class Stop(Exception):
    """User asked to stop."""


class DailyLimit(Exception):
    """Daily send cap reached - normal, graceful end of the run."""


class FatalError(Exception):
    """Unrecoverable problem: save progress and halt."""


BLOCK_RE = re.compile(r"security verification|quick security check|captcha|are you a robot|"
                      r"verify (that )?you('| a)re (a )?human", re.I)
RESTRICT_RE = re.compile(r"account (has been|is) (temporarily )?restricted|temporarily restricted|"
                         r"restricted your account", re.I)


# ------------------------------ Chrome --------------------------------
def find_chrome():
    if CONFIG["chrome_path"]:
        return CONFIG["chrome_path"]
    for c in [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
    ]:
        if os.path.exists(c):
            return c
    raise FatalError("Chrome not found. Set CONFIG['chrome_path'].")


def chrome_is_up():
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{CONFIG['debug_port']}/json/version", timeout=1
        ) as r:
            return bool(json.load(r))
    except Exception:
        return False


def ensure_chrome(url="about:blank"):
    if chrome_is_up():
        return
    Path(CONFIG["profile_dir"]).mkdir(parents=True, exist_ok=True)
    cmd = [
        find_chrome(),
        f"--remote-debugging-port={CONFIG['debug_port']}",
        f"--user-data-dir={CONFIG['profile_dir']}",
        "--start-maximized", "--no-first-run", "--no-default-browser-check",
        url,
    ]  # no --headless
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(cmd, creationflags=flags, close_fds=True)
    deadline = time.time() + CONFIG["browser_launch_timeout_ms"] / 1000
    while time.time() < deadline:
        if chrome_is_up():
            return
        time.sleep(0.25)
    raise FatalError("Chrome did not start within the launch timeout.")


def open_url_visible(url):
    """Show `url` in the automation Chrome (starts Chrome if needed)."""
    if chrome_is_up():
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{CONFIG['debug_port']}/json/new?{url}", method="PUT")
            urllib.request.urlopen(req, timeout=3).read()
        except Exception:
            pass
    else:
        ensure_chrome(url)


def maximize(context, page):
    try:
        s = context.new_cdp_session(page)
        wid = s.send("Browser.getWindowForTarget")["windowId"]
        s.send("Browser.setWindowBounds", {"windowId": wid, "bounds": {"windowState": "normal"}})
        s.send("Browser.setWindowBounds", {"windowId": wid, "bounds": {"windowState": "maximized"}})
    except Exception:
        pass  # cosmetic only


# --------------------------- Keyboard control --------------------------
class Control:
    def __init__(self, use_stdin=True):
        self.q = queue.Queue()
        self.paused = False
        self.stop = False
        if use_stdin:
            threading.Thread(target=self._reader, daemon=True).start()

    def push(self, cmd):
        """Used by the GUI buttons instead of typing in the terminal."""
        self.q.put(cmd)

    def _reader(self):
        try:
            for line in sys.stdin:
                self.q.put(line.strip().lower())
        except Exception:
            pass

    def _apply(self, cmd):
        if cmd in ("p", "pause"):
            self.paused = True
        elif cmd in ("r", "resume"):
            self.paused = False
        elif cmd in ("s", "stop"):
            self.stop = True

    def poll(self):
        while True:
            try:
                self._apply(self.q.get_nowait())
            except queue.Empty:
                return

    def wait_for(self, valid):
        """Block until one of `valid` is typed. 's' always raises Stop."""
        while True:
            try:
                cmd = self.q.get(timeout=0.25)
            except queue.Empty:
                continue
            if cmd in ("s", "stop"):
                self.stop = True
                raise Stop()
            if cmd in valid:
                return cmd


# ------------------------------- App -----------------------------------
class App:
    def __init__(self, args, on_render=None):
        self.args = args
        self.on_render = on_render      # GUI hook; None = terminal dashboard
        self.ctl = Control(use_stdin=on_render is None)
        self.page = None
        self.context = None
        self.browser_state = "STARTING"
        self.action = "Starting..."
        self.cur_name = "-"
        self.cur_page = 1
        self.pending = 0
        self.processed_this_run = 0
        self.results_url = ""
        try:
            self.templates = self.load_templates()
        except FatalError:
            if self.mode() == "detect":
                self.templates = []          # templates are not needed just to look around
            else:
                raise FatalError("No message templates yet. Open Section 5 on the page, write your "
                                 "Subject + Message, and click 'Save templates'.")
        self.state = {"done": {}, "discovered": [], "results_url": "", "page": 1, "next_tpl": 0, "daily": {}}
        if not args.fresh and Path(CONFIG["progress_file"]).exists():
            try:
                self.state = json.loads(Path(CONFIG["progress_file"]).read_text("utf-8"))
            except Exception:
                raise FatalError("progress.json is unreadable. Fix or delete it (or use --fresh).")
        self.cur_page = self.state.get("page", 1)

    # ---------- template ----------
    def load_templates(self):
        p = Path(CONFIG["excel_path"])
        if not p.exists():  # fall back to any .xlsx next to the script (e.g. name with spaces)
            found = sorted(f for d in (DATA, BASE) for f in d.glob("*.xlsx") if not f.name.startswith("~$"))
            if len(found) == 1:
                p = found[0]
            else:
                raise FatalError(f"Message template not found: {p}\n"
                                 f"Set CONFIG['excel_path'] to the exact file name.")
        ws = load_workbook(p, data_only=True).active
        rows = list(ws.iter_rows(values_only=True))
        header = [str(c or "").strip().lower() for c in rows[0]]
        try:
            si, mi = header.index("subject"), header.index("messages")
        except ValueError:
            raise FatalError("Excel needs columns named 'Subject' and 'Messages'.")
        out = [(str(r[si]).strip(), str(r[mi]).replace("\r\n", "\n").strip())
               for r in rows[1:] if r[si] and r[mi]]
        if not out:
            raise FatalError("No row with both Subject and Messages found in the Excel file.")
        return out   # every row is one template; they are used in rotation

    # ---------- persistence ----------
    def save(self):
        self.state["page"] = self.cur_page
        self.state["results_url"] = self.results_url or self.state.get("results_url", "")
        Path(CONFIG["progress_file"]).write_text(json.dumps(self.state, indent=2), "utf-8")

    def record(self, lead, status, detail="", tpl="", text=""):
        self.state["done"][lead["id"]] = {
            "name": lead["name"], "status": status, "detail": detail,
            "time": datetime.now().isoformat(timespec="seconds"),
        }
        self.save()
        csvp = Path(CONFIG["results_csv"])
        if csvp.exists() and "template_no" not in csvp.read_text("utf-8-sig").split("\n", 1)[0]:
            csvp.rename(csvp.with_name("results_log_old.csv"))   # old header format
        new = not csvp.exists()
        with open(CONFIG["results_csv"], "a", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["time", "page", "name", "lead_id", "url", "status", "detail", "template_no", "replied"])
            w.writerow([datetime.now().isoformat(timespec="seconds"), self.cur_page,
                        lead["name"], lead["id"], lead.get("url", ""), status, detail, tpl, ""])
        if status != "sending":     # the transient pre-send marker is not a result
            self.log_xlsx(lead, status, detail, tpl, text)

    XLSX_LABEL = {"confirmed": "Sent", "sending": "Failed", "send_unverified": "Failed",
                  "credit_skipped": "Skipped", "uncertain_skipped": "Skipped", "declined": "Skipped",
                  "free_detected": "Free (detect only)"}

    def log_xlsx(self, lead, status, detail, tpl, text):
        """Append one row to the Excel log. Never crashes the run (e.g. file open in Excel)."""
        try:
            p = Path(CONFIG["log_xlsx"])
            if p.exists():
                wb = load_workbook(p)
                ws = wb.active
            else:
                wb = Workbook()
                ws = wb.active
                ws.title = "Log"
                ws.append(["Date", "Time", "Name", "Profile link", "Result", "Reason", "Template", "Message sent"])
                for col, w in zip("ABCDEFGH", (12, 10, 28, 50, 18, 36, 10, 90)):
                    ws.column_dimensions[col].width = w
            now = datetime.now()
            ws.append([now.strftime("%Y-%m-%d"), now.strftime("%H:%M:%S"), lead["name"], lead.get("url", ""),
                       ("Sent (credit)" if status == "confirmed" and "credit" in detail.lower()
                        else self.XLSX_LABEL.get(status, status)), detail, tpl, text])
            wb.save(p)
        except Exception:
            pass

    def mode(self):
        """'detect' = look only | 'free' = message free profiles | 'credit' = message credit profiles."""
        m = getattr(self.args, "mode", None)
        return m or ("detect" if getattr(self.args, "detect_only", False) else "free")

    def today(self):
        return datetime.now().strftime("%Y-%m-%d")

    def credits_today(self):
        return self.state.setdefault("credit_daily", {}).get(self.today(), 0)

    def cap_reached(self):
        if self.mode() == "credit":
            return self.credits_today() >= CONFIG["max_credits_per_day"]
        return self.sent_today() >= CONFIG["max_per_day"]

    def eligible(self, lid):
        st = self.state["done"].get(lid, {}).get("status")
        if st in (None, "free_detected", "free_left"):
            return True
        return self.mode() == "credit" and st == "credit_skipped"

    def sent_today(self):
        return self.state.setdefault("daily", {}).get(self.today(), 0)

    def cooldown(self):
        secs = CONFIG["between_messages_s"]
        self.set_action(f"Fixed pause of {secs}s after the sent message (pause/stop still work)...")
        end = time.time() + secs
        while time.time() < end:
            self.ctl.poll()
            if self.ctl.stop:
                raise Stop()
            if self.ctl.paused:
                self.checkpoint()
            time.sleep(0.5)

    # ---------- dashboard ----------
    def counts(self):
        st = [v["status"] for v in self.state["done"].values()]
        return {
            "free": sum(s in ("confirmed", "declined", "free_detected", "free_left", "send_unverified", "sending") for s in st),
            "credit": st.count("credit_skipped"),
            "uncertain": st.count("uncertain_skipped") + st.count("sending"),
            "confirmed": st.count("confirmed"),
        }

    def snapshot(self):
        c = self.counts()
        return {
            "browser": self.browser_state, "page": self.cur_page, "profile": self.cur_name,
            "discovered": len(self.state["discovered"]), "processed": len(self.state["done"]),
            "free": c["free"], "credit": c["credit"], "uncertain": c["uncertain"],
            "pending": self.pending, "confirmed": c["confirmed"], "action": self.action,
        }

    def render(self):
        if self.on_render:
            self.on_render(self.snapshot())
            return
        c = self.counts()
        os.system("cls" if os.name == "nt" else "clear")
        print("LINKEDIN RPA AUTOMATION")
        print(f"Browser: {self.browser_state}")
        print(f"Current Page: {self.cur_page}")
        print(f"Current Profile: {self.cur_name}")
        print(f"Profiles Discovered: {len(self.state['discovered'])}")
        print(f"Profiles Processed: {len(self.state['done'])}")
        print(f"Free Options: {c['free']}")
        print(f"Credit Required: {c['credit']}")
        print(f"Uncertain: {c['uncertain']}")
        print(f"Awaiting Approval: {self.pending}")
        print(f"Messages Confirmed: {c['confirmed']}")
        print("Current Action:")
        print(f"{self.action}")
        print("\nCommands: p=pause  r=resume  s=stop  y=send current draft  n=discard current draft")
        sys.stdout.flush()

    def set_action(self, text):
        self.action = text
        self.render()

    # ---------- safe points ----------
    def checkpoint(self, action=None):
        if action:
            self.set_action(action)
        self.ctl.poll()
        if self.ctl.stop:
            raise Stop()
        if self.ctl.paused:
            self.browser_state = "PAUSED"
            self.save()
            self.set_action("PAUSED - type r + Enter to resume, s + Enter to stop.")
            while self.ctl.paused and not self.ctl.stop:
                time.sleep(0.25)
                self.ctl.poll()
            if self.ctl.stop:
                raise Stop()
            self.browser_state = "RUNNING"
            self.set_action("Resuming...")

    def delay(self):
        if CONFIG["action_delay_ms"] > 0:
            time.sleep(CONFIG["action_delay_ms"] / 1000)

    # ---------- waiting helpers (condition based) ----------
    def wait_loaded(self, timeout):
        self.page.wait_for_load_state("domcontentloaded", timeout=timeout)
        for sel in CONFIG["loading_selectors"]:
            try:
                self.page.locator(sel).first.wait_for(state="hidden", timeout=3000)
            except PWTimeout:
                pass

    def first_visible(self, locators, timeout):
        deadline = time.time() + timeout / 1000
        while time.time() < deadline:
            for loc in locators:
                try:
                    if loc.first.is_visible():
                        return loc.first
                except Exception:
                    pass
            time.sleep(0.2)
        return None

    def check_session(self):
        url = self.page.url.lower()
        if any(part in url for part in CONFIG["login_url_parts"]):
            raise FatalError("LinkedIn is asking for login/verification. Log in manually "
                             "in the automation Chrome window, then run again (progress is saved).")
        try:
            head = self.page.evaluate("() => (document.body ? document.body.innerText : '').slice(0, 1500)")
        except Exception:
            head = ""
        if BLOCK_RE.search(head):
            raise FatalError("LinkedIn is showing a security check / CAPTCHA. Solve it yourself in "
                             "Chrome, then start again. The bot never continues past it on its own.")
        if RESTRICT_RE.search(head):
            raise FatalError("LinkedIn is showing an account restriction warning. Stopped. "
                             "Do not continue today.")

    # ---------- search results ----------
    def on_search_page(self):
        return CONFIG["search_url_part"] in self.page.url

    def collect_leads(self):
        page = self.page
        links = page.locator(CONFIG["lead_link"])
        try:
            links.first.wait_for(state="visible", timeout=CONFIG["search_results_timeout_ms"])
        except PWTimeout:
            raise FatalError("Search results did not appear.")
        prev, stable = -1, 0
        for _ in range(40):  # scroll until the lazy list stops growing
            n = links.count()
            stable = stable + 1 if n == prev else 0
            if stable >= 2:
                break
            prev = n
            links.last.scroll_into_view_if_needed()
            end = time.time() + 2
            while time.time() < end and links.count() == n:
                time.sleep(0.2)
        raw = links.evaluate_all("els => els.map(e => [e.getAttribute('href'), e.innerText])")
        leads, seen = [], set()
        for href, text in raw:
            m = re.search(r"/sales/lead/([^,/?]+)", href or "")
            name = (text or "").strip().split("\n")[0].strip()
            if not m or not name:
                continue
            lid = m.group(1)
            if lid in seen:
                continue
            seen.add(lid)
            leads.append({"id": lid, "name": name, "url": "https://www.linkedin.com" + href})
        links.first.scroll_into_view_if_needed()
        return leads

    # ---------- messaging window ----------
    def compose_title(self):
        return self.page.get_by_text(CONFIG["compose_title"], exact=True).first

    def classify(self, timeout):
        """Return 'free' | 'credit' | 'uncertain' from the compose header area."""
        title = self.compose_title()
        title.wait_for(state="visible", timeout=timeout)
        result = "uncertain"
        deadline = time.time() + timeout / 1000
        while time.time() < deadline:
            result = "uncertain"
            for level in (1, 2, 3):
                try:
                    txt = title.locator(f"xpath=ancestor::*[{level}]").inner_text(timeout=1500)
                except Exception:
                    continue
                free = re.search(CONFIG["free_regex"], txt, re.I)
                credit = re.search(CONFIG["credit_regex"], txt, re.I)
                if free and credit:
                    result = "uncertain"
                    break
                if free:
                    result = "free"
                    break
                if credit:
                    result = "credit"
                    break
            if result != "uncertain":
                return result
            time.sleep(0.3)
        return result

    def close_compose(self):
        title = self.compose_title()
        if not title.is_visible():
            return
        closer = None
        for level in (2, 3, 4):
            btn = title.locator(f"xpath=ancestor::*[{level}]").get_by_role(
                "button", name=re.compile(r"close|dismiss", re.I))
            if btn.count():
                closer = btn.first
                break
        if closer:
            closer.click()
        else:
            self.page.keyboard.press("Escape")
        try:  # optional "discard draft" confirmation
            self.page.get_by_role("button", name=re.compile(r"discard|delete draft|don.?t save", re.I)) \
                .first.click(timeout=2000)
        except Exception:
            pass
        try:
            title.wait_for(state="hidden", timeout=CONFIG["messaging_ui_timeout_ms"])
        except PWTimeout:
            raise FatalError("Could not close the message window. Please close it manually.")

    def read_field(self, loc):
        try:
            return loc.input_value(timeout=1000)
        except Exception:
            return loc.inner_text(timeout=1000)

    def draft(self, subject, body_text):
        page = self.page
        t = CONFIG["field_timeout_ms"]
        self.checkpoint("Typing subject...")
        subj = self.first_visible([page.get_by_placeholder(re.compile("subject", re.I)),
                                   page.locator("input[name*='subject' i]")], t)
        if not subj:
            return False
        subj.click()
        subj.press_sequentially(subject, delay=CONFIG["typing_delay_ms"])
        self.delay()

        self.checkpoint("Typing message...")
        body = self.first_visible([page.get_by_placeholder(re.compile("type your message", re.I)),
                                   page.locator("textarea"),
                                   page.locator("[contenteditable='true'][role='textbox']")], t)
        if not body:
            return False
        body.click()
        lines = body_text.split("\n")
        for i, line in enumerate(lines):
            self.checkpoint("Typing message...")
            if line:
                body.press_sequentially(line, delay=CONFIG["typing_delay_ms"])
            if i < len(lines) - 1:
                body.press("Shift+Enter")
        self.delay()
        probe = re.sub(r"\s+", " ", body_text)[:25]
        got = re.sub(r"\s+", " ", self.read_field(body))
        return probe in got and subject[:15] in self.read_field(subj)

    # ---------- per-profile workflow ----------
    def process_lead(self, lead):
        page = self.page
        self.cur_name = lead["name"]
        self.checkpoint(f"Clicking profile link: {lead['name']}")
        link = page.locator(f'a[href*="{lead["id"]}"]').filter(has_text=re.compile(r"\S")).first
        link.scroll_into_view_if_needed()
        self.delay()
        link.click()
        try:
            page.wait_for_url(re.compile(r"/sales/lead/"), timeout=CONFIG["navigation_timeout_ms"])
            self.wait_loaded(CONFIG["profile_info_timeout_ms"])
        except PWTimeout:
            raise FatalError(f"Profile page failed to load for {lead['name']}.")
        self.check_session()

        self.checkpoint("Scrolling profile information...")
        for _ in range(CONFIG["profile_scroll_steps"]):
            page.mouse.wheel(0, CONFIG["profile_scroll_pixels"])
            self.delay()
        page.mouse.wheel(0, -CONFIG["profile_scroll_pixels"] * CONFIG["profile_scroll_steps"])

        self.checkpoint("Locating messaging control...")
        btn = self.first_visible(
            [page.get_by_role("button", name=re.compile(CONFIG["message_button_name"], re.I))],
            CONFIG["profile_info_timeout_ms"])
        if not btn:
            self.record(lead, "uncertain_skipped", "No Message button found")
            return self.back_to_results()

        self.checkpoint("Opening messaging window...")
        btn.click()
        self.delay()
        try:
            self.checkpoint("Checking messaging availability...")
            kind = self.classify(CONFIG["messaging_ui_timeout_ms"])
        except PWTimeout:
            kind = "uncertain"
            self.record(lead, "uncertain_skipped", "Messaging window did not appear")
            return self.back_to_results()

        try:
            mode = self.mode()
            if kind == "uncertain":
                self.record(lead, "uncertain_skipped", "Could not confirm free or credit messaging")
            elif mode == "detect":
                if kind == "free":
                    self.record(lead, "free_detected", "detect-only mode, nothing typed")
                else:
                    self.record(lead, "credit_skipped", "Credit required")
            elif mode == "free":
                if kind == "free":
                    self.free_flow(lead, paid=False)
                else:
                    self.record(lead, "credit_skipped", "Credit required")
            else:  # mode == "credit"
                if kind == "credit":
                    self.free_flow(lead, paid=True)
                else:
                    self.record(lead, "free_left", "Free profile - left for the free-message mode")
        except Stop:
            self.pending = 0
            self.close_compose()
            raise
        self.checkpoint("Closing messaging window...")
        if self.compose_title().is_visible():
            self.close_compose()
        self.back_to_results()

    def free_flow(self, lead, paid=False):
        idx = self.state.get("next_tpl", 0) % len(self.templates)
        subject, body_text = self.templates[idx]
        full = re.split(r"[,(]", lead["name"])[0].strip()          # drop ", C.E.T." / "(Joe)" style suffixes
        first = full.split()[0] if full else ""
        subject = subject.replace("{first_name}", first).replace("{full_name}", full)
        body_text = body_text.replace("{first_name}", first).replace("{full_name}", full)
        tpl = idx + 1
        if not self.draft(subject, body_text):
            self.record(lead, "uncertain_skipped", "Could not fill fields reliably")
            return
        if getattr(self.args, "auto", False):
            decision = "y"   # unattended mode: free + verified profiles only, daily cap enforced
        else:
            self.pending = 1
            self.set_action(f"AWAITING APPROVAL for {lead['name']}"
                            f"{' (USES 1 CREDIT)' if paid else ''}. Review the message on screen.\n"
                            f"Type  y + Enter to SEND,  n + Enter to discard.")
            decision = self.ctl.wait_for({"y", "yes", "n", "no"})
            self.pending = 0
        if decision in ("n", "no"):
            self.record(lead, "declined", "You declined to send", tpl)
            return
        if not CONFIG["send_after_approval"]:
            self.record(lead, "declined", "send_after_approval is False; draft not sent")
            return
        # re-verify still free right before sending
        if self.classify(3000) != ("credit" if paid else "free"):
            self.record(lead, "uncertain_skipped", "Free/credit status changed before send")
            return
        send = self.page.get_by_role("button", name=re.compile(r"^\s*Send\s*$", re.I)).first
        self.checkpoint("Sending approved message...")
        self.record(lead, "sending", "Clicking Send", tpl)   # marker BEFORE click
        send.click()
        try:
            self.compose_title().wait_for(state="hidden", timeout=CONFIG["messaging_ui_timeout_ms"])
            how = "Sent (auto)" if getattr(self.args, "auto", False) else "Sent after your approval"
            self.record(lead, "confirmed", how + (" - used 1 credit" if paid else ""), tpl,
                        f"Subject: {subject}\n\n{body_text}")
            self.state["next_tpl"] = idx + 1
            if paid:
                self.state.setdefault("credit_daily", {})[self.today()] = self.credits_today() + 1
            else:
                self.state.setdefault("daily", {})[self.today()] = self.sent_today() + 1
            self.save()
            self.cooldown()
        except PWTimeout:
            self.record(lead, "send_unverified", "Could not confirm the send", tpl, f"Subject: {subject}\n\n{body_text}")
            raise FatalError("Could not confirm the message was sent. Check LinkedIn manually; "
                             "this profile will NOT be retried.")

    def back_to_results(self):
        page = self.page
        self.checkpoint("Returning to search results...")
        page.go_back(wait_until="domcontentloaded")
        try:
            page.wait_for_url(re.compile(re.escape(CONFIG["search_url_part"])),
                              timeout=CONFIG["navigation_timeout_ms"])
        except PWTimeout:
            page.goto(self.results_url, wait_until="domcontentloaded")
        self.wait_loaded(CONFIG["search_results_timeout_ms"])
        self.check_session()
        page.locator(CONFIG["lead_link"]).first.wait_for(
            state="visible", timeout=CONFIG["search_results_timeout_ms"])
        self.processed_this_run += 1
        self.delay()

    # ---------- pagination ----------
    def next_page(self):
        page = self.page
        btn = page.get_by_role("button", name=re.compile(CONFIG["next_button_name"], re.I))
        if btn.count() == 0 or not btn.first.is_enabled():
            return False
        first_before = page.locator(CONFIG["lead_link"]).first.get_attribute("href")
        self.checkpoint("Clicking Next...")
        btn.first.scroll_into_view_if_needed()
        self.delay()
        btn.first.click()
        deadline = time.time() + CONFIG["pagination_timeout_ms"] / 1000
        while time.time() < deadline:
            try:
                cur = page.locator(CONFIG["lead_link"]).first.get_attribute("href", timeout=1000)
            except Exception:
                cur = first_before
            if cur and cur != first_before:
                self.cur_page += 1
                self.wait_loaded(CONFIG["pagination_timeout_ms"])
                return True
            time.sleep(0.3)
        raise FatalError("Next page did not load.")

    # ---------- main ----------
    def limit_reached(self):
        return self.args.limit and self.processed_this_run >= self.args.limit

    def run(self):
        self.render()
        self.set_action("Launching / attaching to visible Chrome...")
        ensure_chrome()
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{CONFIG['debug_port']}")
            self.context = browser.contexts[0]
            self.browser_state = "RUNNING"

            pages = self.context.pages
            self.page = next((pg for pg in pages if CONFIG["search_url_part"] in pg.url), None)
            if not self.page:
                self.page = next((pg for pg in pages if pg.url in ("about:blank", "chrome://newtab/")),
                                 pages[0] if pages else self.context.new_page())
            self.page.bring_to_front()
            maximize(self.context, self.page)
            self.page.set_default_timeout(CONFIG["field_timeout_ms"])

            target = self.args.search_url or CONFIG["search_url"]
            saved = "" if self.args.fresh else self.state.get("results_url", "")
            forced = bool(self.args.search_url)   # a specific search was requested: always open it
            if forced or not self.on_search_page():
                if forced or saved or target:
                    self.set_action("Opening search page...")
                    self.page.goto(self.args.search_url or saved or target, wait_until="domcontentloaded",
                                   timeout=CONFIG["navigation_timeout_ms"])
                    self.wait_loaded(CONFIG["navigation_timeout_ms"])
                else:
                    try:  # show something visible in Chrome instead of a blank tab
                        self.page.goto(CONFIG["start_url"], wait_until="domcontentloaded",
                                       timeout=CONFIG["navigation_timeout_ms"])
                    except Exception:
                        pass
                    self.set_action("In the Chrome window: log in (first time only) and open your\n"
                                    "Sales Navigator lead search. Then type  go + Enter  here.")
                    self.ctl.wait_for({"go"})
            self.check_session()
            if not self.on_search_page():
                raise FatalError("The active tab is not a Sales Navigator people search.")
            self.results_url = self.page.url

            while True:
                self.checkpoint("Waiting for search results...")
                self.wait_loaded(CONFIG["search_results_timeout_ms"])
                self.results_url = self.page.url
                self.checkpoint("Discovering profiles on this page...")
                leads = self.collect_leads()
                for l in leads:
                    if l["id"] not in self.state["discovered"]:
                        self.state["discovered"].append(l["id"])
                self.save()

                todo = [l for l in leads if self.eligible(l["id"])]
                for lead in todo:
                    if self.limit_reached():
                        break
                    if self.mode() != "detect" and self.cap_reached():
                        raise DailyLimit()
                    self.process_lead(lead)
                if self.limit_reached():
                    self.set_action(f"Run limit ({self.args.limit}) reached. Progress saved.")
                    return
                self.checkpoint("Checking for next page...")
                if not self.next_page():
                    self.set_action("No more pages. All done. Progress saved.")
                    return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fresh", action="store_true", help="ignore saved progress")
    ap.add_argument("--limit", type=int, default=0, help="max profiles this run")
    ap.add_argument("--detect-only", action="store_true", help="classify messaging, type nothing")
    ap.add_argument("--search-url", default="")
    ap.add_argument("--mode", choices=["detect", "free", "credit"], default="free",
                    help="detect = look only | free = message free profiles | credit = message credit profiles")
    ap.add_argument("--max-credits-per-day", type=int, default=0)
    ap.add_argument("--auto", action="store_true",
                    help="unattended: send free-profile messages without per-message approval (daily cap applies)")
    ap.add_argument("--max-per-day", type=int, default=0, help="override CONFIG max_per_day")
    args = ap.parse_args()
    if args.max_per_day:
        CONFIG["max_per_day"] = args.max_per_day
    if args.max_credits_per_day:
        CONFIG["max_credits_per_day"] = args.max_credits_per_day
    if args.detect_only:
        args.mode = "detect"

    app = None
    try:
        app = App(args)
        app.run()
        code = 0
    except Stop:
        print("\nSTOPPED by user. Progress saved. Chrome left open.")
        code = 0
    except DailyLimit:
        print("\nDaily limit reached. Run again tomorrow.")
        code = 0
    except FatalError as e:
        print(f"\nERROR - stopped, nothing retried:\n{e}")
        code = 1
    except Exception as e:  # Chrome closed, page crashed, etc.
        print(f"\nERROR - stopped, nothing retried: {type(e).__name__}: {e}")
        print("If Chrome closed, re-run; saved progress will be used (no profile is repeated).")
        code = 1
    finally:
        if app:
            try:
                app.pending = 0
                app.save()
            except Exception:
                pass
    sys.exit(code)


if __name__ == "__main__":
    main()
