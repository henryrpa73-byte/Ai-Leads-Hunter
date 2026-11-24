# Construction Lead Hunter AI (Local Python + Ollama)

Pure-Python, zero-subscription US construction lead generation platform for **Construction Estimation**, **Architectural Services**, and **Millwork Services**.

## Implemented Phases

### Phase 2: Data Foundation
- Persistent SQLite database (`data/db/leads.db`) with WAL mode
- Normalization for US company names, domains, US 10-digit phones, states, ZIPs, and URLs
- Safe validation & `failed_records` logging
- Cross-source deduplication preserving historical `lead_sources` and evidence URLs
- CSV and Excel (`.xlsx`) import (including Blue Book / SpyDialer sheet headers) & CSV export

### Phase 3: Contractor Discovery & Website Research
- **USASpending.gov (`discover-usaspending`)**: Free federal construction/millwork/architectural awardees (no API key required)
- **Public City Permits (`discover-permits`)**: Free Socrata Open Data building permits (Austin TX, Chicago IL)
- **SAM.gov Opportunities (`discover-sam`)**: Active federal solicitations (requires free `SAM_GOV_API_KEY` in `.env`)
- **Company Website Research (`research-websites`)**: Respects `robots.txt` and extracts public emails, phones, and service keywords

## Windows 11 Quick Start

```powershell
cd C:\path\to\lead_hunter
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env

# Run all automated tests
python -m unittest discover -s tests -v

# Initialize DB & discover real US leads
python -m src.cli init-db
python -m src.cli discover-usaspending --state TX --limit 5
python -m src.cli discover-permits --limit 15
python -m src.cli discover-all --limit 10
python -m src.cli research-websites --limit 10
python -m src.cli stats
python -m src.cli export-csv
```
