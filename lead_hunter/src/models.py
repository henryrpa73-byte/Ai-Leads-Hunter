"""Core data models for Construction Lead Hunter AI."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


LEAD_FIELDS = (
    "lead_id",
    "company_name",
    "website",
    "business_email",
    "business_phone",
    "phone_type",
    "contact_person",
    "job_title",
    "city",
    "state",
    "zip_code",
    "company_category",
    "services_offered",
    "service_opportunity",
    "project_name",
    "project_description",
    "project_location",
    "project_status",
    "project_source_url",
    "company_source_url",
    "buying_intent_evidence",
    "qualification_reason",
    "lead_score",
    "confidence_level",
    "lead_tier",
    "date_discovered",
    "last_verified",
    "outreach_status",
    "notes",
)


@dataclass
class LeadRecord:
    company_name: str
    lead_id: int | None = None
    website: str = ""
    business_email: str = ""
    business_phone: str = ""
    phone_type: str = ""  # cell / landline / voip (compatible with spydialer_bot)
    contact_person: str = ""
    job_title: str = ""
    city: str = ""
    state: str = ""
    zip_code: str = ""
    company_category: str = ""
    services_offered: str = ""
    service_opportunity: str = ""  # Estimation / Architectural / Millwork
    project_name: str = ""
    project_description: str = ""
    project_location: str = ""
    project_status: str = ""
    project_source_url: str = ""
    company_source_url: str = ""
    buying_intent_evidence: str = ""
    qualification_reason: str = ""
    lead_score: int = 0
    confidence_level: str = "Unverified"  # Verified / High / Medium / Low / Unverified
    lead_tier: str = "Potential"          # Warm / Potential / Unqualified
    date_discovered: str = field(default_factory=utc_now_iso)
    last_verified: str = field(default_factory=utc_now_iso)
    outreach_status: str = "New"          # New / Queued / Contacted / Replied / Closed
    notes: str = ""

    # Deduplication keys (computed by normalizer)
    normalized_name: str = ""
    domain: str = ""
    phone_digits: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
