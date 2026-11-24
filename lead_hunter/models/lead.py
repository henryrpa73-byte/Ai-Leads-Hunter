"""Lead dataclass definition for Construction Lead Hunter AI."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
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

VALID_CONFIDENCE_LEVELS = ("Verified", "High", "Medium", "Low", "Unverified")
VALID_LEAD_TIERS = ("Warm", "Potential", "Unqualified")


@dataclass
class Lead:
    """Represents a US construction company and/or project opportunity lead."""

    # --- Company Information ---
    company_name: str
    lead_id: int | None = None
    website: str = ""
    business_email: str = ""
    business_phone: str = ""
    phone_type: str = ""  # cell / landline / voip
    contact_person: str = ""
    job_title: str = ""
    city: str = ""
    state: str = ""
    zip_code: str = ""
    company_category: str = ""  # e.g., General Contractor, Millwork Contractor, Architect
    services_offered: str = ""
    service_opportunity: str = ""  # Construction Estimation / Architectural Services / Millwork Services

    # --- Project Details ---
    project_name: str = ""
    project_description: str = ""
    project_location: str = ""
    project_status: str = ""

    # --- Evidence & Source URLs ---
    project_source_url: str = ""
    company_source_url: str = ""
    buying_intent_evidence: str = ""
    qualification_reason: str = ""

    # --- Qualification & 0-100 Scoring ---
    lead_score: int = 0
    confidence_level: str = "Unverified"  # Verified / High / Medium / Low / Unverified
    lead_tier: str = "Potential"          # Warm / Potential / Unqualified

    # --- Tracking & Lifecycle ---
    date_discovered: str = field(default_factory=utc_now_iso)
    last_verified: str = field(default_factory=utc_now_iso)
    outreach_status: str = "New"          # New / Queued / Contacted / Replied / Closed
    notes: str = ""

    # --- Internal Deduplication Keys ---
    normalized_name: str = ""
    domain: str = ""
    phone_digits: str = ""

    def __post_init__(self) -> None:
        if isinstance(self.lead_score, bool) or not isinstance(self.lead_score, int):
            raise TypeError(f"lead_score must be an integer, got {type(self.lead_score).__name__}")
        if not (0 <= self.lead_score <= 100):
            raise ValueError(f"lead_score must be between 0 and 100, got {self.lead_score}")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Lead:
        valid_keys = {f for f in cls.__dataclass_fields__}
        filtered = {k: v for k, v in data.items() if k in valid_keys}
        return cls(**filtered)
