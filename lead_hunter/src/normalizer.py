"""Data normalization utilities for US construction company and project records."""

from __future__ import annotations

import re
from urllib.parse import urlparse

from .models import LeadRecord


US_STATES = {
    "AL": "AL", "ALABAMA": "AL",
    "AK": "AK", "ALASKA": "AK",
    "AZ": "AZ", "ARIZONA": "AZ",
    "AR": "AR", "ARKANSAS": "AR",
    "CA": "CA", "CALIFORNIA": "CA",
    "CO": "CO", "COLORADO": "CO",
    "CT": "CT", "CONNECTICUT": "CT",
    "DE": "DE", "DELAWARE": "DE",
    "FL": "FL", "FLORIDA": "FL",
    "GA": "GA", "GEORGIA": "GA",
    "HI": "HI", "HAWAII": "HI",
    "ID": "ID", "IDAHO": "ID",
    "IL": "IL", "ILLINOIS": "IL",
    "IN": "IN", "INDIANA": "IN",
    "IA": "IA", "IOWA": "IA",
    "KS": "KS", "KANSAS": "KS",
    "KY": "KY", "KENTUCKY": "KY",
    "LA": "LA", "LOUISIANA": "LA",
    "ME": "ME", "MAINE": "ME",
    "MD": "MD", "MARYLAND": "MD",
    "MA": "MA", "MASSACHUSETTS": "MA",
    "MI": "MI", "MICHIGAN": "MI",
    "MN": "MN", "MINNESOTA": "MN",
    "MS": "MS", "MISSISSIPPI": "MS",
    "MO": "MO", "MISSOURI": "MO",
    "MT": "MT", "MONTANA": "MT",
    "NE": "NE", "NEBRASKA": "NE",
    "NV": "NV", "NEVADA": "NV",
    "NH": "NH", "NEW HAMPSHIRE": "NH",
    "NJ": "NJ", "NEW JERSEY": "NJ",
    "NM": "NM", "NEW MEXICO": "NM",
    "NY": "NY", "NEW YORK": "NY",
    "NC": "NC", "NORTH CAROLINA": "NC",
    "ND": "ND", "NORTH DAKOTA": "ND",
    "OH": "OH", "OHIO": "OH",
    "OK": "OK", "OKLAHOMA": "OK",
    "OR": "OR", "OREGON": "OR",
    "PA": "PA", "PENNSYLVANIA": "PA",
    "RI": "RI", "RHODE ISLAND": "RI",
    "SC": "SC", "SOUTH CAROLINA": "SC",
    "SD": "SD", "SOUTH DAKOTA": "SD",
    "TN": "TN", "TENNESSEE": "TN",
    "TX": "TX", "TEXAS": "TX",
    "UT": "UT", "UTAH": "UT",
    "VT": "VT", "VERMONT": "VT",
    "VA": "VA", "VIRGINIA": "VA",
    "WA": "WA", "WASHINGTON": "WA",
    "WV": "WV", "WEST VIRGINIA": "WV",
    "WI": "WI", "WISCONSIN": "WI",
    "WY": "WY", "WYOMING": "WY",
    "DC": "DC", "DISTRICT OF COLUMBIA": "DC",
}

LEGAL_SUFFIXES = {
    "llc", "l.l.c", "l.l.c.", "inc", "inc.", "incorporated", "corp", "corp.",
    "corporation", "co", "co.", "company", "ltd", "ltd.", "limited", "llp",
    "l.l.p.", "lp", "l.p.", "pc", "p.c.", "pa", "p.a.", "pllc", "p.l.l.c.",
    "dba", "the",
}

EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$", re.I)


def clean_text(value: object) -> str:
    if value is None:
        return ""
    s = re.sub(r"\s+", " ", str(value)).strip()
    if s.upper() in {"N/A", "NA", "NONE", "NULL", "-", "--"}:
        return ""
    return s


def normalize_company_name(name: str) -> str:
    """Create a canonical deduplication key for a company name."""
    text = clean_text(name).lower()
    if not text:
        return ""
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    tokens = [t for t in text.split() if t and t not in LEGAL_SUFFIXES]
    return " ".join(tokens)


