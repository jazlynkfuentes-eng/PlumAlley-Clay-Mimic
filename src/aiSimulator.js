// Custom AI Simulator simulating "Base44 backend AI functions"
// Exposes mock latency and smart company dictionary + generative heuristics.

const companyDictionary = {
  "google": {
    domain: "google.com",
    industry: "Technology / AI",
    headcount: "100,000+",
    location: "Mountain View, CA",
    notes: "Official search engine, cloud provider, and AI researcher."
  },
  "apple": {
    domain: "apple.com",
    industry: "Consumer Electronics",
    headcount: "100,000+",
    location: "Cupertino, CA",
    notes: "Designer and manufacturer of consumer hardware and software."
  },
  "microsoft": {
    domain: "microsoft.com",
    industry: "Software & Cloud",
    headcount: "100,000+",
    location: "Redmond, WA",
    notes: "Global provider of operating systems, productivity software, and cloud."
  },
  "notion": {
    domain: "notion.so",
    industry: "Software / Productivity",
    headcount: "500 - 1,000",
    location: "San Francisco, CA",
    notes: "Serene workspace and documentation utility."
  },
  "stripe": {
    domain: "stripe.com",
    industry: "Financial Technology",
    headcount: "5,000 - 10,000",
    location: "San Francisco, CA",
    notes: "Global payments provider and financial infrastructure developer."
  },
  "openai": {
    domain: "openai.com",
    industry: "Artificial Intelligence",
    headcount: "500 - 1,000",
    location: "San Francisco, CA",
    notes: "Developer of advanced language models and generative AI systems."
  },
  "linkedin": {
    domain: "linkedin.com",
    industry: "Professional Networks",
    headcount: "10,000+",
    location: "Sunnyvale, CA",
    notes: "World's largest professional networking platform."
  },
  "cornell": {
    domain: "cornell.edu",
    industry: "Higher Education",
    headcount: "10,000+",
    location: "Ithaca, NY",
    notes: "Ivy League research university and educational center."
  },
  "cornell university": {
    domain: "cornell.edu",
    industry: "Higher Education",
    headcount: "10,000+",
    location: "Ithaca, NY",
    notes: "Ivy League research university and educational center."
  },
  "impactus partners": {
    domain: "impactus-partners.com",
    industry: "Investment Banking",
    headcount: "11 - 50",
    location: "Paris, France",
    notes: "Boutique advisory firm specializing in sustainable finance."
  },
  "gilder partners": {
    domain: "gilderpartners.com",
    industry: "Venture Capital",
    headcount: "11 - 50",
    location: "New York, NY",
    notes: "Growth equity investment partners for middle-market firms."
  },
  "gilder partners for growth": {
    domain: "gilderpartners.com",
    industry: "Venture Capital",
    headcount: "11 - 50",
    location: "New York, NY",
    notes: "Growth equity investment partners for middle-market firms."
  },
  "plum alley": {
    domain: "plumalley.co",
    industry: "Venture Capital",
    headcount: "11 - 50",
    location: "New York, NY",
    notes: "Private investment firm and gender-diverse venture investor."
  },
  "plum alley ventures": {
    domain: "plumalley.co",
    industry: "Venture Capital",
    headcount: "11 - 50",
    location: "New York, NY",
    notes: "Private investment firm and gender-diverse venture investor."
  },
  "clay": {
    domain: "clay.com",
    industry: "SaaS / Lead Gen",
    headcount: "100 - 250",
    location: "New York, NY",
    notes: "Data enrichment and outbound orchestration software."
  },
  "amazon": {
    domain: "amazon.com",
    industry: "E-Commerce / Cloud",
    headcount: "1,000,000+",
    location: "Seattle, WA",
    notes: "Global online retail platform and cloud infrastructure provider."
  },
  "meta": {
    domain: "meta.com",
    industry: "Social Media / VR",
    headcount: "50,000+",
    location: "Menlo Park, CA",
    notes: "Developer of social networking apps and metaverse technologies."
  },
  "netflix": {
    domain: "netflix.com",
    industry: "Entertainment",
    headcount: "10,000+",
    location: "Los Gatos, CA",
    notes: "Global media-streaming and video production company."
  },
  "tesla": {
    domain: "tesla.com",
    industry: "Automotive / Energy",
    headcount: "100,000+",
    location: "Austin, TX",
    notes: "Manufacturer of electric vehicles and clean energy products."
  }
};

// Clean name helper
function cleanName(name) {
  return name.trim().toLowerCase().replace(/[,.]\s*(inc|llc|co|corp|ltd|gmbh)\b/gi, "").trim();
}

// Helper to simulate delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Simulates Base44 backend AI web search & domain resolution
 * Prompt: "Find the official website domain for the company named [X]. Return only the domain."
 * @param {string} companyName - Raw input name
 * @returns {Promise<string|null>} Domain URL or null if unverified
 */
