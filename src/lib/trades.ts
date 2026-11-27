export const CONSTRUCTION_TRADES = [
  'General Contractors',
  'Subcontractors',
  'Roofing Contractors',
  'Electrical Contractors',
  'Plumbing Contractors',
  'HVAC Contractors',
  'Concrete Contractors',
  'Framing Contractors',
  'Drywall Contractors',
  'Flooring Contractors',
  'Painting Contractors',
  'Masonry Contractors',
  'Excavation Contractors',
  'Civil Contractors',
  'Steel Contractors',
  'Glass Contractors',
  'Landscaping Contractors',
  'Architecture Firms',
  'Engineering Firms',
  'Design-Build Companies',
  'Construction Management Companies',
] as const;

export type ConstructionTrade = (typeof CONSTRUCTION_TRADES)[number];

export const COMPANY_CATEGORIES = [
  'General Contractor',
  'Commercial Builder',
  'Residential Builder / Remodeler',
  'Specialty Subcontractor',
  'Architecture Firm',
  'Engineering Firm',
  'Design-Build Company',
  'Construction Management',
  'Millwork & Cabinetry Contractor',
] as const;

export const PROJECT_TYPES = [
  'Commercial',
  'Residential',
  'Industrial',
  'Institutional / Civic',
  'Infrastructure / Civil',
  'Tenant Improvement / Interior',
  'Mixed-Use',
] as const;

