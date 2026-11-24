"""Automated tests for Phase 3 Contractor Discovery and Website Research."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from src.agents.company_research import extract_company_signals, research_company_websites
from src.agents.discovery_permits import discover_permits
from src.agents.discovery_sam import discover_sam_opportunities
from src.agents.discovery_usaspending import discover_usaspending
from src.database import LeadDatabase
from src.models import LeadRecord
from src.normalizer import normalize_lead


class TestPhase3Discovery(unittest.TestCase):
    def test_usaspending_discovery_and_dedup(self) -> None:
        def fake_http(url, *, method="GET", payload=None, user_agent="", timeout=20):
            if "spending_by_award" in url:
                return {
                    "results": [
                        {
                            "Award ID": "W91234",
                            "Recipient Name": "LONESTAR COMMERCIAL BUILDERS LLC",
                            "Award Amount": 1250000.0,
                            "Description": "NEW COMMERCIAL ADMINISTRATION BUILDING MILLWORK AND INTERIOR FITOUT",
                            "Start Date": "2026-09-01",
                            "Awarding Agency": "Department of Defense",
                            "Place of Performance State Code": "TX",
                            "Place of Performance Zip5": "78701",
                            "generated_internal_id": "CONT_AWD_W91234",
                        }
                    ]
                }
            return {
                "recipient": {
                    "recipient_name": "LONESTAR COMMERCIAL BUILDERS LLC",
                    "business_categories": ["Small Business", "General Contractor"],
                    "location": {"city_name": "AUSTIN", "state_code": "TX", "zip5": "78701"},
                },
                "place_of_performance": {"city_name": "AUSTIN", "state_code": "TX", "zip5": "78701"},
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            db = LeadDatabase(Path(tmpdir) / "test.db")
            res = discover_usaspending(
                db,
                naics_codes=["236220", "337110"],
                limit_per_naics=1,
                request_delay=0,
                http_getter=fake_http,
            )
            self.assertEqual(res.fetched, 2)
            self.assertEqual(res.inserted, 1)
            self.assertEqual(res.duplicates, 1)

            leads = db.get_all_leads()
            self.assertEqual(len(leads), 1)
            self.assertEqual(leads[0]["state"], "TX")
            self.assertIn("usaspending.gov/award/CONT_AWD_W91234", leads[0]["project_source_url"])

    def test_permit_portals_discovery(self) -> None:
        def fake_socrata(url, *, where, order, limit, app_token="", user_agent="", timeout=20):
            if "austintexas" in url:
                return [
                    {
                        "permit_number": "2026-9991 BP",
                        "permit_class_mapped": "Commercial",
                        "work_class": "Remodel",
                        "description": "Interior architectural remodel and custom cabinetry",
                        "permit_location": "400 CONGRESS AVE",
                        "issue_date": "2026-11-10T00:00:00.000",
                        "status_current": "Active",
                        "contractor_company_name": "Capitol Millwork Builders LLC",
                        "contractor_phone": "512-555-0188",
                        "original_zip": "78701",
                    }
                ]
            return [
                {
                    "permit_": "100999888",
                    "work_description": "INTERIOR COMMERCIAL BUILD OUT",
                    "street_number": "100",
                    "street_direction": "N",
                    "street_name": "STATE ST",
                    "issue_date": "2026-11-12T00:00:00.000",
                    "reported_cost": "450000",
                    "contact_1_type": "CONTRACTOR-GENERAL CONTRACTOR",
                    "contact_1_name": "Midwest Builders Inc",
                    "contact_1_city": "CHICAGO",
                    "contact_1_state": "IL",
                    "contact_1_zipcode": "60602",
                }
            ]

        with tempfile.TemporaryDirectory() as tmpdir:
            db = LeadDatabase(Path(tmpdir) / "permits.db")
            res = discover_permits(
                db,
                cities=["austin", "chicago"],
                limit_per_city=5,
                request_delay=0,
                fetcher=fake_socrata,
            )
            self.assertEqual(res.fetched, 2)
            self.assertEqual(res.inserted, 2)
            leads = db.get_all_leads()
            self.assertEqual({l["state"] for l in leads}, {"TX", "IL"})

    def test_sam_graceful_skip_without_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db = LeadDatabase(Path(tmpdir) / "sam.db")
            res = discover_sam_opportunities(db, api_key="")
            self.assertEqual(res.fetched, 0)
            self.assertIn("SAM_GOV_API_KEY", res.skipped_reason)

    def test_company_website_research_respects_robots_and_extracts_signals(self) -> None:
        sample_html = """
        <html>
          <head><title>Apex Millwork &amp; Estimating</title></head>
          <body>
            <h1>Commercial Millwork Shop Drawings &amp; Preconstruction Estimating</h1>
            <p>Contact our estimating desk at bids@apexmillwork.org or (512) 555-0177.</p>
          </body>
        </html>
        """
        signals = extract_company_signals(sample_html, "https://apexmillwork.org")
        self.assertEqual(signals["emails"], ["bids@apexmillwork.org"])
        self.assertEqual(signals["phones"], ["(512) 555-0177"])
        self.assertIn("Millwork / Cabinetry", signals["services"])
        self.assertIn("Estimating / Bidding", signals["services"])

        with tempfile.TemporaryDirectory() as tmpdir:
            db = LeadDatabase(Path(tmpdir) / "web.db")
            db.upsert_lead(normalize_lead(LeadRecord(company_name="Allowed Co", website="https://allowed.org", state="TX")))
            db.upsert_lead(normalize_lead(LeadRecord(company_name="Blocked Co", website="https://blocked.org", state="TX")))

            summary = research_company_websites(
                db,
                limit=5,
                request_delay=0,
                robots_checker=lambda url, ua: "allowed.org" in url,
                html_fetcher=lambda url, user_agent="": sample_html,
            )
            self.assertEqual(summary.checked, 2)
            self.assertEqual(summary.updated, 1)
            self.assertEqual(summary.blocked_or_disallowed, 1)


if __name__ == "__main__":
    unittest.main()
