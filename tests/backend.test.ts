import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LeadDatabase } from '../server/db.ts';
import { analyzeLeadWithLocalAi } from '../server/ollama.ts';
import { assertSafeOllamaUrl, assertSafePublicUrl, isPrivateIp } from '../server/security.ts';
import {
  buildNormalizedLead,
  DEFAULT_SCORING_CONFIG,
  getSmsReadyLeads,
  leadsToCsv,
  leadsToExcelBuffer,
  leadsToZoomSmsCsv,
  mergeLeadsDeduplicated,
  parseCsvToLeads,
  parseExcelToLeads,
  scoreLead,
} from '../src/lib/leadEngine.ts';
import type { Lead } from '../src/types/lead.ts';

function makeTempDb(): { db: LeadDatabase; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-leads-hunter-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new LeadDatabase(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Security: private IPs, metadata endpoints, and non-loopback Ollama URLs are blocked', async () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('192.168.1.10'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);

  await assert.rejects(() => assertSafePublicUrl('http://127.0.0.1:8080/admin'));
  await assert.rejects(() => assertSafePublicUrl('http://169.254.169.254/latest/meta-data/'));
  await assert.rejects(() => assertSafePublicUrl('ftp://example.com/file'));

  const validOllama = assertSafeOllamaUrl('http://localhost:11434');
  assert.equal(validOllama.origin, 'http://localhost:11434');
  assert.throws(() => assertSafeOllamaUrl('https://evil.example.com:11434'));
});

test('Scoring: 6-factor 0-100 rubric awards zero points for missing fields and classifies 4 tiers honestly', () => {
  const minimal = buildNormalizedLead({
    company_name: 'Mystery Co',
    source_name: 'Manual Import',
  });
  assert.equal(minimal.lead_tier, 'Low Priority');
  assert.ok(minimal.lead_score < 40, `Expected <40, got ${minimal.lead_score}`);
  assert.equal(minimal.website_status, 'Unknown');
  assert.equal(minimal.phone_status, 'Unknown');
  assert.equal(minimal.email_status, 'Unknown');
  assert.equal(minimal.contact_status, 'Unknown');

  const hotCandidate = buildNormalizedLead({
    company_name: 'Apex Commercial General Contractors LLC',
    construction_trade: 'General Contractors',
    company_category: 'Commercial Builder',
    city: 'Austin',
    state: 'TX',
    zip_code: '78701',
    business_phone: '5125550199',
    business_email: 'bids@apexgc.example',
    website: 'https://apexgc.example',
    website_status: 'Verified',
    email_status: 'Publicly Listed',
    phone_status: 'Publicly Listed',
    contact_person: 'Jordan Lee',
    job_title: 'Chief Estimator',
    contact_status: 'Publicly Listed',
    project_name: 'Municipal Hospital Annex Expansion',
    project_description: 'Commercial takeoff and $2.4M building addition.',
    project_value: '$2.4M',
    project_status: 'Active',
    project_source_url: 'https://www.usaspending.gov/award/CONT_AWD_TEST_1',
    buying_intent_evidence: 'Won $2.4M federal commercial hospital addition contract',
    source_name: 'USASpending.gov',
  });

  const scored = scoreLead(hotCandidate, DEFAULT_SCORING_CONFIG);
  assert.equal(scored.tier, 'Hot');
  assert.ok(scored.score >= 80, `Expected >=80, got ${scored.score}`);
  assert.equal(scored.breakdown.length, 6);
  const sum = scored.breakdown.reduce((acc, f) => acc + f.points, 0);
  assert.equal(sum, scored.score);
});

test('Deduplication & SMS Suppression: preserves all source URLs, blocks repeat phones/emails, and skips STOP leads', () => {
  const leadA = buildNormalizedLead({
    id: 'lead-a',
    company_name: 'Summit Millwork & Builders Inc',
    city: 'Dallas',
    state: 'TX',
    business_phone: '(214) 555-0111',
    business_email: 'estimating@summitmillwork.example',
    project_source_url: 'https://www.usaspending.gov/award/A',
    source_name: 'USASpending.gov',
  });

  const duplicateByPhone = buildNormalizedLead({
    id: 'lead-b',
    company_name: 'Summit Millwork LLC',
    city: 'Dallas',
    state: 'TX',
    business_phone: '214-555-0111',
    project_source_url: 'https://www.dallasopendata.com/resource/permit-123',
    source_name: 'Dallas Building Permits',
    outreach_status: 'STOP / Opted Out',
  });

  const { merged, duplicateCount } = mergeLeadsDeduplicated([leadA], [duplicateByPhone], {
    checkCrossSession: false,
  });
  assert.equal(merged.length, 1);
  assert.equal(duplicateCount, 1);
  assert.ok(merged[0].all_sources.includes('USASpending.gov'));
  assert.ok(merged[0].all_sources.includes('Dallas Building Permits'));
  assert.ok((merged[0].all_source_urls || []).length >= 2);

  // Suppressed status must block Zoom SMS export
  const optedOutLead: Lead = { ...merged[0], outreach_status: 'STOP / Opted Out' };
  const ready = getSmsReadyLeads([optedOutLead]);
  assert.equal(ready.length, 0);
  const smsCsv = leadsToZoomSmsCsv([optedOutLead]);
  assert.equal(smsCsv.trim().split('\n').length, 1); // Header only
});

