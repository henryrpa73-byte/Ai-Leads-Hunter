"""Public building permit & contractor discovery via municipal Socrata Open Data APIs."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request

from ..database import LeadDatabase
from ..models import LeadRecord
from ..normalizer import normalize_lead
from ..validator import validate_lead
from .discovery_usaspending import DiscoveryResult


PORTALS: dict[str, dict[str, str]] = {
    "austin": {
        "name": "Austin TX Open Data Permits",
        "url": "https://data.austintexas.gov/resource/3syk-w9eu.json",
        "city": "Austin",
        "state": "TX",
        "where": "contractor_company_name IS NOT NULL",
        "order": "issue_date DESC",
        "portal_base": "https://data.austintexas.gov/d/3syk-w9eu",
    },
    "chicago": {
        "name": "Chicago IL Building Permits",
        "url": "https://data.cityofchicago.org/resource/ydr8-5enu.json",
        "city": "Chicago",
        "state": "IL",
        "where": "contact_1_name IS NOT NULL AND contact_1_type LIKE '%CONTRACTOR%'",
        "order": "issue_date DESC",
        "portal_base": "https://data.cityofchicago.org/d/ydr8-5enu",
    },
}


def _fetch_socrata(
    base_url: str,
    *,
    where: str,
    order: str,
    limit: int,
    app_token: str = "",
    user_agent: str = "ConstructionLeadHunter/1.0",
    timeout: int = 20,
) -> list[dict]:
    params = urllib.parse.urlencode({
        "$where": where,
        "$order": order,
        "$limit": str(max(1, min(100, limit))),
    })
    headers = {"User-Agent": user_agent, "Accept": "application/json"}
    if app_token:
        headers["X-App-Token"] = app_token
    req = urllib.request.Request(f"{base_url}?{params}", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, list) else []


def _infer_permit_service(work_text: str) -> str:
    low = work_text.lower()
    if any(k in low for k in ("cabinet", "millwork", "trim", "carpentry", "casework")):
        return "Millwork Services"
    if any(k in low for k in ("architect", "drawing", "plan", "design", "tenant finish", "remodel")):
        return "Architectural Services"
    return "Construction Estimation"


def _row_to_lead(portal_key: str, row: dict, portal_cfg: dict) -> LeadRecord | None:
    if portal_key == "austin":
        company = str(row.get("contractor_company_name") or "").strip()
        if not company:
            return None
        permit_num = str(row.get("permit_number") or "").strip()
        desc = str(row.get("description") or "").strip()
        work_class = str(row.get("work_class") or row.get("permit_type_desc") or "").strip()
        location = str(row.get("permit_location") or row.get("original_address1") or "").strip()
        issue_date = str(row.get("issue_date") or "")[:10]
        expires_date = str(row.get("expiresdate") or "")[:10]
        phone = str(row.get("contractor_phone") or "").strip()
        contact_person = str(row.get("contractor_full_name") or "").strip()
        job_title = str(row.get("contractor_trade") or "Project Contractor").strip()
        city = str(row.get("contractor_city") or portal_cfg["city"]).strip()
        state = str(row.get("contractor_state") or portal_cfg["state"]).strip()
        zip_code = str(row.get("contractor_zip") or row.get("original_zip") or "").strip()
        permit_url = f"{portal_cfg['url']}?permit_number={urllib.parse.quote(permit_num)}" if permit_num else portal_cfg["portal_base"]
        raw_status = str(row.get("status_current") or "Active").strip()
        status = f"Live {raw_status} Permit (expires {expires_date})" if expires_date else f"Live {raw_status} Permit"

        return LeadRecord(
            company_name=company,
            business_phone=phone,
            contact_person=contact_person,
            job_title=job_title,
            city=city,
            state=state,
            zip_code=zip_code,
            company_category=str(row.get("permit_class_mapped") or "Building Permit Contractor"),
            service_opportunity=_infer_permit_service(f"{work_class} {desc}"),
            project_name=f"Austin Permit {permit_num}".strip(),
            project_description=f"{work_class}: {desc}".strip(": "),
            project_location=f"{location}, Austin, TX".strip(", "),
            project_status=status,
            project_source_url=permit_url,
            company_source_url=portal_cfg["portal_base"],
            buying_intent_evidence=f"Active Austin building permit {permit_num} issued {issue_date}".strip(),
            confidence_level="High",
            lead_tier="Potential",
        )

    if portal_key == "chicago":
        company = str(row.get("contact_1_name") or "").strip()
        contact_type = str(row.get("contact_1_type") or "").strip()
        if not company:
            return None
        permit_num = str(row.get("permit_") or row.get("id") or "").strip()
        desc = str(row.get("work_description") or "").strip()
        street = " ".join(
            str(row.get(k) or "").strip()
            for k in ("street_number", "street_direction", "street_name")
            if row.get(k)
        )
        issue_date = str(row.get("issue_date") or "")[:10]
        cost = str(row.get("reported_cost") or "").strip()
        permit_url = f"{portal_cfg['url']}?permit_={urllib.parse.quote(permit_num)}" if permit_num else portal_cfg["portal_base"]

        evidence = f"Chicago building permit {permit_num}"
        if issue_date:
            evidence += f" issued {issue_date}"
        if cost:
            evidence += f" (reported cost ${cost})"

        return LeadRecord(
            company_name=company,
            city=str(row.get("contact_1_city") or portal_cfg["city"]).strip(),
            state=str(row.get("contact_1_state") or portal_cfg["state"]).strip(),
            zip_code=str(row.get("contact_1_zipcode") or "").strip(),
            company_category=contact_type or "Contractor",
            service_opportunity=_infer_permit_service(desc),
            project_name=f"Chicago Permit {permit_num}".strip(),
            project_description=desc[:500],
            project_location=f"{street}, Chicago, IL".strip(", "),
            project_status="Live Issued Permit",
            project_source_url=permit_url,
            company_source_url=portal_cfg["portal_base"],
            buying_intent_evidence=evidence,
            confidence_level="High",
            lead_tier="Potential",
        )

    return None


def discover_permits(
    db: LeadDatabase,
    *,
    cities: list[str] | None = None,
    limit_per_city: int = 20,
    app_token: str = "",
    request_delay: float = 0.5,
    user_agent: str = "ConstructionLeadHunter/1.0",
    logger: logging.Logger | None = None,
    fetcher=_fetch_socrata,
) -> DiscoveryResult:
    selected = cities or list(PORTALS.keys())
    run_id = db.start_run("discover_permits")
    fetched = 0
    inserted = 0
    duplicates = 0
    failed = 0

    try:
        for city_key in selected:
            cfg = PORTALS.get(city_key.lower())
            if not cfg:
                if logger:
                    logger.warning("Unknown permit portal key '%s', skipping.", city_key)
                continue

            try:
                rows = fetcher(
                    cfg["url"],
                    where=cfg["where"],
                    order=cfg["order"],
                    limit=limit_per_city,
                    app_token=app_token,
                    user_agent=user_agent,
                )
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                if logger:
                    logger.warning("Permit portal %s failed: %s", city_key, exc)
                continue

            for row in rows:
                fetched += 1
                raw_lead = _row_to_lead(city_key.lower(), row, cfg)
                if raw_lead is None:
                    continue
                record = normalize_lead(raw_lead)
                val = validate_lead(record)
                if not val.is_valid:
                    failed += 1
                    db.log_failed_record(run_id, cfg["name"], row, "; ".join(val.errors))
                else:
                    _, is_dup = db.upsert_lead(record, source_name=cfg["name"])
                    if is_dup:
                        duplicates += 1
                    else:
                        inserted += 1

                db.update_run_progress(
                    run_id,
                    last_cursor=f"{city_key}:{fetched}",
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
            "Permit discovery complete: fetched=%d inserted=%d duplicates=%d failed=%d",
            fetched,
            inserted,
            duplicates,
            failed,
        )

    return DiscoveryResult(
        run_id=run_id,
        source="municipal_permits",
        fetched=fetched,
        inserted=inserted,
        duplicates=duplicates,
        failed=failed,
    )