def normalize_phone(raw: object) -> tuple[str, str]:
    """Return (formatted_phone, 10_digit_key). Reuses US phone rules from spydialer_bot."""
    if raw is None:
        return "", ""
    if isinstance(raw, (int, float)):
        s = str(int(raw))
    else:
        s = clean_text(raw)
    if not s:
        return "", ""
    s = re.sub(r"(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$", "", s, flags=re.I)
    digits = re.sub(r"\D", "", s)
    if len(digits) == 11 and digits[0] == "1":
        digits = digits[1:]
    if len(digits) == 10 and digits[0] not in ("0", "1"):
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}", digits
    return s, ""


def normalize_website(raw: object) -> tuple[str, str]:
    """Return (normalized_url, clean_domain)."""
    text = clean_text(raw)
    if not text:
        return "", ""
    if " " in text or "." not in text:
        return "", ""
    if not re.match(r"^https?://", text, re.I):
        candidate = f"https://{text}"
    else:
        candidate = text
    parsed = urlparse(candidate)
    host = (parsed.netloc or "").lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    if not host or "." not in host:
        return "", ""
    clean_url = f"{parsed.scheme.lower()}://{host}{parsed.path.rstrip('/')}" if parsed.path not in ("", "/") else f"{parsed.scheme.lower()}://{host}"
    return clean_url, host


def normalize_email(raw: object) -> str:
    text = clean_text(raw).lower()
    if not text:
        return ""
    return text if EMAIL_RE.match(text) else ""


def normalize_state(raw: object) -> str:
    text = clean_text(raw).upper()
    if not text:
        return ""
    return US_STATES.get(text, text if len(text) == 2 and text.isalpha() else "")


def normalize_zip(raw: object) -> str:
    if raw is None:
        return ""
    if isinstance(raw, (int, float)):
        s = str(int(raw)).zfill(5)
    else:
        s = clean_text(raw)
    m = re.search(r"\b(\d{5})(?:-\d{4})?\b", s)
    return m.group(1) if m else ""


def normalize_url(raw: object) -> str:
    text = clean_text(raw)
    if not text:
        return ""
    if not re.match(r"^https?://", text, re.I):
        return ""
    parsed = urlparse(text)
    if not parsed.netloc:
        return ""
    return text


def normalize_lead(record: LeadRecord) -> LeadRecord:
    """Normalize all fields and populate deduplication keys in place."""
    record.company_name = clean_text(record.company_name)
    record.normalized_name = normalize_company_name(record.company_name)

    website, domain = normalize_website(record.website)
    record.website = website
    record.domain = domain

    formatted_phone, digits = normalize_phone(record.business_phone)
    record.business_phone = formatted_phone
    record.phone_digits = digits

    record.phone_type = clean_text(record.phone_type).lower()
    record.business_email = normalize_email(record.business_email)
    record.contact_person = clean_text(record.contact_person)
    record.job_title = clean_text(record.job_title)
    record.city = clean_text(record.city).title() if clean_text(record.city) else ""
    record.state = normalize_state(record.state)
    record.zip_code = normalize_zip(record.zip_code)
    record.company_category = clean_text(record.company_category)
    record.services_offered = clean_text(record.services_offered)
    record.service_opportunity = clean_text(record.service_opportunity)
    record.project_name = clean_text(record.project_name)
    record.project_description = clean_text(record.project_description)
    record.project_location = clean_text(record.project_location)
    record.project_status = clean_text(record.project_status)
    record.project_source_url = normalize_url(record.project_source_url)
    record.company_source_url = normalize_url(record.company_source_url)
    record.buying_intent_evidence = clean_text(record.buying_intent_evidence)
    record.qualification_reason = clean_text(record.qualification_reason)
    record.confidence_level = clean_text(record.confidence_level) or "Unverified"
    record.lead_tier = clean_text(record.lead_tier) or "Potential"
    record.outreach_status = clean_text(record.outreach_status) or "New"
    record.notes = clean_text(record.notes)

    try:
        score = int(record.lead_score)
    except (TypeError, ValueError):
        score = 0
    record.lead_score = max(0, min(100, score))

    return record
