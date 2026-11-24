"""SAM.gov Contract Opportunities discovery agent (uses free SAM_GOV_API_KEY)."""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from ..database import LeadDatabase
from ..models import LeadRecord
from ..normalizer import normalize_lead
from ..validator import validate_lead
from .discovery_usaspending import DiscoveryResult, _infer_service_hint


SAM_OPP_SEARCH_URL = "https://api.sam.gov/opportunities/v2/search"


def _fetch_sam(url: str, user_agent: str = "ConstructionLeadHunter/1.0", timeout: int = 20) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def sam_opp_to_lead(opp: dict) -> LeadRecord | None:
    # Prefer awardee name if awarded, otherwise fall back to primary POC / organization when valid
    award = opp.get("award") or {}
    awardee = award.get("awardee") or {}
    awardee_name = str(awardee.get("name") or "").strip()

    pocs = opp.get("pointOfContact") or []
    poc = pocs[0] if pocs else {}
    poc_name = str(poc.get("fullName") or "").strip()
    poc_email = str(poc.get("email") or "").strip()
    poc_phone = str(poc.get("phone") or "").strip()

    office = opp.get("officeAddress") or {}
    pop = (opp.get("placeOfPerformance") or {}).get("address") or {}
    pop_state = (pop.get("state") or {})
    state_code = pop_state.get("code") if isinstance(pop_state, dict) else pop_state
    city_obj = pop.get("city")
    city_name = city_obj.get("name") if isinstance(city_obj, dict) else (city_obj or office.get("city") or "")

    company_name = awardee_name or str(opp.get("fullParentPathName") or "").split(".")[0].strip()
    if not company_name:
        return None

    naics = str(opp.get("naicsCode") or "").strip()
    title = str(opp.get("title") or "").strip()
    sol_num = str(opp.get("solicitationNumber") or opp.get("noticeId") or "").strip()
    ui_link = str(opp.get("uiLink") or "https://sam.gov/").strip()
    posted = str(opp.get("postedDate") or "").strip()
    deadline = str(opp.get("responseDeadLine") or "").strip()
    opp_type = str(opp.get("type") or "Solicitation").strip()

    evidence = f"SAM.gov {opp_type} ({sol_num}) posted {posted}"
    if deadline:
        evidence += f", response due {deadline}"

    return LeadRecord(
        company_name=company_name,
        business_email=poc_email,
        business_phone=poc_phone,
        contact_person=poc_name,
        city=str(city_name or "").strip(),
        state=str(state_code or office.get("state") or "").strip(),
        zip_code=str(pop.get("zip") or office.get("zipcode") or "").strip(),
        company_category=f"SAM.gov Opportunity (NAICS {naics})" if naics else "SAM.gov Opportunity",
        service_opportunity=_infer_service_hint(naics, title),
        project_name=title[:200],
        project_description=f"{opp_type}: {title}",
        project_location=", ".join(p for p in (str(city_name or "").strip(), str(state_code or "").strip()) if p),
        project_status=opp_type,
        project_source_url=ui_link,
        company_source_url=ui_link,
        buying_intent_evidence=evidence,
        confidence_level="High" if awardee_name else "Medium",
        lead_tier="Potential",
    )


def discover_sam_opportunities(
    db: LeadDatabase,
    *,
    api_key: str,
    naics_codes: list[str] | None = None,
    days_back: int = 30,
    limit: int = 20,
    user_agent: str = "ConstructionLeadHunter/1.0",
    logger: logging.Logger | None = None,
    fetcher=_fetch_sam,
) -> DiscoveryResult:
    run_id = db.start_run("discover_sam")
    if not api_key:
        msg = "SAM_GOV_API_KEY not set in .env (free registration at sam.gov)."
        db.update_run_progress(run_id, status="completed", last_cursor="skipped_no_key")
        if logger:
            logger.info("SAM.gov skipped: %s", msg)
        return DiscoveryResult(
            run_id=run_id,
            source="sam.gov",
            fetched=0,
            inserted=0,
            duplicates=0,
            failed=0,
            skipped_reason=msg,
        )

    end_dt = datetime.now(timezone.utc).date()
    start_dt = end_dt - timedelta(days=days_back)
    codes = naics_codes or ["236220", "238350", "337110", "541310"]

    fetched = 0
    inserted = 0
    duplicates = 0
    failed = 0

    try:
        for code in codes:
            params = urllib.parse.urlencode({
                "api_key": api_key,
                "postedFrom": start_dt.strftime("%m/%d/%Y"),
                "postedTo": end_dt.strftime("%m/%d/%Y"),
                "ncode": code,
                "limit": str(max(1, min(50, limit))),
            })
            try:
                data = fetcher(f"{SAM_OPP_SEARCH_URL}?{params}", user_agent=user_agent)
            except (urllib.error.URLError, TimeoutError, ValueError) as exc:
                if logger:
                    logger.warning("SAM.gov query failed for NAICS %s: %s", code, exc)
                continue

            for opp in data.get("opportunitiesData") or []:
                fetched += 1
                raw_lead = sam_opp_to_lead(opp)
                if raw_lead is None:
                    continue
                record = normalize_lead(raw_lead)
                val = validate_lead(record)
                if not val.is_valid:
                    failed += 1
                    db.log_failed_record(run_id, "sam.gov", opp, "; ".join(val.errors))
                else:
                    _, is_dup = db.upsert_lead(record, source_name="sam.gov")
                    if is_dup:
                        duplicates += 1
                    else:
                        inserted += 1

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

    return DiscoveryResult(
        run_id=run_id,
        source="sam.gov",
        fetched=fetched,
        inserted=inserted,
        duplicates=duplicates,
        failed=failed,
    )
