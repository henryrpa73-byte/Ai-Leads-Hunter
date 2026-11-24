"""Tests for the Lead dataclass in models/lead.py."""

from __future__ import annotations

import unittest

from models.lead import Lead


class TestLeadDataclass(unittest.TestCase):
    def test_create_lead_and_roundtrip(self) -> None:
        lead = Lead(
            company_name="Apex Commercial Builders LLC",
            website="https://apexcommercial.example.com",
            business_phone="(512) 555-0142",
            city="Austin",
            state="TX",
            zip_code="78701",
            company_category="General Contractor",
            service_opportunity="Construction Estimation",
            project_name="Downtown Medical Office Fitout",
            project_location="Austin, TX",
            project_status="Solicitation",
            project_source_url="https://sam.gov/opp/example",
            company_source_url="https://apexcommercial.example.com",
            buying_intent_evidence="Active RFP requiring quantity takeoff and cost estimate",
            qualification_reason="Commercial GC bidding mid-rise medical project",
            lead_score=85,
            confidence_level="High",
            lead_tier="Warm",
        )
        data = lead.to_dict()
        restored = Lead.from_dict(data)
        self.assertEqual(restored.company_name, "Apex Commercial Builders LLC")
        self.assertEqual(restored.lead_score, 85)
        self.assertEqual(restored.project_source_url, "https://sam.gov/opp/example")

    def test_score_bounds_enforced(self) -> None:
        with self.assertRaises(ValueError):
            Lead(company_name="Bad High Score Co", lead_score=101)
        with self.assertRaises(ValueError):
            Lead(company_name="Bad Low Score Co", lead_score=-1)
        with self.assertRaises(TypeError):
            Lead(company_name="Bad Type Score Co", lead_score="80")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
