"""CSV & Excel (.xlsx) ingestion and export utilities."""

from __future__ import annotations

import csv
import logging
from dataclasses import dataclass
from pathlib import Path

from .database import LeadDatabase
from .models import LEAD_FIELDS, LeadRecord
from .normalizer import normalize_lead
from .validator import validate_lead


# Flexible column aliases so existing BlueBook / SpyDialer sheets and standard CSVs import cleanly.
COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "company_name": ("company_name", "company name", "company", "business name", "contractor", "name"),
    "website": ("website", "web", "url", "company website", "site"),
    "business_email": ("business_email", "business email", "email", "e-mail", "contact email"),
    "business_phone": ("business_phone", "business phone", "phone number", "phone", "telephone", "mobile"),
    "phone_type": ("phone_type", "phone type", "type"),
    "contact_person": ("contact_person", "contact person", "contact name", "contact", "owner"),
    "job_title": ("job_title", "job title", "title", "role"),
    "city": ("city", "town"),
    "state": ("state", "st"),
    "zip_code": ("zip_code", "zip code", "zip", "postal code"),
    "company_category": ("company_category", "company category", "category", "trade", "industry"),
    "services_offered": ("services_offered", "services offered", "services"),
    "service_opportunity": ("service_opportunity", "service opportunity", "recommended service"),
    "project_name": ("project_name", "project name", "project"),
    "project_description": ("project_description", "project description", "description"),
    "project_location": ("project_location", "project location"),
    "project_status": ("project_status", "project status", "status"),
    "project_source_url": ("project_source_url", "project source url", "project url"),
    "company_source_url": ("company_source_url", "company source url", "source url", "source"),
    "buying_intent_evidence": ("buying_intent_evidence", "buying intent evidence", "evidence"),
    "qualification_reason": ("qualification_reason", "qualification reason", "reason"),
    "lead_score": ("lead_score", "lead score", "score"),
    "confidence_level": ("confidence_level", "confidence level", "confidence"),
    "lead_tier": ("lead_tier", "lead tier", "tier"),
    "outreach_status": ("outreach_status", "outreach status"),
    "notes": ("notes", "note"),
}


@dataclass
class ImportSummary:
    run_id: str
    total_rows: int
    inserted: int
    duplicates: int
    failed: int


def _map_row(raw_row: dict[str, object]) -> LeadRecord:
    lowered = {str(k).strip().lower(): v for k, v in raw_row.items() if k is not None}
    mapped: dict[str, object] = {}
    for field_name, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in lowered and lowered[alias] not in (None, ""):
                mapped[field_name] = lowered[alias]
                break

    score_val = mapped.get("lead_score", 0)
    try:
        lead_score = int(float(score_val)) if score_val not in ("", None) else 0
    except (TypeError, ValueError):
        lead_score = 0

    return LeadRecord(
        company_name=str(mapped.get("company_name", "") or ""),
        website=str(mapped.get("website", "") or ""),
        business_email=str(mapped.get("business_email", "") or ""),
        business_phone=str(mapped.get("business_phone", "") or ""),
        phone_type=str(mapped.get("phone_type", "") or ""),
        contact_person=str(mapped.get("contact_person", "") or ""),
        job_title=str(mapped.get("job_title", "") or ""),
        city=str(mapped.get("city", "") or ""),
        state=str(mapped.get("state", "") or ""),
        zip_code=str(mapped.get("zip_code", "") or ""),
        company_category=str(mapped.get("company_category", "") or ""),
        services_offered=str(mapped.get("services_offered", "") or ""),
        service_opportunity=str(mapped.get("service_opportunity", "") or ""),
        project_name=str(mapped.get("project_name", "") or ""),
        project_description=str(mapped.get("project_description", "") or ""),
        project_location=str(mapped.get("project_location", "") or ""),
        project_status=str(mapped.get("project_status", "") or ""),
        project_source_url=str(mapped.get("project_source_url", "") or ""),
        company_source_url=str(mapped.get("company_source_url", "") or ""),
        buying_intent_evidence=str(mapped.get("buying_intent_evidence", "") or ""),
        qualification_reason=str(mapped.get("qualification_reason", "") or ""),
        lead_score=lead_score,
        confidence_level=str(mapped.get("confidence_level", "Unverified") or "Unverified"),
        lead_tier=str(mapped.get("lead_tier", "Potential") or "Potential"),
        outreach_status=str(mapped.get("outreach_status", "New") or "New"),
        notes=str(mapped.get("notes", "") or ""),
    )


def _read_csv_rows(path: Path) -> list[dict[str, object]]:
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            with path.open("r", newline="", encoding=encoding) as f:
                return [dict(row) for row in csv.DictReader(f)]
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Could not decode CSV file: {path}")


def _read_xlsx_rows(path: Path) -> list[dict[str, object]]:
    try:
        import openpyxl
    except ImportError as exc:
        raise RuntimeError(
            "openpyxl is required to read .xlsx files. Run: pip install openpyxl"
        ) from exc

    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter, None)
    if not header:
        return []
    keys = [str(h or "").strip() for h in header]
    out: list[dict[str, object]] = []
    for row in rows_iter:
        if not any(cell is not None and str(cell).strip() != "" for cell in row):
            continue
        out.append({keys[i]: row[i] for i in range(min(len(keys), len(row))) if keys[i]})
    wb.close()
    return out


