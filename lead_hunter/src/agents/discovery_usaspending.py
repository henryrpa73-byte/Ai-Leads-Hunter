"""Contractor & award discovery from USASpending.gov (free, no API key required)."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from ..database import LeadDatabase
from ..models import LeadRecord
from ..normalizer import normalize_lead
from ..validator import validate_lead


USASPENDING_SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
USASPENDING_AWARD_URL = "https://api.usaspending.gov/api/v2/awards/{award_id}/"

# NAICS codes aligned with Estimation, Architectural, and Millwork B2B buyers
DEFAULT_CONSTRUCTION_NAICS = {
    "236220": "Commercial and Institutional Building Construction",
    "236115": "New Single-Family Housing Construction",
    "236116": "New Multifamily Housing Construction",
    "236118": "Residential Remodelers",
    "238350": "Finish Carpentry Contractors",
    "337110": "Wood Kitchen Cabinet and Countertop Manufacturing",
    "541310": "Architectural Services",
}


@dataclass
class DiscoveryResult:
    run_id: str
    source: str
    fetched: int
    inserted: int
    duplicates: int
    failed: int
    skipped_reason: str = ""


def _http_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict | None = None,
    user_agent: str = "ConstructionLeadHunter/1.0",
    timeout: int = 20,
) -> dict:
    headers = {"User-Agent": user_agent, "Accept": "application/json"}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _infer_service_hint(naics_code: str, description: str) -> str:
    text = f"{naics_code} {description}".lower()
    if any(k in text for k in ("millwork", "cabinet", "casework", "woodwork", "carpentry", "337110", "238350")):
        return "Millwork Services"
    if any(k in text for k in ("architect", "design", "cad", "drawing", "541310")):
        return "Architectural Services"
    return "Construction Estimation"


def award_to_lead(search_row: dict, detail: dict | None = None, naics_code: str = "") -> LeadRecord:
    detail = detail or {}
    recipient = detail.get("recipient") or {}
    rec_loc = recipient.get("location") or {}
    pop = detail.get("place_of_performance") or {}

    company_name = str(recipient.get("recipient_name") or search_row.get("Recipient Name") or "").strip()
    city = str(rec_loc.get("city_name") or "").strip()
    state = str(rec_loc.get("state_code") or search_row.get("Place of Performance State Code") or "").strip()
    zip_code = str(rec_loc.get("zip5") or search_row.get("Place of Performance Zip5") or "").strip()

    pop_city = str(pop.get("city_name") or "").strip()
    pop_state = str(pop.get("state_code") or search_row.get("Place of Performance State Code") or "").strip()
    project_location = ", ".join(p for p in (pop_city, pop_state) if p)

    award_id = str(search_row.get("Award ID") or "").strip()
    gen_id = str(search_row.get("generated_internal_id") or "").strip()
    amount = search_row.get("Award Amount")
    agency = str(search_row.get("Awarding Agency") or "").strip()
    description = str(search_row.get("Description") or "").strip()
    start_date = str(search_row.get("Start Date") or "").strip()

    source_url = f"https://www.usaspending.gov/award/{gen_id}" if gen_id else "https://www.usaspending.gov/search"
    amount_str = f"${float(amount):,.0f}" if isinstance(amount, (int, float)) else ""
    categories = ", ".join(recipient.get("business_categories") or [])
    category_label = DEFAULT_CONSTRUCTION_NAICS.get(naics_code, "US Construction Awardee")

    evidence_parts = [p for p in (
        f"Federal contract award {award_id}" if award_id else "Federal contract award",
        f"Value: {amount_str}" if amount_str else "",
        f"Agency: {agency}" if agency else "",
        f"Start: {start_date}" if start_date else "",
    ) if p]

    return LeadRecord(
        company_name=company_name,
        city=city,
        state=state,
        zip_code=zip_code,
        company_category=category_label,
        services_offered=categories[:200],
        service_opportunity=_infer_service_hint(naics_code, description),
        project_name=f"Federal Award {award_id}" if award_id else "Federal Construction Award",
        project_description=description[:500],
        project_location=project_location,
        project_status="Awarded" if start_date else "Active",
        project_source_url=source_url,
        company_source_url=source_url,
        buying_intent_evidence="; ".join(evidence_parts),
        confidence_level="High",
        lead_tier="Potential",
        notes=f"NAICS {naics_code}".strip(),
    )


def discover_usaspending(
    db: LeadDatabase,
    *,
    state: str = "",
    naics_codes: list[str] | None = None,
    days_back: int = 120,
    limit_per_naics: int = 10,
    request_delay: float = 0.4,
    user_agent: str = "ConstructionLeadHunter/1.0",
    logger: logging.Logger | None = None,
    http_getter=_http_json,
) -> DiscoveryResult:
    codes = naics_codes or list(DEFAULT_CONSTRUCTION_NAICS.keys())
    end_dt = datetime.now(timezone.utc).date()
    start_dt = end_dt - timedelta(days=days_back)

    run_id = db.start_run("discover_usaspending")
    fetched = 0
    inserted = 0
    duplicates = 0
    failed = 0

    try:
        for code in codes:
            loc_filter = {"country": "USA"}
            if state:
                loc_filter["state"] = state.upper()

            body = {
                "fields": [
                    "Award ID",
                    "Recipient Name",
                    "Award Amount",
                    "Description",
                    "Start Date",
                    "Awarding Agency",
                    "Place of Performance State Code",
                    "Place of Performance Zip5",
                    "generated_internal_id",
                ],
                "filters": {
                    "award_type_codes": ["A", "B", "C", "D"],
                    "naics_codes": [code],
                    "place_of_performance_locations": [loc_filter],
                    "time_period": [{"start_date": start_dt.isoformat(), "end_date": end_dt.isoformat()}],
                },
                "limit": max(1, min(50, limit_per_naics)),
                "page": 1,
                "sort": "Award Amount",
                "order": "desc",
            }

            try:
                resp = http_getter(
                    USASPENDING_SEARCH_URL,
                    method="POST",
                    payload=body,
                    user_agent=user_agent,
                )
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                if logger:
                    logger.warning("USASpending search failed for NAICS %s: %s", code, exc)
                continue

            results = resp.get("results") or []
            for row in results:
                fetched += 1
                gen_id = row.get("generated_internal_id")
                detail = {}
                if gen_id:
                    if request_delay > 0:
                        time.sleep(request_delay)
                    try:
                        detail = http_getter(
                            USASPENDING_AWARD_URL.format(award_id=gen_id),
                            method="GET",
                            user_agent=user_agent,
                        )
                    except Exception as exc:
                        if logger:
                            logger.debug("Detail lookup skipped for %s: %s", gen_id, exc)

                record = normalize_lead(award_to_lead(row, detail, naics_code=code))
                val = validate_lead(record)
                if not val.is_valid:
                    failed += 1
                    db.log_failed_record(run_id, "usaspending.gov", row, "; ".join(val.errors))
                else:
                    _, is_dup = db.upsert_lead(record, source_name="usaspending.gov")
                    if is_dup:
                        duplicates += 1
                    else:
                        inserted += 1

                db.update_run_progress(
                    run_id,
                    last_cursor=f"{code}:{fetched}",
                    total_processed=fetched,
                    new_count=inserted,
                    duplicate_count=duplicates,
                    failed_count=failed,
                    status="running",
                )

            if request_delay > 0:
                time.sleep(request_delay)

        db.update_run_progress(
            run_id,
            last_cursor=f"done:{fetched}",
            total_processed=fetched,
            new_count=inserted,
            duplicate_count=duplicates,
            failed_count=failed,
            status="completed",
        )
    except Exception:
        db.update_run_progress(
            run_id,
            total_processed=fetched,
            new_count=inserted,
            duplicate_count=duplicates,
            failed_count=failed,
            status="failed",
        )
        raise

    if logger:
        logger.info(
            "USASpending discovery complete: fetched=%d inserted=%d duplicates=%d failed=%d",
            fetched,
            inserted,
            duplicates,
            failed,
        )

    return DiscoveryResult(
        run_id=run_id,
        source="usaspending.gov",
        fetched=fetched,
        inserted=inserted,
        duplicates=duplicates,
        failed=failed,
    )