const TRADE_RULES: Array<{ trade: ConstructionTrade; pattern: RegExp }> = [
  { trade: 'Architecture Firms', pattern: /\b(architect|architecture|architectural|541310|541340|drafting|cad)\b/i },
  { trade: 'Engineering Firms', pattern: /\b(engineering|engineer|structural engineer|structural design|geotechnical|541330|mep design)\b/i },
  { trade: 'Design-Build Companies', pattern: /\b(design[\s-]*build|design\/build|turnkey)\b/i },
  { trade: 'Construction Management Companies', pattern: /\b(construction management|program management|cm\/gc|owner'?s rep)\b/i },
  { trade: 'Roofing Contractors', pattern: /\b(roofing|roofer|roof replacement|sheet metal roof|waterproofing)\b/i },
  { trade: 'Electrical Contractors', pattern: /\b(electrical|electrician|power distribution|lighting|low voltage|238210)\b/i },
  { trade: 'Plumbing Contractors', pattern: /\b(plumbing|plumber|piping|pipefitter|sanitary|water line)\b/i },
  { trade: 'HVAC Contractors', pattern: /\b(hvac|mechanical|heating|air conditioning|refrigeration|ventilation|ductwork|238220)\b/i },
  { trade: 'Concrete Contractors', pattern: /\b(concrete|foundation|slab|paving|shotcrete|tilt-up|238110)\b/i },
  { trade: 'Framing Contractors', pattern: /\b(framing|carpentry|rough carpentry|finish carpentry|millwork|cabinet|238130|238350|337110)\b/i },
  { trade: 'Drywall Contractors', pattern: /\b(drywall|gypsum|plaster|acoustical ceiling|stucco|238310)\b/i },
  { trade: 'Flooring Contractors', pattern: /\b(flooring|tile|terrazzo|carpet|hardwood|epoxy floor|238330)\b/i },
  { trade: 'Painting Contractors', pattern: /\b(painting|painter|coatings|wall covering|238320)\b/i },
  { trade: 'Masonry Contractors', pattern: /\b(masonry|brick|block|stonework|cmu|238140)\b/i },
  { trade: 'Excavation Contractors', pattern: /\b(excavation|earthwork|grading|trenching|site prep|demolition|238910)\b/i },
  { trade: 'Civil Contractors', pattern: /\b(civil|highway|bridge|utility|sewer|stormwater|asphalt|237310|237110)\b/i },
  { trade: 'Steel Contractors', pattern: /\b(steel|structural steel|ironwork|rebar|metal building|welding|238120)\b/i },
  { trade: 'Glass Contractors', pattern: /\b(glass|glazing|curtain wall|storefront|window installation|238150)\b/i },
  { trade: 'Landscaping Contractors', pattern: /\b(landscaping|landscape|irrigation|hardscape|grounds)\b/i },
  { trade: 'General Contractors', pattern: /\b(general contractor|general construction|builders|builder|commercial building|residential remodeler|236220|236115|236118)\b/i },
  { trade: 'Subcontractors', pattern: /\b(subcontractor|specialty trade|trade contractor|contractor)\b/i },
];

export function classifyConstructionTrade(text: string): ConstructionTrade {
  const hay = text || '';
  for (const rule of TRADE_RULES) {
    if (rule.pattern.test(hay)) {
      return rule.trade;
    }
  }
  return 'General Contractors';
}

export function classifyCompanyCategory(text: string, trade?: string): string {
  const hay = `${text} ${trade || ''}`.toLowerCase();
  if (/(architecture|architectural|541310|541340)/.test(hay)) return 'Architecture Firm';
  if (/(engineering|structural|541330)/.test(hay)) return 'Engineering Firm';
  if (/(design[\s-]*build)/.test(hay)) return 'Design-Build Company';
  if (/(construction management|cm\/gc)/.test(hay)) return 'Construction Management';
  if (/(millwork|cabinet|casework|finish carpentry|337110|238350)/.test(hay)) return 'Millwork & Cabinetry Contractor';
  if (/(residential|single-family|remodeler|home builder|236115|236118)/.test(hay)) return 'Residential Builder / Remodeler';
  if (/(commercial|institutional|236220)/.test(hay)) return 'Commercial Builder';
  if (/(roofing|electrical|plumbing|hvac|concrete|framing|drywall|flooring|painting|masonry|excavation|civil|steel|glass|landscaping|subcontractor)/.test(hay)) {
    return 'Specialty Subcontractor';
  }
  return 'General Contractor';
}

export function classifyProjectType(text: string): string {
  const low = (text || '').toLowerCase();
  if (/(industrial|warehouse|manufacturing|plant|factory|refinery)/.test(low)) return 'Industrial';
  if (/(school|hospital|medical|federal|municipal|government|courthouse|clinic|va |dod|army|navy)/.test(low)) {
    return 'Institutional / Civic';
  }
  if (/(highway|bridge|road|sewer|utility|water main|civil|culvert|paving)/.test(low)) {
    return 'Infrastructure / Civil';
  }
  if (/(tenant|fitout|fit-out|interior remodel|buildout|build-out|suite|office remodel)/.test(low)) {
    return 'Tenant Improvement / Interior';
  }
  if (/(mixed[\s-]*use)/.test(low)) return 'Mixed-Use';
  if (/(residential|single family|multi-family|multifamily|apartment|duplex|townhome|kitchen|bath)/.test(low)) {
    return 'Residential';
  }
  if (/(commercial|retail|office|hotel|restaurant|storefront)/.test(low)) {
    return 'Commercial';
  }
  return 'Commercial';
}

export function inferCostBiddingRelevance(text: string, trade: string): {
  serviceOpportunity: 'Construction Estimation' | 'Architectural Services' | 'Millwork Services';
  supportLabel: string;
} {
  const hay = `${text} ${trade}`.toLowerCase();
  if (/(millwork|cabinet|casework|woodwork|finish carpentry|337110|238350)/.test(hay)) {
    return {
      serviceOpportunity: 'Millwork Services',
      supportLabel: 'Quantity Takeoffs & Millwork Shop Drawings',
    };
  }
  if (
    /(architecture|architect|drafting|permit set|cd set|construction drawing|floor plan|site plan|elevation|3d|rendering|design-build|remodel|renovation|addition|tenant|541310|541330|541340)/.test(
      hay,
    )
  ) {
    return {
      serviceOpportunity: 'Architectural Services',
      supportLabel: 'Architectural Estimating Support, Permit Sets & 2D/3D Drawings',
    };
  }
  if (/(industrial|warehouse|plant)/.test(hay)) {
    return {
      serviceOpportunity: 'Construction Estimation',
      supportLabel: 'Industrial Estimating, Material Takeoffs & Bid Preparation',
    };
  }
  if (/(residential|single-family|home|remodeler)/.test(hay)) {
    return {
      serviceOpportunity: 'Construction Estimation',
      supportLabel: 'Residential Estimating & Quantity Takeoffs',
    };
  }
  return {
    serviceOpportunity: 'Construction Estimation',
    supportLabel: 'Commercial Estimating, Quantity Takeoffs & Bid Preparation',
  };
}
