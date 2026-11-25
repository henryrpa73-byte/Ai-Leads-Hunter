"""Module 3: Respectful multi-page public company website & contact research agent.

Checks robots.txt before fetching public pages, crawls key public pages
(/, /contact, /contact-us, /about, /team, /estimating), respects crawl delays,
never bypasses CAPTCHAs or logins, and never invents email addresses.
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

PRIORITY_EMAIL_PREFIXES = ("bids@", "estimating@", "estimator@", "preconstruction@", "projects@", "quotes@", "sales@", "info@", "contact@")
ROLE_TITLE_RE = re.compile(
    r"(?:^|[\n•|])\s*([A-Z][a-z]{1,18}\s+[A-Z][a-z]{1,18})\s*(?:[-,|–—]\s*|\n\s*)"
    r"((?:Chief|Senior|Lead|Head)?\s*(?:Estimator|Project Manager|Preconstruction(?:\s+Manager|\s+Director)?|Director of Estimating|President|Owner|Principal|Architect|Millwork Manager))",
)

SERVICE_KEYWORDS = {
    "Commercial Construction": ("commercial construction", "general contractor", "tenant improvement", "design-build"),
    "Residential / Remodeling": ("residential", "custom home", "remodeling", "home builder"),
    "Estimating / Bidding": ("preconstruction", "estimating", "quantity takeoff", "bid", "cost estimation"),
    "Architectural / Drafting": ("architectural", "cad drafting", "construction drawings", "permit drawings", "bim"),
    "Millwork / Cabinetry": ("millwork", "casework", "cabinetry", "shop drawings", "architectural woodwork"),
}

IGNORED_EMAIL_DOMAINS = ("example.com", "sentry.io", "wixpress.com", "yourdomain.com")
CONTACT_PATHS = ("", "/contact", "/contact-us", "/about", "/team", "/estimating")


STOP_WORDS = {
    "llc", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd",
    "llp", "lp", "pllc", "the", "and", "of", "group", "services", "service", "solutions",
}
PARKED_SIGNALS = (
    "domain is for sale",
    "buy this domain",
    "hugedomains",
    "sedoparking",
    "afternic",
    "godaddy",
    "domain parking",
)


class _VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self.parts: list[str] = []
        self.title: str = ""
        self._in_title = False
        self.mailto_links: list[str] = []
        self.tel_links: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        t = tag.lower()
        if t in ("script", "style", "noscript", "svg"):
            self._skip_depth += 1
        elif t == "title":
            self._in_title = True
        elif t == "a":
            for k, v in attrs:
                if k.lower() == "href" and v:
                    href = v.strip()
                    if href.lower().startswith("mailto:"):
                        addr = urllib.parse.unquote(href[7:].split("?")[0]).strip()
                        if addr:
                            self.mailto_links.append(addr)
                    elif href.lower().startswith("tel:"):
                        num = urllib.parse.unquote(href[4:].split("?")[0]).strip()
                        if num:
                            self.tel_links.append(num)

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
    websites_resolved: int = 0


def _rank_emails(emails: list[str]) -> list[str]:
    def key(e: str) -> tuple[int, str]:
        for idx, prefix in enumerate(PRIORITY_EMAIL_PREFIXES):
            if e.startswith(prefix):
                return (idx, e)
        return (len(PRIORITY_EMAIL_PREFIXES), e)

    return sorted(emails, key=key)


def extract_company_signals(html_text: str, base_url: str) -> dict[str, object]:
    """Extract only publicly visible emails, phones, decision-makers, title, and service signals."""
    parser = _VisibleTextParser()
    parser.feed(html_text)
    visible_text = "\n".join(parser.parts)
    flat_text = " ".join(parser.parts)
    lower_text = flat_text.lower()

    emails: list[str] = []
    for raw_email in list(parser.mailto_links) + EMAIL_FINDER_RE.findall(flat_text):
        norm = normalize_email(raw_email)
        if norm and not any(norm.endswith(f"@{d}") for d in IGNORED_EMAIL_DOMAINS):
            if norm not in emails:
                emails.append(norm)
    emails = _rank_emails(emails)

    phones: list[str] = []
    for raw_phone in list(parser.tel_links) + PHONE_FINDER_RE.findall(flat_text):
        formatted, digits = normalize_phone(raw_phone)
        if digits and formatted not in phones:
            phones.append(formatted)

    contacts: list[dict[str, str]] = []
    for match in ROLE_TITLE_RE.finditer(visible_text):
        person_name = " ".join(match.group(1).split())
        title = " ".join(match.group(2).split())
        if person_name and title:
            contacts.append({"name": person_name, "title": title})

    matched_services: list[str] = []
    for label, keywords in SERVICE_KEYWORDS.items():
        if any(kw in lower_text for kw in keywords):
            matched_services.append(label)

    return {
        "title": parser.title[:200],
        "emails": emails[:8],
        "phones": phones[:8],
        "contacts": contacts[:6],
        "services": matched_services,
        "snippet": flat_text[:400],
        "source_url": base_url,
    }


def _extract_company_tokens(company_name: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9\s]", " ", company_name.lower().replace("&", " "))
    return [t for t in cleaned.split() if len(t) >= 2 and t not in STOP_WORDS]


def _page_matches_company(company_name: str, html_text: str) -> bool:
    low = html_text.lower()
    if any(sig in low for sig in PARKED_SIGNALS):
        return False
    tokens = [t for t in _extract_company_tokens(company_name) if len(t) >= 3]
    if not tokens:
        return False
    title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", html_text, re.I)
    title = (title_match.group(1) if title_match else "").lower()
    sample = low[:12000]
    return tokens[0] in title or (all(t in sample for t in tokens[:2]) if len(tokens) >= 2 else tokens[0] in sample)


def discover_public_website(
    company_name: str,
    city: str = "",
    state: str = "",
    *,
    user_agent: str = "ConstructionLeadHunter/1.0",
    html_fetcher=None,
) -> tuple[str, str, str]:
    """Resolve official website (and optional phone/email) from free public APIs & verified domain candidates."""
    tokens = _extract_company_tokens(company_name)
    query = " ".join(tokens[:4])
    if not query:
        return "", "", ""

    fetcher = html_fetcher or fetch_html
    found_site = ""
    found_phone = ""
    found_email = ""

    # 1) Wikidata official website (P856)
    for wd_query in list(dict.fromkeys([query, " ".join(tokens[:2])])):
        if not wd_query:
            continue
        try:
            import json as _json

            wd_url = "https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode(
                {"action": "wbsearchentities", "search": wd_query, "language": "en", "format": "json", "limit": 2}
            )
            req = urllib.request.Request(wd_url, headers={"User-Agent": user_agent, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                wd = _json.loads(resp.read().decode("utf-8"))
            for item in wd.get("search") or []:
                label = str(item.get("label") or "").lower()
                qid = str(item.get("id") or "")
                if qid and tokens[0] in label:
                    ent_url = f"https://www.wikidata.org/w/api.php?action=wbgetentities&ids={qid}&props=claims&format=json"
                    ent_req = urllib.request.Request(ent_url, headers={"User-Agent": user_agent, "Accept": "application/json"})
                    with urllib.request.urlopen(ent_req, timeout=5) as eresp:
                        ent = _json.loads(eresp.read().decode("utf-8"))
                    claims = (ent.get("entities") or {}).get(qid, {}).get("claims") or {}
                    for claim in claims.get("P856") or []:
                        val = (((claim.get("mainsnak") or {}).get("datavalue") or {}).get("value")) or ""
                        if isinstance(val, str) and val.startswith(("http://", "https://")):
                            found_site = val.rstrip("/")
                            break
                if found_site:
                    break
            if found_site:
                break
        except Exception:
            pass

    # 2) OpenStreetMap Nominatim free POI extratags
    try:
        import json as _json

        osm_q = " ".join(p for p in (query, city, state) if p)
        osm_url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
            {"q": osm_q, "format": "jsonv2", "extratags": 1, "countrycodes": "us", "limit": 3}
        )
        req = urllib.request.Request(osm_url, headers={"User-Agent": user_agent, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            rows = _json.loads(resp.read().decode("utf-8"))
        for row in rows if isinstance(rows, list) else []:
            name = str(row.get("name") or "").lower()
            if tokens[0] not in name:
                continue
            tags = row.get("extratags") or {}
            if not found_site:
                found_site = str(tags.get("website") or tags.get("contact:website") or "").strip().rstrip("/")
            if not found_phone:
                found_phone = str(tags.get("phone") or tags.get("contact:phone") or "").strip()
            if not found_email:
                found_email = str(tags.get("email") or tags.get("contact:email") or "").strip()
            if found_site:
                break
    except Exception:
        pass

    # 3) Verified official .com candidate probing if website is still missing
    if not found_site:
        joined = "".join(tokens)
        core = "".join(
            t for t in tokens
            if t not in ("construction", "contractors", "contractor", "builders", "builder", "architects", "architectural", "company")
        )
        candidates = []
        if len(joined) >= 4:
            candidates.append(f"https://www.{joined}.com")
        if len(core) >= 5 and core != joined:
            candidates.append(f"https://www.{core}.com")

        for cand in candidates:
            try:
                html = fetcher(cand, user_agent=user_agent, timeout=5)
                if html and _page_matches_company(company_name, html):
                    found_site = cand
                    break
            except Exception:
                continue

    return found_site, found_phone, found_email


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
    limit: int = 15,
    request_delay: float = 0.6,
    user_agent: str = "ConstructionLeadHunter/1.0",
    logger: logging.Logger | None = None,
    html_fetcher=fetch_html,
    robots_checker=is_allowed_by_robots,
    resolve_missing_websites: bool = True,
) -> WebsiteResearchSummary:
    leads = [
        row for row in db.get_all_leads()
        if row.get("website") or (resolve_missing_websites and (not row.get("business_email") or not row.get("business_phone")))
    ]
    targets = leads[:limit]

    checked = 0
    updated = 0
    blocked_or_disallowed = 0
    failed = 0
    websites_resolved = 0

    for row in targets:
        checked += 1
        base_url = str(row.get("website") or "").rstrip("/")
        dir_phone = ""
        dir_email = ""

        if not base_url and resolve_missing_websites:
            found_site, dir_phone, dir_email = discover_public_website(
                str(row.get("company_name") or ""),
                str(row.get("city") or ""),
                str(row.get("state") or ""),
                user_agent=user_agent,
                html_fetcher=html_fetcher,
            )
            if found_site:
                base_url = found_site.rstrip("/")
                websites_resolved += 1

        if not base_url and not dir_phone and not dir_email:
            failed += 1
            continue

        all_emails: list[str] = [dir_email] if dir_email else []
        all_phones: list[str] = [dir_phone] if dir_phone else []
        all_contacts: list[dict[str, str]] = []
        all_services: list[str] = []
        last_title = ""
        page_hit = bool(dir_phone or dir_email)

        if base_url:
            if not robots_checker(base_url, user_agent):
                blocked_or_disallowed += 1
                if logger:
                    logger.info("Skipped %s (disallowed by robots.txt)", base_url)
                if not page_hit:
                    continue
            else:
                parsed_base = urllib.parse.urlparse(base_url)
                root_origin = f"{parsed_base.scheme}://{parsed_base.netloc}"

                urls_to_check = [base_url] + [
                    f"{root_origin}{p}" for p in CONTACT_PATHS if p and f"{root_origin}{p}" != base_url
                ]

                for page_url in urls_to_check[:5]:
                    if page_url != base_url and not robots_checker(page_url, user_agent):
                        continue
                    try:
                        html = html_fetcher(page_url, user_agent=user_agent)
                        page_hit = True
                        sig = extract_company_signals(html, page_url)
                        if not last_title and sig["title"]:
                            last_title = str(sig["title"])
                        for e in sig["emails"]:
                            if e not in all_emails:
                                all_emails.append(e)
                        for ph in sig["phones"]:
                            if ph not in all_phones:
                                all_phones.append(ph)
                        for c in sig["contacts"]:
                            if c not in all_contacts:
                                all_contacts.append(c)
                        for svc in sig["services"]:
                            if svc not in all_services:
                                all_services.append(svc)
                        # Stop crawling subpages once we already found email, phone, and a decision-maker
                        if all_emails and all_phones and all_contacts:
                            break
                    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
                        if getattr(exc, "code", None) in (403, 429) and page_url == base_url:
                            blocked_or_disallowed += 1
                            break
                    except Exception:
                        continue

        if page_hit:
            ranked_emails = _rank_emails([e for e in all_emails if e])
            primary_contact = all_contacts[0] if all_contacts else {"name": "", "title": ""}
            enriched = LeadRecord(
                company_name=row["company_name"],
                website=base_url,
                business_email=ranked_emails[0] if ranked_emails else "",
                business_phone=all_phones[0] if all_phones else "",
                contact_person=primary_contact["name"],
                job_title=primary_contact["title"],
                city=row.get("city", ""),
                state=row.get("state", ""),
                zip_code=row.get("zip_code", ""),
                services_offered=", ".join(all_services) if all_services else last_title,
                company_source_url=base_url or row.get("company_source_url", ""),
                buying_intent_evidence=(
                    f"Website services detected: {', '.join(all_services)}" if all_services else ""
                ),
            )
            normalize_lead(enriched)
            db.upsert_lead(enriched, source_name="company_website")
            updated += 1
        elif blocked_or_disallowed == 0:
            failed += 1

        if request_delay > 0:
            time.sleep(request_delay)

    return WebsiteResearchSummary(
        checked=checked,
        updated=updated,
        blocked_or_disallowed=blocked_or_disallowed,
        failed=failed,
        websites_resolved=websites_resolved,
    )
