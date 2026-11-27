# Ai Leads Hunter — Cost Bidding LLC Construction Lead Intelligence Platform

100% free, open-source US construction lead discovery, qualification, deduplication, and outreach pipeline built for **Cost Bidding LLC** (construction estimating, quantity takeoffs, material takeoffs, residential/commercial/industrial estimating, architectural estimating support, and bid preparation).

## Zero-Cost Architecture

- **Zero Paid APIs & Zero Cloud AI Keys**: Operates completely free using public sources and deterministic + optional local AI logic.
- **Persistent SQLite Database (`data/db/leads_hunter.db`)**: Stores companies, contacts, projects, source evidence URLs, cross-session seen phone/email hashes, duplicate review relations, discovery jobs, verification history, scoring history, export logs, and settings using Node's built-in `node:sqlite`.
- **Optional Local AI Engine (Ollama)**: Connects strictly to loopback `http://localhost:11434`, discovers locally installed open-source models automatically, lets you disable AI anytime, and falls back seamlessly to deterministic Python/TypeScript rules when offline.
- **All 50 US States + 10 Municipal Open-Data Portals**:
  - **USASpending.gov Public API** (12 construction, architectural, engineering, and specialty trade NAICS codes across all 50 states + DC — no API key required).
  - **10 Municipal Socrata Building Permit Portals** (Austin TX, NYC DOB, Dallas TX, NYC DOB NOW, Chicago IL, Orlando FL, Seattle WA, Cincinnati OH, New Orleans LA, San Francisco CA — anonymous public access).
  - **Public Company Website Contact Extractor**: Respects `robots.txt` and extracts publicly listed emails, phones, and estimators with honest verification statuses (`Verified`, `Publicly Listed`, `Inferred`, `Unknown`).
- **Explainable 0–100 Scoring & 4 Quality Tiers**:
  - `Hot (80–100)`, `Warm (60–79)`, `Potential (40–59)`, `Low Priority (<40)` across 6 transparent factors (Company Relevance 20, Trade/Service Match 20, Active Projects 20, Decision-Maker 15, Contact Reachability 15, Source Credibility 10). Never awards points for missing fields.
- **16 Cost Bidding Outreach Statuses & SMS Suppression Guard**:
  - Includes `New`, `Ready for Calling`, `Calling`, `No Answer`, `Not Connected`, `Interested`, `Follow-up`, `SMS Sent`, `Replied`, `STOP / Opted Out`, `Qualified`, `Meeting`, `Project Received`, `Won`, `Lost`, and `Not Interested`. Leads marked `STOP / Opted Out`, `Lost`, or `Not Interested` are automatically blocked from Zoom SMS CSV exports.

## Local Development & Verification

```bash
npm install
npm run dev          # Starts Express + Vite on http://localhost:3000
npm run lint         # TypeScript typecheck
npm run build        # Production Vite bundle

# Node automated unit tests (SQLite, scoring, deduplication, Ollama fallback, security)
npx tsx --test tests/backend.test.ts

# Python pipeline automated tests
PYTHONPATH=/app/applet/lead_hunter python3 -m unittest discover -s /app/applet/lead_hunter/tests -t /app/applet/lead_hunter -v
```

## Optional Local Ollama Setup

1. Install Ollama from `https://ollama.com` (no API key or subscription).
2. Pull a local model: `ollama pull qwen2.5:3b`
3. Open **Local AI Engine -> Settings** in the left sidebar and click **Discover Models**.
