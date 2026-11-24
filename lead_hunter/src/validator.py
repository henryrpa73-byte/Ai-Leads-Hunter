"""Validation rules for normalized LeadRecord objects."""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import LeadRecord


VALID_CONFIDENCE = {"Verified", "High", "Medium", "Low", "Unverified"}
VALID_TIERS = {"Warm", "Potential", "Unqualified"}


@dataclass
class ValidationResult:
    is_valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def validate_lead(record: LeadRecord) -> ValidationResult:
    """Validate that a lead is safe and usable before saving to SQLite.

    Allows incomplete records (e.g., missing email or website) as long as the
    record has a real company name and at least one contact/location/source clue.
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not record.company_name or len(record.normalized_name) < 2:
        errors.append("Missing or unusable company_name.")

    has_contact_or_location = any([
        record.domain,
        record.phone_digits,
        record.business_email,
        (record.city and record.state),
        record.company_source_url,
        record.project_source_url,
    ])
    if not has_contact_or_location:
        errors.append("Record lacks website, valid phone, email, city+state, or source URL.")

    if record.business_phone and not record.phone_digits:
        warnings.append(f"Unrecognized US phone format: '{record.business_phone}'.")

    if not record.website:
        warnings.append("Missing website.")
    if not record.company_source_url and not record.project_source_url:
        warnings.append("Missing source URL.")

    if record.confidence_level not in VALID_CONFIDENCE:
        warnings.append(f"Unexpected confidence_level '{record.confidence_level}', defaulting to Unverified.")
        record.confidence_level = "Unverified"

    if record.lead_tier not in VALID_TIERS:
        warnings.append(f"Unexpected lead_tier '{record.lead_tier}', defaulting to Potential.")
        record.lead_tier = "Potential"

    return ValidationResult(
        is_valid=(len(errors) == 0),
        errors=errors,
        warnings=warnings,
    )
