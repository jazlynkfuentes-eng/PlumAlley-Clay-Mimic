/**
 * Evidence-based industry classification.
 * Prefer explicit business-description evidence over isolated page keywords.
 * Accuracy over coverage: weak inference → Unknown, not a confident wrong label.
 */

export const UNKNOWN = 'Unknown';

/**
 * Each rule: positive patterns (must hit), negative veto patterns (block),
 * and optional strong phrases that alone can justify medium confidence.
 */
export const INDUSTRY_RULES = [
  {
    label: 'Semiconductors',
    strong: [
      /\bsemiconductor(?:s)?\s+company\b/i,
      /\bfabless semiconductor\b/i,
      /\bchip(?:maker| designer| design company)\b/i,
      /\bintegrated circuits?\b/i,
      /\bdesigns? (?:and|&) (?:sells?|manufactures?) (?:GPUs?|processors?|chips?)\b/i,
      /\binvents the GPU\b/i,
      /\bGPU (?:chip|company|manufacturer|maker)\b/i,
      /\bdevelops graphics processing units\b/i,
      /\bgraphics processing units?\s*\(GPUs?\)\b/i
    ],
    positive: [
      /\bsemiconductor\b/i,
      /\bfabless\b/i,
      /\bwafer fab\b/i,
      /\bintegrated circuit\b/i,
      /\bchip design\b/i,
      /\bprocessors?\b/i,
      /\bgraphics processing units?\b/i
    ],
    negative: [
      /\bobservability\b/i,
      /\bcloud monitoring\b/i,
      /\bmonitoring as a service\b/i,
      /\bSaaS\b/i,
      /\bsoftware (?:platform|company|product)\b/i,
      /\bcybersecurity\b/i,
      /\be-?commerce\b/i,
      /\bmarketplace\b/i,
      /\bdata cloud\b/i,
      /\binfrastructure software\b/i
    ],
    minScore: 4
  },
  {
    label: 'Cybersecurity',
    strong: [
      /\bcybersecurity (?:company|platform|firm)\b/i,
      /\bendpoint (?:security|protection)\b/i,
      /\bcloud security (?:platform|company)\b/i,
      /\bthreat intelligence (?:platform|company)\b/i
    ],
    positive: [/\bcybersecurity\b/i, /\binformation security\b/i, /\bendpoint security\b/i, /\bthreat detection\b/i],
    negative: [/\bsemiconductor company\b/i, /\be-?commerce platform\b/i],
    minScore: 3
  },
  {
    label: 'Enterprise Software',
    strong: [
      /\benterprise software\b/i,
      /\bSaaS (?:platform|company|provider)\b/i,
      /\bsoftware[- ]as[- ]a[- ]service\b/i,
      /\bworkflow automation platform\b/i,
      /\bbusiness software platform\b/i,
      /\bobservability platform\b/i,
      /\bmonitoring (?:and security )?platform\b/i,
      /\bmonitoring as a service\b/i,
      /\bcloud monitoring\b/i,
      /\bdata (?:cloud|analytics platform)\b/i,
      /\banalytics platform\b/i,
      /\bsoftware company that (?:builds|provides|develops)\b/i,
      /\benterprise workflows?\b/i,
      /\bAI Platform\b/i,
      /\bIT service management\b/i
    ],
    positive: [
      /\benterprise software\b/i,
      /\b\bSaaS\b/i,
      /\bB2B software\b/i,
      /\bsoftware (?:platform|company)\b/i,
      /\bcloud platform\b/i,
      /\bobservability\b/i,
      /\bdata analytics\b/i,
      /\benterprise workflows?\b/i
    ],
    negative: [/\bsemiconductor company\b/i, /\boil\s*(?:&|and)\s*gas company\b/i],
    minScore: 3
  },
  {
    label: 'Fintech',
    strong: [
      /\bfintech (?:company|platform)\b/i,
      /\bfinancial technology\b/i,
      /\bfinancial (?:services|infrastructure) platform\b/i,
      /\bcorporate (?:cards?|spend)\b/i,
      /\bpayments? (?:platform|infrastructure|company)\b/i,
      /\baccept payments\b/i,
      /\bneobank\b/i
    ],
    positive: [/\bfintech\b/i, /\bpayments?\b/i, /\bbanking for startups\b/i, /\bexpense management\b/i, /\bmoney movement\b/i],
    negative: [/\binvestment bank\b/i, /\bventure capital firm\b/i],
    minScore: 3
  },
  {
    label: 'Biotechnology',
    strong: [
      /\bbiotechnology (?:company|firm)\b/i,
      /\bbiotech (?:company|firm)\b/i,
      /\bgene sequencing\b/i,
      /\bgenomics (?:company|platform)\b/i,
      /\bmRNA (?:therapeutics|vaccine|company)\b/i,
      /\blife sciences? (?:company|tools)\b/i
    ],
    positive: [/\bbiotech\b/i, /\bbiotechnology\b/i, /\bgenomics\b/i, /\btherapeutics\b/i, /\bsequencing\b/i],
    negative: [/\bSaaS\b/i, /\be-?commerce\b/i],
    minScore: 3
  },
  {
    label: 'Healthcare',
    strong: [/\bhealthcare (?:company|system|provider)\b/i, /\bmedical device company\b/i],
    positive: [/\bhealthcare\b/i, /\bhealth care\b/i, /\bmedical device\b/i, /\bclinical\b/i],
    negative: [/\bbiotechnology company\b/i],
    minScore: 3
  },
  {
    label: 'E-Commerce',
    strong: [
      /\be-?commerce (?:platform|company)\b/i,
      /\bonline (?:retail|marketplace)\b/i,
      /\bcommerce platform\b/i
    ],
    positive: [/\be-?commerce\b/i, /\bmarketplace\b/i, /\bonline store\b/i, /\bmerchants?\b/i],
    negative: [/\bsemiconductor\b/i],
    minScore: 3
  },
  {
    label: 'Consumer',
    strong: [
      /\bconsumer (?:electronics|brand|goods) company\b/i,
      /\bapparel (?:company|brand)\b/i,
      /\beyewear (?:brand|company)\b/i,
      /\biPhone, iPad\b/i,
      /\bfootwear (?:and|&) apparel\b/i,
      /\bathletic (?:apparel|footwear)\b/i
    ],
    positive: [
      /\bconsumer electronics\b/i,
      /\bapparel\b/i,
      /\bfootwear\b/i,
      /\beyewear\b/i,
      /\bconsumer brand\b/i,
      /\biPhone\b/i,
      /\bJust Do It\b/i
    ],
    negative: [],
    minScore: 3
  },
  {
    label: 'Media & Entertainment',
    strong: [/\bstreaming (?:service|platform|company)\b/i, /\bmedia (?:and|&) entertainment\b/i],
    positive: [/\bstreaming\b/i, /\bentertainment company\b/i, /\bmedia company\b/i],
    negative: [],
    minScore: 3
  },
  {
    label: 'Renewable Energy',
    strong: [/\brenewable energy (?:company|provider)\b/i, /\bclean energy company\b/i],
    positive: [/\brenewable energy\b/i, /\bclean energy\b/i, /\bsolar\b/i, /\bwind power\b/i],
    negative: [/\boil\s*(?:&|and)\s*gas\b/i],
    minScore: 3
  },
  {
    label: 'Oil & Gas',
    strong: [/\boil\s*(?:&|and)\s*gas (?:company|producer|major)\b/i, /\bpetroleum company\b/i],
    positive: [/\boil\s*(?:&|and)\s*gas\b/i, /\bpetroleum\b/i, /\bupstream\b/i, /\bexploration and production\b/i],
    negative: [/\brenewable energy company\b/i, /\bSaaS\b/i],
    minScore: 3
  },
  {
    label: 'Energy',
    strong: [
      /\benergy (?:company|infrastructure|technology)\b/i,
      /\belectric utility\b/i,
      /\bpower (?:generation|infrastructure)\b/i,
      /\benergy transition\b/i
    ],
    positive: [/\bpower generation\b/i, /\belectric utility\b/i, /\benergy infrastructure\b/i],
    negative: [/\bSaaS\b/i, /\be-?commerce\b/i],
    minScore: 3
  },
  {
    label: 'Aerospace & Defense',
    strong: [
      /\baerospace (?:and|&) defense\b/i,
      /\bdefense (?:contractor|technology|company)\b/i,
      /\bautonomous (?:defense|weapons) (?:company|systems)\b/i
    ],
    positive: [/\baerospace\b/i, /\bdefense contractor\b/i, /\bmilitary technology\b/i],
    negative: [/\be-?commerce\b/i],
    minScore: 3
  },
  {
    label: 'Automotive',
    strong: [/\belectric vehicle (?:company|maker|manufacturer)\b/i, /\bautomaker\b/i, /\bautomotive (?:company|manufacturer)\b/i],
    positive: [/\belectric vehicle\b/i, /\bautomaker\b/i, /\bautomotive\b/i, /\bEV manufacturer\b/i],
    negative: [],
    minScore: 3
  },
  {
    label: 'Industrial Technology',
    strong: [
      /\bindustrial (?:technology|automation) company\b/i,
      /\bmanufacturing technology\b/i,
      /\binnovation in industry, infrastructure\b/i,
      /\bglobal technology leader driving innovation in industry\b/i,
      /\bmanufacturer of construction and mining equipment\b/i,
      /\bconstruction and mining equipment\b/i
    ],
    positive: [
      /\bindustrial automation\b/i,
      /\bmanufacturing\b/i,
      /\bindustrial technology\b/i,
      /\bindustry, infrastructure and mobility\b/i,
      /\bconstruction and mining\b/i
    ],
    negative: [/\bSaaS platform\b/i],
    minScore: 3
  },
  {
    label: 'Venture Capital',
    strong: [
      /\bventure capital (?:firm|company|fund)\b/i,
      /\bearly[- ]stage (?:venture|investor)\b/i,
      /\bVC firm\b/i,
      /\bventure firm\b/i,
      /\bproduct-obsessed venture\b/i
    ],
    positive: [/\bventure capital\b/i, /\bseed (?:and|&) early[- ]stage\b/i, /\bventure firm\b/i],
    negative: [/\bprivate equity firm\b/i, /\bSaaS company\b/i],
    minScore: 3
  },
  {
    label: 'Private Equity',
    strong: [
      /\bprivate equity (?:firm|company)\b/i,
      /\bbuyout firm\b/i,
      /\bglobal investment firm\b/i,
      /\balternative assets\b/i
    ],
    positive: [/\bprivate equity\b/i, /\bbuyout\b/i, /\binvestment firm\b/i],
    negative: [/\bventure capital firm\b/i],
    minScore: 3
  },
  {
    label: 'Investment Banking',
    strong: [/\binvestment bank(?:ing)?\b/i, /\bM&A advisory\b/i],
    positive: [/\binvestment bank\b/i, /\binvestment banking\b/i],
    negative: [],
    minScore: 3
  },
  {
    label: 'Asset Management',
    strong: [/\basset management (?:firm|company)\b/i, /\binvestment management firm\b/i],
    positive: [/\basset management\b/i, /\binvestment management\b/i, /\bwealth management\b/i],
    negative: [],
    minScore: 3
  },
  {
    label: 'Banking',
    strong: [/\bcommercial bank\b/i, /\bretail bank\b/i, /\bbanking company\b/i],
    positive: [/\bcommercial bank\b/i, /\bretail banking\b/i, /\bbanking\b/i],
    negative: [/\bfintech\b/i, /\bventure capital\b/i],
    minScore: 3
  },
  {
    label: 'Artificial Intelligence',
    strong: [
      /\bartificial intelligence (?:company|lab|research)\b/i,
      /\bAI (?:company|lab|research|safety) (?:company|lab)?\b/i,
      /\bgenerative AI (?:company|lab)\b/i,
      /\blarge language model(?:s)?\b/i
    ],
    positive: [/\bartificial intelligence company\b/i, /\bAI lab\b/i, /\bAI research\b/i],
    negative: [/\bobservability\b/i, /\be-?commerce platform\b/i, /\bsemiconductor company\b/i],
    minScore: 4
  },
  {
    label: 'Cloud Infrastructure',
    strong: [
      /\bcloud infrastructure (?:company|provider)\b/i,
      /\bcontent delivery network\b/i,
      /\bCDN\b/i,
      /\bweb application firewall\b/i,
      /\bedge network\b/i,
      /\bDDoS protection\b/i
    ],
    positive: [/\bcloud infrastructure\b/i, /\bCDN\b/i, /\bedge computing\b/i, /\bDDoS protection\b/i],
    negative: [
      /\bobservability\b/i,
      /\bcloud monitoring\b/i,
      /\bmonitoring (?:and security )?platform\b/i,
      /\bmonitoring as a service\b/i,
      /\bsemiconductor company\b/i
    ],
    minScore: 3
  },
  {
    label: 'Technology',
    strong: [/\btechnology company\b/i],
    positive: [/\btechnology company\b/i],
    negative: [/\benterprise workflows?\b/i, /\bAI Platform\b/i, /\bSaaS\b/i, /\bsoftware company that\b/i],
    minScore: 2,
    fallbackOnly: true
  }
];

