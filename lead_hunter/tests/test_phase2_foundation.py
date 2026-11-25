"""Automated unit and integration tests for Phase 2 Data Foundation."""

from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from src.database import LeadDatabase
from src.importer import export_leads_csv, import_file
from src.models import LeadRecord
from src.normalizer import (
    normalize_company_name,
    normalize_lead,
    normalize_phone,
    normalize_state,
    normalize_website,
)
from src.validator import validate_lead


class TestNormalizationAndValidation(unittest.TestCase):
    def test_phone_normalization(self) -> None:
        formatted, digits = normalize_phone("1-512-555-0142 ext 204")
        self.assertEqual(digits, "5125550142")
        self.assertEqual(formatted, "(512) 555-0142")

        _, invalid_digits = normalize_phone("555-0000")
        self.assertEqual(invalid_digits, "")

    def test_company_and_domain_normalization(self) -> None:
        self.assertEqual(normalize_company_name("Apex Commercial Builders, LLC"), "apex commercial builders")
        self.assertEqual(normalize_company_name("Apex Commercial Builders Inc."), "apex commercial builders")

        url, domain = normalize_website("https://www.ApexBuilders.com/projects/")
        self.assertEqual(domain, "apexbuilders.com")
        self.assertEqual(url, "https://apexbuilders.com/projects")

    def test_state_normalization(self) -> None:
        self.assertEqual(normalize_state("Texas"), "TX")
        self.assertEqual(normalize_state("tx"), "TX")
        self.assertEqual(normalize_state("North Carolina"), "NC")

    def test_validation_rejects_empty_record(self) -> None:
        bad = normalize_lead(LeadRecord(company_name="", business_phone="555-0000"))
        res = validate_lead(bad)
        self.assertFalse(res.is_valid)
        self.assertTrue(res.errors)


class TestDatabaseAndImport(unittest.TestCase):
    def test_deduplication_and_source_preservation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            db = LeadDatabase(tmp / "test_leads.db")

            lead_a = normalize_lead(
                LeadRecord(
                    company_name="Summit Millwork LLC",
                    website="https://www.summitmillwork.example.com",
                    business_phone="214-555-0199",
                    city="dallas",
                    state="Texas",
                    company_source_url="https://example.com/source-1",
                )
            )
            id1, dup1 = db.upsert_lead(lead_a, source_name="SourceA")
            self.assertFalse(dup1)

            # Second record has Inc., slightly different URL path, same domain/phone, and new email + project info
            lead_b = normalize_lead(
                LeadRecord(
                    company_name="Summit Millwork Inc.",
                    website="summitmillwork.example.com",
                    business_email="bids@summitmillwork.example.com",
                    state="TX",
                    project_name="Downtown Library Casework",
                    project_source_url="https://example.com/project-99",
                    buying_intent_evidence="Active RFP for custom architectural woodwork",
                    lead_score=78,
                    lead_tier="Warm",
                )
            )
            id2, dup2 = db.upsert_lead(lead_b, source_name="SourceB")
            self.assertTrue(dup2)
            self.assertEqual(id1, id2)

            leads = db.get_all_leads()
            self.assertEqual(len(leads), 1)
            self.assertEqual(leads[0]["business_email"], "bids@summitmillwork.example.com")
            self.assertEqual(leads[0]["lead_score"], 78)
            self.assertEqual(leads[0]["lead_tier"], "Warm")

            sources = db.get_sources_for_lead(id1)
            self.assertEqual(len(sources), 2)

    def test_csv_import_and_export_pipeline(self) -> None:
        sample_csv = Path(__file__).resolve().parent.parent / "data" / "imports" / "sample_contractors.csv"
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            db = LeadDatabase(tmp / "pipeline.db")

            summary = import_file(db, sample_csv, source_name="TestCSV")
            self.assertEqual(summary.total_rows, 4)
            self.assertEqual(summary.inserted, 2)
            self.assertEqual(summary.duplicates, 1)
            self.assertEqual(summary.failed, 1)

            stats = db.get_stats()
            self.assertEqual(stats["total_leads"], 2)
            self.assertEqual(stats["failed_records"], 1)

            export_path = tmp / "exported.csv"
            count = export_leads_csv(db, export_path)
            self.assertEqual(count, 2)
            with export_path.open("r", encoding="utf-8-sig") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 2)

            import zipfile
            from src.importer import export_leads_xlsx

            xlsx_path = tmp / "exported.xlsx"
            xcount = export_leads_xlsx(db, xlsx_path)
            self.assertEqual(xcount, 2)
            self.assertTrue(xlsx_path.exists())
            with zipfile.ZipFile(xlsx_path, "r") as zf:
                self.assertIn("xl/worksheets/sheet1.xml", zf.namelist())
                sheet_xml = zf.read("xl/worksheets/sheet1.xml").decode("utf-8")
                self.assertIn("Apex", sheet_xml)

    def test_nmbs_and_company_name_alias_import(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            db = LeadDatabase(tmp / "nmbs_leads.db")
            csv_path = tmp / "nmbs_companies.csv"
            csv_path.write_text(
                "Nmbs,Company Name\n"
                "512-555-0188,Lonestar Millwork Builders LLC\n"
                "3035550199,Front Range Commercial Builders\n",
                encoding="utf-8",
            )
            summary = import_file(db, csv_path, source_name="NmbsSheet")
            self.assertEqual(summary.inserted, 2)
            leads = db.get_all_leads()
            phones = {l["company_name"]: l["business_phone"] for l in leads}
            self.assertEqual(phones["Lonestar Millwork Builders LLC"], "(512) 555-0188")
            self.assertEqual(phones["Front Range Commercial Builders"], "(303) 555-0199")


if __name__ == "__main__":
    unittest.main()
