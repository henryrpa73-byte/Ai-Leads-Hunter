"""SQLite persistence, deduplication, source history, and checkpointing."""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .models import LeadRecord, utc_now_iso


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leads (
    lead_id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    website TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    business_email TEXT NOT NULL DEFAULT '',
    business_phone TEXT NOT NULL DEFAULT '',
    phone_digits TEXT NOT NULL DEFAULT '',
    phone_type TEXT NOT NULL DEFAULT '',
    contact_person TEXT NOT NULL DEFAULT '',
    job_title TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    zip_code TEXT NOT NULL DEFAULT '',
    company_category TEXT NOT NULL DEFAULT '',
    services_offered TEXT NOT NULL DEFAULT '',
    service_opportunity TEXT NOT NULL DEFAULT '',
    project_name TEXT NOT NULL DEFAULT '',
    project_description TEXT NOT NULL DEFAULT '',
    project_location TEXT NOT NULL DEFAULT '',
    project_status TEXT NOT NULL DEFAULT '',
    project_source_url TEXT NOT NULL DEFAULT '',
    company_source_url TEXT NOT NULL DEFAULT '',
    buying_intent_evidence TEXT NOT NULL DEFAULT '',
    qualification_reason TEXT NOT NULL DEFAULT '',
    lead_score INTEGER NOT NULL DEFAULT 0,
    confidence_level TEXT NOT NULL DEFAULT 'Unverified',
    lead_tier TEXT NOT NULL DEFAULT 'Potential',
    date_discovered TEXT NOT NULL,
    last_verified TEXT NOT NULL,
    outreach_status TEXT NOT NULL DEFAULT 'New',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(domain) WHERE domain != '';
CREATE INDEX IF NOT EXISTS idx_leads_phone_digits ON leads(phone_digits) WHERE phone_digits != '';
CREATE INDEX IF NOT EXISTS idx_leads_norm_name_state ON leads(normalized_name, state);
CREATE INDEX IF NOT EXISTS idx_leads_score_tier ON leads(lead_tier, lead_score DESC);

CREATE TABLE IF NOT EXISTS lead_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(lead_id) ON DELETE CASCADE,
    source_name TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    evidence_text TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL,
    UNIQUE(lead_id, source_name, source_url, evidence_text)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id TEXT PRIMARY KEY,
    task_name TEXT NOT NULL,
    status TEXT NOT NULL,
    last_cursor TEXT NOT NULL DEFAULT '',
    total_processed INTEGER NOT NULL DEFAULT 0,
    new_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS failed_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL DEFAULT '',
    source_name TEXT NOT NULL DEFAULT '',
    raw_payload TEXT NOT NULL,
    error_reason TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


MERGEABLE_TEXT_FIELDS = (
    "website",
    "domain",
    "business_email",
    "business_phone",
    "phone_digits",
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
    "notes",
)


class LeadDatabase:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.init_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA_SQL)

    # ---------- Workflow Run Checkpoints ----------
    def start_run(self, task_name: str, resume_run_id: str | None = None) -> str:
        now = utc_now_iso()
        with self.connect() as conn:
            if resume_run_id:
                row = conn.execute(
                    "SELECT run_id FROM workflow_runs WHERE run_id = ?",
                    (resume_run_id,),
                ).fetchone()
                if row:
                    conn.execute(
                        "UPDATE workflow_runs SET status = 'running', updated_at = ? WHERE run_id = ?",
                        (now, resume_run_id),
                    )
                    return resume_run_id
            run_id = f"{task_name}_{uuid.uuid4().hex[:10]}"
            conn.execute(
                """
                INSERT INTO workflow_runs (run_id, task_name, status, started_at, updated_at)
                VALUES (?, ?, 'running', ?, ?)
                """,
                (run_id, task_name, now, now),
            )
            return run_id

    def update_run_progress(
        self,
        run_id: str,
        *,
        last_cursor: str = "",
        total_processed: int = 0,
        new_count: int = 0,
        duplicate_count: int = 0,
        failed_count: int = 0,
        status: str = "running",
    ) -> None:
        now = utc_now_iso()
        finished_at = now if status in ("completed", "failed", "paused") else ""
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE workflow_runs
                SET status = ?,
                    last_cursor = ?,
                    total_processed = ?,
                    new_count = ?,
                    duplicate_count = ?,
                    failed_count = ?,
                    updated_at = ?,
                    finished_at = CASE WHEN ? != '' THEN ? ELSE finished_at END
                WHERE run_id = ?
                """,
                (
                    status,
                    last_cursor,
                    total_processed,
                    new_count,
                    duplicate_count,
                    failed_count,
                    now,
                    finished_at,
                    finished_at,
                    run_id,
                ),
            )

    def get_run(self, run_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM workflow_runs WHERE run_id = ?", (run_id,)).fetchone()
            return dict(row) if row else None

    def log_failed_record(self, run_id: str, source_name: str, raw_payload: dict, error_reason: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO failed_records (run_id, source_name, raw_payload, error_reason, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (run_id, source_name, json.dumps(raw_payload, default=str), error_reason, utc_now_iso()),
            )

    # ---------- Deduplication & Upsert ----------
    def find_duplicate(self, conn: sqlite3.Connection, record: LeadRecord) -> sqlite3.Row | None:
        if record.domain:
            row = conn.execute("SELECT * FROM leads WHERE domain = ? LIMIT 1", (record.domain,)).fetchone()
            if row:
                return row

        if record.phone_digits:
            row = conn.execute("SELECT * FROM leads WHERE phone_digits = ? LIMIT 1", (record.phone_digits,)).fetchone()
            if row:
                return row

        if record.normalized_name and record.state:
            row = conn.execute(
                "SELECT * FROM leads WHERE normalized_name = ? AND state = ? LIMIT 1",
                (record.normalized_name, record.state),
            ).fetchone()
            if row:
                return row

        if record.normalized_name and record.zip_code:
            row = conn.execute(
                "SELECT * FROM leads WHERE normalized_name = ? AND zip_code = ? LIMIT 1",
                (record.normalized_name, record.zip_code),
            ).fetchone()
            if row:
                return row

        return None

    def _record_source(
        self,
        conn: sqlite3.Connection,
        lead_id: int,
        source_name: str,
        source_url: str,
        evidence_text: str,
    ) -> None:
        if not (source_name or source_url or evidence_text):
            return
        conn.execute(
            """
            INSERT OR IGNORE INTO lead_sources (lead_id, source_name, source_url, evidence_text, discovered_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (lead_id, source_name, source_url, evidence_text, utc_now_iso()),
        )

    def upsert_lead(self, record: LeadRecord, source_name: str = "") -> tuple[int, bool]:
        """Insert a new lead or merge into an existing duplicate.

        Returns (lead_id, is_duplicate).
        """
        now = utc_now_iso()
        with self.connect() as conn:
            existing = self.find_duplicate(conn, record)
            if existing is None:
                cur = conn.execute(
                    """
                    INSERT INTO leads (
                        company_name, normalized_name, website, domain, business_email,
                        business_phone, phone_digits, phone_type, contact_person, job_title,
                        city, state, zip_code, company_category, services_offered,
                        service_opportunity, project_name, project_description, project_location,
                        project_status, project_source_url, company_source_url,
                        buying_intent_evidence, qualification_reason, lead_score,
                        confidence_level, lead_tier, date_discovered, last_verified,
                        outreach_status, notes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.company_name,
                        record.normalized_name,
                        record.website,
                        record.domain,
                        record.business_email,
                        record.business_phone,
                        record.phone_digits,
                        record.phone_type,
                        record.contact_person,
                        record.job_title,
                        record.city,
                        record.state,
                        record.zip_code,
                        record.company_category,
                        record.services_offered,
                        record.service_opportunity,
                        record.project_name,
                        record.project_description,
                        record.project_location,
                        record.project_status,
                        record.project_source_url,
                        record.company_source_url,
                        record.buying_intent_evidence,
                        record.qualification_reason,
                        record.lead_score,
                        record.confidence_level,
                        record.lead_tier,
                        record.date_discovered or now,
                        record.last_verified or now,
                        record.outreach_status or "New",
                        record.notes,
                        now,
                        now,
                    ),
                )
                lead_id = int(cur.lastrowid)
                self._record_source(
                    conn,
                    lead_id,
                    source_name,
                    record.project_source_url or record.company_source_url,
                    record.buying_intent_evidence,
                )
                return lead_id, False

            # Duplicate found -> merge only blank fields, keep highest score, preserve sources
            lead_id = int(existing["lead_id"])
            updates: dict[str, object] = {
                "last_verified": now,
                "updated_at": now,
            }
            for col in MERGEABLE_TEXT_FIELDS:
                incoming = getattr(record, col, "")
                current = existing[col] or ""
                if incoming and not current:
                    updates[col] = incoming

            # Preserve stronger evidence/notes by appending if distinct
            if record.buying_intent_evidence and existing["buying_intent_evidence"]:
                if record.buying_intent_evidence not in existing["buying_intent_evidence"]:
                    updates["buying_intent_evidence"] = (
                        f"{existing['buying_intent_evidence']} | {record.buying_intent_evidence}"
                    )

            if record.lead_score > int(existing["lead_score"] or 0):
                updates["lead_score"] = record.lead_score
                updates["confidence_level"] = record.confidence_level
                updates["lead_tier"] = record.lead_tier

            set_clause = ", ".join(f"{col} = ?" for col in updates)
            values = list(updates.values()) + [lead_id]
            conn.execute(f"UPDATE leads SET {set_clause} WHERE lead_id = ?", values)

            self._record_source(
                conn,
                lead_id,
                source_name,
                record.project_source_url or record.company_source_url,
                record.buying_intent_evidence,
            )
            return lead_id, True

    def get_all_leads(self, min_score: int = 0, tier: str | None = None) -> list[dict]:
        query = "SELECT * FROM leads WHERE lead_score >= ?"
        params: list[object] = [min_score]
        if tier:
            query += " AND lead_tier = ?"
            params.append(tier)
        query += " ORDER BY lead_score DESC, lead_id ASC"
        with self.connect() as conn:
            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def get_sources_for_lead(self, lead_id: int) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM lead_sources WHERE lead_id = ? ORDER BY id ASC",
                (lead_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_stats(self) -> dict[str, object]:
        with self.connect() as conn:
            total_leads = conn.execute("SELECT COUNT(*) FROM leads").fetchone()[0]
            warm_leads = conn.execute("SELECT COUNT(*) FROM leads WHERE lead_tier = 'Warm'").fetchone()[0]
            potential_leads = conn.execute("SELECT COUNT(*) FROM leads WHERE lead_tier = 'Potential'").fetchone()[0]
            total_sources = conn.execute("SELECT COUNT(*) FROM lead_sources").fetchone()[0]
            total_failed = conn.execute("SELECT COUNT(*) FROM failed_records").fetchone()[0]
            by_state = conn.execute(
                "SELECT state, COUNT(*) AS cnt FROM leads WHERE state != '' GROUP BY state ORDER BY cnt DESC LIMIT 10"
            ).fetchall()
            return {
                "total_leads": total_leads,
                "warm_leads": warm_leads,
                "potential_leads": potential_leads,
                "total_source_records": total_sources,
                "failed_records": total_failed,
                "top_states": [dict(r) for r in by_state],
            }