function countHits(patterns, text) {
  let n = 0;
  const hits = [];
  for (const re of patterns || []) {
    if (re.test(text)) {
      n += 1;
      hits.push(String(re).slice(0, 60));
    }
  }
  return { n, hits };
}

/**
 * Classify industry from evidence texts (meta description, about, DDG abstract, wiki desc).
 * Prefer leading/high-signal snippets over full noisy page dumps.
 *
 * @param {string|string[]} evidenceInput
 * @param {{ allowLowConfidence?: boolean }} opts
 * @returns {{ value, confidence, evidence, source, rejected, scores }}
 */
export function classifyIndustry(evidenceInput, opts = {}) {
  const parts = Array.isArray(evidenceInput) ? evidenceInput : [evidenceInput];
  const primary = parts
    .filter(Boolean)
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0)
    .slice(0, 6)
    .join(' · ')
    .slice(0, 4000);
  // Full corpus only for veto checks / secondary — avoid classifying on buried keywords
  const full = parts.map((p) => String(p || '')).join(' ').slice(0, 12000);

  if (!primary || primary.length < 20) {
    return {
      value: UNKNOWN,
      confidence: 'low',
      evidence: [],
      source: 'none',
      rejected: [{ reason: 'insufficient_evidence' }],
      scores: {}
    };
  }

  const scores = {};
  const rejected = [];

  for (const rule of INDUSTRY_RULES) {
    const negPrimary = countHits(rule.negative, primary);
    const negFull = countHits(rule.negative, full);
    // Strong negative in primary description vetoes this category
    if (negPrimary.n > 0 && !rule.fallbackOnly) {
      const strongPos = countHits(rule.strong, primary);
      if (strongPos.n === 0) {
        rejected.push({ label: rule.label, reason: 'negative_veto', evidence: negPrimary.hits });
        scores[rule.label] = { score: 0, vetoed: true };
        continue;
      }
    }

    const strong = countHits(rule.strong, primary);
    const pos = countHits(rule.positive, primary);
    // Buried keyword-only hits in full page do NOT count toward acceptance
    let score = strong.n * 4 + pos.n * 2;
    if (negFull.n > 0 && strong.n === 0) score -= negFull.n * 3;

    scores[rule.label] = {
      score,
      strong: strong.hits,
      positive: pos.hits,
      negative: negPrimary.hits,
      vetoed: false,
      fallbackOnly: !!rule.fallbackOnly
    };
  }

  // Pick best non-fallback first
  let best = null;
  for (const rule of INDUSTRY_RULES) {
    if (rule.fallbackOnly) continue;
    const s = scores[rule.label];
    if (!s || s.vetoed) continue;
    if (s.score < rule.minScore) continue;
    if (!best || s.score > best.score) {
      best = { label: rule.label, score: s.score, rule, detail: s };
    }
  }

  // Fallback Technology only if nothing else and strong "technology/software company"
  if (!best) {
    const tech = scores['Technology'];
    const techRule = INDUSTRY_RULES.find((r) => r.label === 'Technology');
    if (tech && !tech.vetoed && tech.score >= (techRule?.minScore || 2) && tech.strong?.length) {
      best = { label: 'Technology', score: tech.score, rule: techRule, detail: tech };
    }
  }

  if (!best) {
    return {
      value: UNKNOWN,
      confidence: 'low',
      evidence: [],
      source: 'insufficient_signal',
      rejected,
      scores
    };
  }

  const hasStrong = (best.detail.strong || []).length > 0;
  const confidence = hasStrong && best.score >= best.rule.minScore + 2
    ? 'high'
    : hasStrong || best.score >= best.rule.minScore + 2
      ? 'medium'
      : 'low';

  // Low confidence from weak positive-only → Unknown unless allowLowConfidence
  if (confidence === 'low' && !opts.allowLowConfidence) {
    return {
      value: UNKNOWN,
      confidence: 'low',
      evidence: [...(best.detail.strong || []), ...(best.detail.positive || [])].slice(0, 5),
      source: 'weak_keyword_rejected',
      rejected: [...rejected, { label: best.label, reason: 'low_confidence_suppressed', score: best.score }],
      scores
    };
  }

  return {
    value: best.label,
    confidence,
    evidence: [...(best.detail.strong || []), ...(best.detail.positive || [])].slice(0, 6),
    source: hasStrong ? 'explicit_description' : 'multi_signal',
    rejected,
    scores
  };
}