test('SQLite Persistence: stores leads, logs duplicate relations with preserved URLs, and blocks cleared phones', () => {
  const { db, cleanup } = makeTempDb();
  try {
    const first = buildNormalizedLead({
      company_name: 'Redwood Roofing Contractors LLC',
      state: 'CA',
      city: 'Sacramento',
      business_phone: '(916) 555-0144',
      business_email: 'bids@redwoodroofing.example',
      project_name: 'School Roof Replacement',
      project_value: '$450K',
      project_source_url: 'https://www.usaspending.gov/award/ROOF1',
      source_name: 'USASpending.gov',
    });

    const dup = buildNormalizedLead({
      company_name: 'Redwood Roofing Co',
      state: 'CA',
      city: 'Sacramento',
      business_phone: '9165550144',
      project_source_url: 'https://data.sfgov.org/resource/permit-99',
      source_name: 'SF Building Permits',
    });

    const r1 = db.upsertLeads([first], { checkCrossSession: true });
    assert.equal(r1.added, 1);

    // Importing duplicate updates evidence + records duplicate_relations without creating 2nd row
    const r2 = db.upsertLeads([dup], { checkCrossSession: true });
    assert.equal(r2.added, 0);
    assert.equal(r2.duplicates, 1);

    const stored = db.getLeads();
    assert.equal(stored.length, 1);
    assert.ok(stored[0].all_sources.includes('SF Building Permits'));

    const dups = db.getDuplicateRelations();
    assert.equal(dups.length, 1);
    assert.equal(dups[0].source_url, 'https://data.sfgov.org/resource/permit-99');

    // Clear active table, verify seen_contacts keeps the phone blocked cross-session
    db.clearAllLeadsKeepSeen();
    assert.equal(db.getLeads().length, 0);
    const r3 = db.upsertLeads([first], { checkCrossSession: true });
    assert.equal(r3.added, 0);
    assert.equal(r3.crossSessionBlocked, 1);
  } finally {
    cleanup();
  }
});

test('Ollama Offline Fallback: deterministic rules classify trades, project types, and opportunities with AI disabled', async () => {
  const lead = buildNormalizedLead({
    company_name: 'Precision HVAC & Mechanical Corp',
    project_name: 'Industrial Warehouse Ductwork & Chiller Retrofit',
    project_description: 'Commercial mechanical HVAC installation and sheet metal takeoff.',
  });

  const disabledResult = await analyzeLeadWithLocalAi(lead, {
    enabled: false,
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:3b',
    timeoutMs: 2000,
  });

  assert.equal(disabledResult.usedOllama, false);
  assert.equal(disabledResult.model, 'deterministic-rules');
  assert.equal(disabledResult.construction_trade, 'HVAC Contractors');
  assert.equal(disabledResult.project_type, 'Industrial');
  assert.ok(disabledResult.ai_summary.includes('Precision HVAC & Mechanical Corp'));
});

test('CSV and Excel (.xlsx) Export/Import Roundtrip preserves lead fields', async () => {
  const sample = buildNormalizedLead({
    company_name: 'Sierra Concrete & Framing LLC',
    construction_trade: 'Concrete Contractors',
    city: 'Denver',
    state: 'CO',
    zip_code: '80202',
    business_phone: '(303) 555-0188',
    business_email: 'estimates@sierraconcrete.example',
    website: 'https://sierraconcrete.example',
    project_name: 'Civic Center Foundation Package',
    project_value: '$600K',
    source_name: 'USASpending.gov',
  });

  const csvText = leadsToCsv([sample]);
  const parsedCsv = parseCsvToLeads(csvText, 'roundtrip.csv');
  assert.equal(parsedCsv.length, 1);
  assert.equal(parsedCsv[0].company_name, 'Sierra Concrete & Framing LLC');
  assert.equal(parsedCsv[0].phone_digits, '3035550188');

  const xlsxBuf = await leadsToExcelBuffer([sample]);
  const parsedXlsx = await parseExcelToLeads(xlsxBuf, 'roundtrip.xlsx');
  assert.equal(parsedXlsx.length, 1);
  assert.equal(parsedXlsx[0].company_name, 'Sierra Concrete & Framing LLC');
  assert.equal(parsedXlsx[0].state, 'CO');
});
