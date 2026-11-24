"""Command-line interface for Construction Lead Hunter AI (Phases 2 & 3)."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from .agents.company_research import research_company_websites
from .agents.discovery_permits import discover_permits
from .agents.discovery_sam import discover_sam_opportunities
from .agents.discovery_usaspending import discover_usaspending
from .config import get_settings
from .database import LeadDatabase
from .importer import export_leads_csv, import_file
from .logger import setup_logger


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lead-hunter",
        description="Construction Lead Hunter AI — Local Python Lead Generation CLI",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # Phase 2 commands
    sub.add_parser("init-db", help="Create SQLite database and data folders")

    imp = sub.add_parser("import-file", help="Import a CSV or XLSX file into SQLite")
    imp.add_argument("path", help="Path to .csv or .xlsx file")
    imp.add_argument("--source", default="", help="Source label (defaults to file name)")
    imp.add_argument("--resume", default=None, help="Optional run_id to resume")

    sub.add_parser("stats", help="Show current database lead & duplicate statistics")

    exp = sub.add_parser("export-csv", help="Export leads from SQLite to CSV")
    exp.add_argument("--out", default="", help="Output CSV path (defaults to data/exports/)")
    exp.add_argument("--min-score", type=int, default=0, help="Minimum lead score filter")
    exp.add_argument("--tier", choices=["Warm", "Potential", "Unqualified"], default=None)

    # Phase 3 commands
    usa = sub.add_parser("discover-usaspending", help="Discover US construction awards from USASpending.gov (no API key)")
    usa.add_argument("--state", default="", help="2-letter US state filter (e.g., TX)")
    usa.add_argument("--days", type=int, default=120, help="Lookback days (default 120)")
    usa.add_argument("--limit", type=int, default=5, help="Max awards per NAICS code (default 5)")

    prm = sub.add_parser("discover-permits", help="Discover active contractors from public city permit portals")
    prm.add_argument("--city", default="all", help="austin, chicago, or all")
    prm.add_argument("--limit", type=int, default=15, help="Max permits per city (default 15)")

    sam = sub.add_parser("discover-sam", help="Discover opportunities from SAM.gov (requires free SAM_GOV_API_KEY)")
    sam.add_argument("--days", type=int, default=30, help="Lookback days (default 30)")
    sam.add_argument("--limit", type=int, default=15, help="Max opportunities per NAICS code (default 15)")

    dall = sub.add_parser("discover-all", help="Run all free public contractor discovery sources")
    dall.add_argument("--state", default="", help="Optional 2-letter state for USASpending")
    dall.add_argument("--limit", type=int, default=10, help="Max records per source/category")

    web = sub.add_parser("research-websites", help="Respectfully enrich leads that have public websites")
    web.add_argument("--limit", type=int, default=10, help="Max websites to inspect")

    return parser


def main(argv: list[str] | None = None) -> int:
    settings = get_settings()
    logger = setup_logger(settings.logs_dir)
    db = LeadDatabase(settings.db_path)

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "init-db":
        db.init_schema()
        logger.info("Database ready at %s", settings.db_path)
        print(f"Database initialized: {settings.db_path}")
        return 0

    if args.command == "import-file":
        summary = import_file(
            db,
            Path(args.path),
            source_name=args.source,
            logger=logger,
            resume_run_id=args.resume,
        )
        print(json.dumps(summary.__dict__, indent=2))
        return 0

    if args.command == "stats":
        print(json.dumps(db.get_stats(), indent=2))
        return 0

    if args.command == "export-csv":
        out_path = (
            Path(args.out)
            if args.out
            else settings.exports_dir / f"leads_export_{datetime.now():%Y%m%d_%H%M%S}.csv"
        )
        count = export_leads_csv(db, out_path, min_score=args.min_score, tier=args.tier)
        print(f"Exported {count} leads to {out_path}")
        return 0

    if args.command == "discover-usaspending":
        res = discover_usaspending(
            db,
            state=args.state,
            days_back=args.days,
            limit_per_naics=args.limit,
            request_delay=settings.request_delay_seconds,
            user_agent=settings.http_user_agent,
            logger=logger,
        )
        print(json.dumps(res.__dict__, indent=2))
        return 0

    if args.command == "discover-permits":
        cities = None if args.city.lower() == "all" else [args.city.lower()]
        res = discover_permits(
            db,
            cities=cities,
            limit_per_city=args.limit,
            app_token=settings.socrata_app_token,
            request_delay=settings.request_delay_seconds,
            user_agent=settings.http_user_agent,
            logger=logger,
        )
        print(json.dumps(res.__dict__, indent=2))
        return 0

    if args.command == "discover-sam":
        res = discover_sam_opportunities(
            db,
            api_key=settings.sam_gov_api_key,
            days_back=args.days,
            limit=args.limit,
            user_agent=settings.http_user_agent,
            logger=logger,
        )
        print(json.dumps(res.__dict__, indent=2))
        return 0

    if args.command == "discover-all":
        results = [
            discover_usaspending(
                db,
                state=args.state,
                limit_per_naics=args.limit,
                request_delay=settings.request_delay_seconds,
                user_agent=settings.http_user_agent,
                logger=logger,
            ).__dict__,
            discover_permits(
                db,
                limit_per_city=args.limit,
                app_token=settings.socrata_app_token,
                request_delay=settings.request_delay_seconds,
                user_agent=settings.http_user_agent,
                logger=logger,
            ).__dict__,
            discover_sam_opportunities(
                db,
                api_key=settings.sam_gov_api_key,
                limit=args.limit,
                user_agent=settings.http_user_agent,
                logger=logger,
            ).__dict__,
        ]
        print(json.dumps(results, indent=2))
        return 0

    if args.command == "research-websites":
        res = research_company_websites(
            db,
            limit=args.limit,
            request_delay=settings.request_delay_seconds,
            user_agent=settings.http_user_agent,
            logger=logger,
        )
        print(json.dumps(res.__dict__, indent=2))
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