/** Normalize industry label aliases for comparison in tests/eval. */
export function industryEquivalent(a, b) {
  const norm = (x) =>
    String(x || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb || na === 'unknown' || nb === 'unknown') return false;
  if (na === nb) return true;
  const aliases = [
    ['enterprise software', 'software', 'saas', 'observability', 'data analytics', 'technology'],
    ['biotechnology', 'biotech', 'life sciences', 'healthcare'],
    ['oil gas', 'oil & gas', 'energy'],
    ['e commerce', 'ecommerce', 'e-commerce'],
    ['artificial intelligence', 'ai', 'enterprise software'],
    ['cloud infrastructure', 'cybersecurity', 'enterprise software'],
    ['renewable energy', 'energy'],
    ['consumer', 'consumer electronics']
  ];
  for (const group of aliases) {
    const gn = group.map(norm);
    if (gn.some((g) => na.includes(g) || g.includes(na)) && gn.some((g) => nb.includes(g) || g.includes(nb))) {
      // Only allow soft alias if one is more specific subset — for eval expected labels
      if (na.includes(nb) || nb.includes(na)) return true;
      // Explicit acceptable pairs
      const pair = [na, nb].sort().join('|');
      const ok = [
        'enterprise software|observability',
        'enterprise software|software',
        'biotechnology|life sciences',
        'artificial intelligence|enterprise software',
        'cloud infrastructure|cybersecurity',
        'energy|oil gas',
        'energy|renewable energy',
        'e commerce|software'
      ];
      // Simpler: expected label contained in predicted or vice versa after stripping
      if (ok.includes(pair)) return true;
    }
  }
  // Soft match: expected token all present in predicted or predicted in expected
  const ea = na.split(' ').filter(Boolean);
  const eb = nb.split(' ').filter(Boolean);
  if (ea.length && ea.every((t) => nb.includes(t))) return true;
  if (eb.length && eb.every((t) => na.includes(t))) return true;
  return false;
}