export async function resolveDomain(companyName) {
  // Simulate network latency (800ms - 1500ms)
  const latency = Math.floor(Math.random() * 700) + 800;
  await delay(latency);

  if (!companyName || companyName.trim().length < 2) {
    return null; // Empty or too short
  }

  const cleaned = cleanName(companyName);
  
  // 1. Direct dictionary match
  if (companyDictionary[cleaned]) {
    return companyDictionary[cleaned].domain;
  }

  // Partial match in dictionary
  for (const key in companyDictionary) {
    if (cleaned.includes(key) || key.includes(cleaned)) {
      return companyDictionary[key].domain;
    }
  }

  // 2. Unverified filters: If it is random gibberish or names like "asdf", "test"
  if (["test", "asdf", "company", "xyz", "hello", "unknown"].includes(cleaned)) {
    return null;
  }

  // 3. Algorithmic fallback
  const domainSafeName = cleaned
    .replace(/[^a-z0-9\s-]/g, "") // remove punctuation
    .replace(/\s+/g, "") // collapse spaces
    .substring(0, 20); // truncate

  if (!domainSafeName) return null;

  // Add random extensions to represent AI resolution
  const suffixes = [".com", ".co", ".io", ".net", ".ai"];
  
  // Decide extension based on keywords
  let ext = ".com";
  if (cleaned.includes("tech") || cleaned.includes("software") || cleaned.includes("app")) {
    ext = ".io";
  } else if (cleaned.includes("ai") || cleaned.includes("labs") || cleaned.includes("intelligence")) {
    ext = ".ai";
  } else {
    // stable pseudorandom suffix selection
    const code = domainSafeName.charCodeAt(0) || 0;
    ext = suffixes[code % suffixes.length];
  }

  return `${domainSafeName}${ext}`;
}

/**
 * Simulates second AI call to enrich company details once domain is known
 * @param {string} domain - Resolved domain
 * @param {string} originalName - Original company input name
 * @returns {Promise<object>} Enriched data points
 */
export async function enrichCompanyDetails(domain, originalName) {
  const latency = Math.floor(Math.random() * 500) + 500; // 500ms - 1000ms
  await delay(latency);

  const cleaned = cleanName(originalName);

  // 1. Check dictionary first
  if (companyDictionary[cleaned]) {
    const entry = companyDictionary[cleaned];
    return {
      industry: entry.industry,
      headcount: entry.headcount,
      location: entry.location,
      notes: entry.notes
    };
  }

  // Partial match in dictionary
  for (const key in companyDictionary) {
    if (cleaned.includes(key) || key.includes(cleaned)) {
      const entry = companyDictionary[key];
      return {
        industry: entry.industry,
        headcount: entry.headcount,
        location: entry.location,
        notes: entry.notes
      };
    }
  }

  // 2. Generate details heuristically based on keywords
  let industry = "SaaS / Software";
  let headcount = "11 - 50";
  let location = "San Francisco, CA";
  let notes = "Website verified. Core business data resolved.";

  const textToScan = `${cleaned} ${domain}`;

  // Heuristic matching
  if (textToScan.includes("capital") || textToScan.includes("venture") || textToScan.includes("vc") || textToScan.includes("partners") || textToScan.includes("fund")) {
    industry = "Venture Capital";
    headcount = "1 - 10";
    location = "New York, NY";
    notes = "Investment firm specializing in seed & early-stage financing.";
  } else if (textToScan.includes("coffee") || textToScan.includes("cafe") || textToScan.includes("restaurant") || textToScan.includes("bakery") || textToScan.includes("bites")) {
    industry = "Food & Beverages";
    headcount = "11 - 50";
    location = "Austin, TX";
    notes = "Local gourmet food and beverage hospitality service.";
  } else if (textToScan.includes("university") || textToScan.includes("college") || textToScan.includes("school") || textToScan.includes("academy") || textToScan.includes("edu")) {
    industry = "Education";
    headcount = "1,000 - 5,000";
    location = "Boston, MA";
    notes = "Academic institution offering courses and research facilities.";
  } else if (textToScan.includes("law") || textToScan.includes("legal") || textToScan.includes("attorney") || textToScan.includes("chambers")) {
    industry = "Legal Services";
    headcount = "11 - 50";
    location = "Chicago, IL";
    notes = "Professional legal consulting and representation services.";
  } else if (textToScan.includes("agency") || textToScan.includes("design") || textToScan.includes("studio") || textToScan.includes("creative")) {
    industry = "Marketing & Creative";
    headcount = "11 - 50";
    location = "Los Angeles, CA";
    notes = "Specializes in digital brand campaigns and product styling.";
  } else if (textToScan.includes("consulting") || textToScan.includes("advisors") || textToScan.includes("group")) {
    industry = "Management Consulting";
    headcount = "51 - 200";
    location = "London, UK";
    notes = "Strategic business solutions and operations advising.";
  } else if (textToScan.includes("health") || textToScan.includes("bio") || textToScan.includes("pharma") || textToScan.includes("clinic") || textToScan.includes("medical")) {
    industry = "Healthcare / Biotech";
    headcount = "251 - 500";
    location = "San Diego, CA";
    notes = "Innovating solutions in clinical health and therapeutics.";
  } else if (textToScan.includes("shop") || textToScan.includes("store") || textToScan.includes("boutique") || textToScan.includes("apparel")) {
    industry = "E-Commerce / Retail";
    headcount = "1 - 10";
    location = "Miami, FL";
    notes = "Direct-to-consumer lifestyle merchandise store.";
  } else if (textToScan.includes("ai") || textToScan.includes("labs") || textToScan.includes("intelligence") || textToScan.includes("tech")) {
    industry = "Technology / AI";
    headcount = "11 - 50";
    location = "Seattle, WA";
    notes = "Tech studio developing core software tools and AI models.";
  } else {
    // Generic fallback based on pseudorandom seeding from name
    const num = originalName.length;
    const industries = ["Software", "Real Estate", "Financial Services", "Energy & Utility", "Manufacturing"];
    const locations = ["Dallas, TX", "Denver, CO", "Atlanta, GA", "Toronto, ON", "Seattle, WA"];
    const headcounts = ["1 - 10", "11 - 50", "51 - 200", "201 - 500", "5,000+"];
    
    industry = industries[num % industries.length];
    location = locations[num % locations.length];
    headcount = headcounts[num % headcounts.length];
  }

  return {
    industry,
    headcount,
    location,
    notes
  };
}