def import_file(
    db: LeadDatabase,
    file_path: Path,
    source_name: str = "",
    logger: logging.Logger | None = None,
    resume_run_id: str | None = None,
) -> ImportSummary:
    if not file_path.exists():
        raise FileNotFoundError(f"Input file not found: {file_path}")

    suffix = file_path.suffix.lower()
    if suffix == ".csv":
        raw_rows = _read_csv_rows(file_path)
    elif suffix in (".xlsx", ".xlsm"):
        raw_rows = _read_xlsx_rows(file_path)
    else:
        raise ValueError(f"Unsupported file format '{suffix}'. Use .csv or .xlsx.")

    effective_source = source_name or file_path.name
    run_id = db.start_run("import_file", resume_run_id=resume_run_id)
    inserted = 0
    duplicates = 0
    failed = 0

    start_index = 0
    if resume_run_id:
        run_state = db.get_run(run_id)
        if run_state and str(run_state.get("last_cursor", "")).isdigit():
            start_index = int(run_state["last_cursor"])
            inserted = int(run_state["new_count"])
            duplicates = int(run_state["duplicate_count"])
            failed = int(run_state["failed_count"])

    try:
        for idx in range(start_index, len(raw_rows)):
            raw = raw_rows[idx]
            record = normalize_lead(_map_row(raw))
            validation = validate_lead(record)
            if not validation.is_valid:
                failed += 1
                reason = "; ".join(validation.errors)
                db.log_failed_record(run_id, effective_source, raw, reason)
                if logger:
                    logger.warning("Row %d failed validation: %s", idx + 2, reason)
            else:
                _, is_dup = db.upsert_lead(record, source_name=effective_source)
                if is_dup:
                    duplicates += 1
                else:
                    inserted += 1

            db.update_run_progress(
                run_id,
                last_cursor=str(idx + 1),
                total_processed=idx + 1,
                new_count=inserted,
                duplicate_count=duplicates,
                failed_count=failed,
                status="running",
            )

        db.update_run_progress(
            run_id,
            last_cursor=str(len(raw_rows)),
            total_processed=len(raw_rows),
            new_count=inserted,
            duplicate_count=duplicates,
            failed_count=failed,
            status="completed",
        )
    except Exception:
        db.update_run_progress(
            run_id,
            last_cursor=str(inserted + duplicates + failed),
            total_processed=inserted + duplicates + failed,
            new_count=inserted,
            duplicate_count=duplicates,
            failed_count=failed,
            status="failed",
        )
        raise

    if logger:
        logger.info(
            "Import finished (%s): total=%d inserted=%d duplicates=%d failed=%d",
            file_path.name,
            len(raw_rows),
            inserted,
            duplicates,
            failed,
        )

    return ImportSummary(
        run_id=run_id,
        total_rows=len(raw_rows),
        inserted=inserted,
        duplicates=duplicates,
        failed=failed,
    )


def export_leads_csv(db: LeadDatabase, output_path: Path, min_score: int = 0, tier: str | None = None) -> int:
    leads = db.get_all_leads(min_score=min_score, tier=tier)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(LEAD_FIELDS), extrasaction="ignore")
        writer.writeheader()
        for row in leads:
            writer.writerow(row)
    return len(leads)


def _col_letter(idx_1based: int) -> str:
    letters = []
    n = idx_1based
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters.append(chr(65 + rem))
    return "".join(reversed(letters))


def export_leads_xlsx(db: LeadDatabase, output_path: Path, min_score: int = 0, tier: str | None = None) -> int:
    """Export leads to a clean .xlsx workbook (uses openpyxl if available, or pure stdlib OpenXML)."""
    leads = db.get_all_leads(min_score=min_score, tier=tier)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    headers = list(LEAD_FIELDS)

    try:
        import openpyxl  # type: ignore

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Leads"
        ws.append(headers)
        for row in leads:
            ws.append([row.get(col, "") for col in headers])
        ws.freeze_panes = "A2"
        wb.save(output_path)
        return len(leads)
    except ImportError:
        pass

    import zipfile
    from xml.sax.saxutils import escape

    rows_xml = []
    all_rows = [headers] + [[row.get(col, "") for col in headers] for row in leads]
    for r_idx, row_vals in enumerate(all_rows, start=1):
        cells = []
        for c_idx, val in enumerate(row_vals, start=1):
            ref = f"{_col_letter(c_idx)}{r_idx}"
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                cells.append(f'<c r="{ref}"><v>{val}</v></c>')
            else:
                text = escape(str(val or ""))
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>')
        rows_xml.append(f'<row r="{r_idx}">{"".join(cells)}</row>')

    sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(rows_xml)}</sheetData>'
        '</worksheet>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>'
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets>'
        '</workbook>'
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '</Relationships>'
    )

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("xl/workbook.xml", workbook_xml)
        zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        zf.writestr("xl/worksheets/sheet1.xml", sheet_xml)

    return len(leads)
