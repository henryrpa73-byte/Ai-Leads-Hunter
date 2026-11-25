"""Automated tests for Phase 3 Contractor Discovery and Contact Enrichment."""

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
                "executive_details": {
                    "officers": [{"name": "SARAH JENKINS", "amount": 250000.0}],
                },
                "period_of_performance": {
                    "start_date": "2026-09-01",
                    "end_date": "2027-06-30",
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
            self.assertEqual(leads[0]["contact_person"], "Sarah Jenkins")
            self.assertIn("Live Won Project", leads[0]["project_status"])
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
                        "expiresdate": "2027-05-10T00:00:00.000",
                        "status_current": "Active",
                        "contractor_company_name": "Capitol Millwork Builders LLC",
                        "contractor_full_name": "Carlos Mendez",
                        "contractor_trade": "General Contractor",
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
            tx_lead = next(l for l in leads if l["state"] == "TX")
            self.assertEqual(tx_lead["contact_person"], "Carlos Mendez")
            self.assertEqual(tx_lead["business_phone"], "(512) 555-0188")

    def test_sam_graceful_skip_without_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db = LeadDatabase(Path(tmpdir) / "sam.db")
            res = discover_sam_opportunities(db, api_key="")
            self.assertEqual(res.fetched, 0)
            self.assertIn("SAM_GOV_API_KEY", res.skipped_reason)

    def test_company_website_research_respects_robots_and_extracts_contacts(self) -> None:
        home_html = """
        <html>
          <head><title>Apex Millwork &amp; Estimating</title></head>
          <body>
            <h1>Commercial Millwork Shop Drawings &amp; Preconstruction Estimating</h1>
            <p>General inquiries: info@apexmillwork.org</p>
          </body>
        </html>
        """
        contact_html = """
        <html>
          <body>
            <p>David Miller - Chief Estimator</p>
            <p>Send bid packages to bids@apexmillwork.org or call (512) 555-0177.</p>
          </body>
        </html>
        """
        signals = extract_company_signals(contact_html, "https://apexmillwork.org/contact")
        self.assertEqual(signals["emails"], ["bids@apexmillwork.org"])
        self.assertEqual(signals["phones"], ["(512) 555-0177"])
        self.assertEqual(signals["contacts"][0]["name"], "David Miller")
        self.assertIn("Chief Estimator", signals["contacts"][0]["title"])

        def fake_fetch(url, user_agent=""):
            if url.endswith("/contact"):
                return contact_html
            return home_html

        with tempfile.TemporaryDirectory() as tmpdir:
            db = LeadDatabase(Path(tmpdir) / "web.db")
            db.upsert_lead(normalize_lead(LeadRecord(company_name="Allowed Co", website="https://allowed.org", state="TX")))
            db.upsert_lead(normalize_lead(LeadRecord(company_name="Blocked Co", website="https://blocked.org", state="TX")))

            summary = research_company_websites(
                db,
                limit=5,
                request_delay=0,
                robots_checker=lambda url, ua: "allowed.org" in url,
                html_fetcher=fake_fetch,
            )
            self.assertEqual(summary.checked, 2)
            self.assertEqual(summary.updated, 1)
            self.assertEqual(summary.blocked_or_disallowed, 1)

            allowed_row = next(l for l in db.get_all_leads() if l["company_name"] == "Allowed Co")
            self.assertEqual(allowed_row["business_email"], "bids@apexmillwork.org")
            self.assertEqual(allowed_row["business_phone"], "(512) 555-0177")
            self.assertEqual(allowed_row["contact_person"], "David Miller")

    def test_mailto_tel_links_and_domain_matching(self) -> None:
        from src.agents.company_research import _page_matches_company

        html = """
        <html>
          <head><title>Kuchar Construction LLC | Commercial Builders</title></head>
          <body>
            <a href="mailto:estimating@kucharconstruction.com">Email Estimating</a>
            <a href="tel:+15125550191">Call Us</a>
          </body>
        </html>
        """
        sig = extract_company_signals(html, "https://www.kucharconstruction.com")
        self.assertEqual(sig["emails"], ["estimating@kucharconstruction.com"])
        self.assertEqual(sig["phones"], ["(512) 555-0191"])
        self.assertTrue(_page_matches_company("KUCHAR CONSTRUCTION, LLC", html))
        self.assertFalse(_page_matches_company("KUCHAR CONSTRUCTION, LLC", "<html><body>This domain is for sale GoDaddy</body></html>"))


if __name__ == "__main__":
    unittest.main()
