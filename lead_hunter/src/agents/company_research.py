"""Module 3: Respectful public company website research agent.

Checks robots.txt before fetching public pages, respects crawl delays,
never bypasses CAPTCHAs or logins, and never invents contact details.
"""

from __future__ import annotations

import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from dataclasses import dataclass
from html.parser import HTMLParser

from ..database import LeadDatabase
from ..models import LeadRecord
from ..normalizer import normalize_email, normalize_lead, normalize_phone


EMAIL_FINDER_RE = re.compile(r"\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b")
PHONE_FINDER_RE = re.compile(r"(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}")

SERVICE_KEYWORDS = {
    "Commercial Construction": ("commercial construction", "general contractor", "tenant improvement", "design-build"),
    "Residential / Remodeling": ("residential", "custom home", "remodeling", "home builder"),
    "Estimating / Bidding": ("preconstruction", "estimating", "quantity takeoff", "bid", "cost estimation"),
    "Architectural / Drafting": ("architectural", "cad drafting", "construction drawings", "permit drawings", "bim"),
    "Millwork / Cabinetry": ("millwork", "casework", "cabinetry", "shop drawings", "architectural woodwork"),
}

IGNORED_EMAIL_DOMAINS = ("example.com", "sentry.io", "wixpress.com", "yourdomain.com")


class _VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self.parts: list[str] = []
        self.title: str = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:
        t = tag.lower()
        if t in ("script", "style", "noscript", "svg"):
            self._skip_depth += 1
        elif t == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t in ("script", "style", "noscript", "svg") and self._skip_depth > 0:
            self._skip_depth -= 1
        elif t == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        cleaned = " ".join(data.split())
        if not cleaned:
            return
        if self._in_title and not self.title:
            self.title = cleaned
        self.parts.append(cleaned)


@dataclass
class WebsiteResearchSummary:
    checked: int
    updated: int
    blocked_or_disallowed: int
    failed: int


def extract_company_signals(html_text: str, base_url: str) -> dict[str, object]:
    """Extract only publicly visible emails, phones, title, and service signals."""
    parser = _VisibleTextParser()
    parser.feed(html_text)
    visible_text = " ".join(parser.parts)
    lower_text = visible_text.lower()

    emails: list[str] = []
    for m in EMAIL_FINDER_RE.findall(visible_text):
        norm = normalize_email(m)
        if norm and not any(norm.endswith(f"@{d}") for d in IGNORED_EMAIL_DOMAINS):
            if norm not in emails:
                emails.append(norm)

    phones: list[str] = []
    for m in PHONE_FINDER_RE.findall(visible_text):
        formatted, digits = normalize_phone(m)
        if digits and formatted not in phones:
            phones.append(formatted)

    matched_services: list[str] = []
    for label, keywords in SERVICE_KEYWORDS.items():
        if any(kw in lower_text for kw in keywords):
            matched_services.append(label)

    return {
        "title": parser.title[:200],
        "emails": emails[:5],
        "phones": phones[:5],
        "services": matched_services,
        "snippet": visible_text[:400],
        "source_url": base_url,
    }


def is_allowed_by_robots(url: str, user_agent: str, robots_fetcher=None) -> bool:
    parsed = urllib.parse.urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    rp = urllib.robotparser.RobotFileParser()
    try:
        if robots_fetcher is not None:
            content = robots_fetcher(robots_url, user_agent)
            rp.parse(content.splitlines())
        else:
            req = urllib.request.Request(robots_url, headers={"User-Agent": user_agent})
            with urllib.request.urlopen(req, timeout=8) as resp:
                rp.parse(resp.read().decode("utf-8", errors="ignore").splitlines())
        return rp.can_fetch(user_agent, url)
    except urllib.error.HTTPError as exc:
        # 404 on robots.txt means no disallow rules; 401/403 means stay away
        return exc.code == 404
    except Exception:
        return True


def fetch_html(url: str, user_agent: str = "ConstructionLeadHunter/1.0", timeout: int = 15) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def research_company_websites(
    db: LeadDatabase,
    *,
    limit: int = 10,
    request_delay: float = 1.0,
    user_agent: str = "ConstructionLeadHunter/1.0",
    logger: logging.Logger | None = None,
    html_fetcher=fetch_html,
    robots_checker=is_allowed_by_robots,
) -> WebsiteResearchSummary:
    leads = [row for row in db.get_all_leads() if row.get("website")]
    targets = leads[:limit]

    checked = 0
    updated = 0
    blocked_or_disallowed = 0
    failed = 0

    for row in targets:
        checked += 1
        url = str(row["website"])
        if not robots_checker(url, user_agent):
            blocked_or_disallowed += 1
            if logger:
                logger.info("Skipped %s (disallowed by robots.txt)", url)
            continue

        try:
            html = html_fetcher(url, user_agent=user_agent)
            signals = extract_company_signals(html, url)
            emails = signals["emails"]
            phones = signals["phones"]
            services = signals["services"]

            enriched = LeadRecord(
                company_name=row["company_name"],
                website=url,
                business_email=emails[0] if emails else "",
                business_phone=phones[0] if phones else "",
                city=row.get("city", ""),
                state=row.get("state", ""),
                zip_code=row.get("zip_code", ""),
                services_offered=", ".join(services) if services else str(signals["title"]),
                company_source_url=url,
                buying_intent_evidence=(
                    f"Website services detected: {', '.join(services)}" if services else ""
                ),
            )
            normalize_lead(enriched)
            db.upsert_lead(enriched, source_name="company_website")
            updated += 1
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            if getattr(exc, "code", None) in (403, 429):
                blocked_or_disallowed += 1
            else:
                failed += 1
            if logger:
                logger.warning("Website research skipped %s: %s", url, exc)
        except Exception as exc:
            failed += 1
            if logger:
                logger.warning("Website research error on %s: %s", url, exc)

        if request_delay > 0:
            time.sleep(request_delay)

    return WebsiteResearchSummary(
        checked=checked,
        updated=updated,
        blocked_or_disallowed=blocked_or_disallowed,
        failed=failed,
    )
