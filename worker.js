import { TOP100_MANAGERS, TOP100_META } from './top100.js';

const DEFAULT_SEC_USER_AGENT = 'InoMoney/1.0';
const CACHE_TTL_SECONDS = 3600;

const INSTITUTIONS = [
  {
    id: 'brk',
    name: 'Berkshire',
    mgr: 'Warren Buffett',
    style: 'Value',
    cik: '0001067983',
  },
  {
    id: 'ark',
    name: 'ARK Invest',
    mgr: 'Cathie Wood',
    style: 'Disruptive',
    cik: '0001697748',
  },
  {
    id: 'ps',
    name: 'Pershing Sq',
    mgr: 'Bill Ackman',
    style: 'Activist',
    cik: '0001336528',
  },
];

const CUSIP_TICKERS = {
  '037833100': 'AAPL',
  '060505104': 'BAC',
  '025816109': 'AXP',
  '191216100': 'KO',
  '166764100': 'CVX',
  '674599105': 'OXY',
  '88160R101': 'TSLA',
  '007903107': 'AMD',
  '19260Q107': 'COIN',
  '77543R102': 'ROKU',
  '82509L107': 'SHOP',
  '023135106': 'AMZN',
  '594918104': 'MSFT',
  '90353T100': 'UBER',
  '43300A203': 'HLT',
  '548661107': 'LOW',
  '855244109': 'SBUX',
  '169656105': 'CMG',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname !== '/holdings') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.origin + '/holdings?v=top100-v1');
    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCors(cached);
    }

    try {
      const secUserAgent = env.SEC_USER_AGENT || DEFAULT_SEC_USER_AGENT;
      const institutions = await Promise.all(
        INSTITUTIONS.map((institution) => loadInstitution(institution, secUserAgent))
      );
      const response = jsonResponse(
        {
          source: 'SEC EDGAR',
          generatedAt: new Date().toISOString(),
          institutions: institutions.filter(Boolean),
          top100: TOP100_MANAGERS,
          top100Meta: TOP100_META,
        },
        200,
        { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` }
      );

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return jsonResponse({ error: error.message }, 502);
    }
  },
};

async function loadInstitution(institution, secUserAgent) {
  const submissions = await secJson(
    `https://data.sec.gov/submissions/CIK${institution.cik}.json`,
    secUserAgent
  );
  const recent = submissions.filings && submissions.filings.recent;
  if (!recent) {
    throw new Error(`No recent filings for ${institution.name}`);
  }

  const filingIndex = recent.form.findIndex((form) => form === '13F-HR');
  if (filingIndex === -1) {
    throw new Error(`No 13F-HR filing for ${institution.name}`);
  }

  const accession = recent.accessionNumber[filingIndex];
  const accessionPath = accession.replace(/-/g, '');
  const cikPath = String(Number(institution.cik));
  const archiveBase = `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accessionPath}`;
  const archive = await secJson(`${archiveBase}/index.json`, secUserAgent);
  const xmlName = findInfoTableXml(archive);
  const xml = await secText(`${archiveBase}/${xmlName}`, secUserAgent);
  const holdings = aggregateHoldings(parseInfoTable(xml));
  const totalValue = holdings.reduce((sum, holding) => sum + holding.value, 0);

  return {
    ...institution,
    filingDate: recent.filingDate[filingIndex],
    reportDate: recent.reportDate[filingIndex],
    accession,
    holdings: holdings
      .sort((a, b) => b.value - a.value)
      .slice(0, 12)
      .map((holding) => ({
        t: CUSIP_TICKERS[holding.cusip] || holding.cusip,
        n: holding.name,
        v: formatUsdThousands(holding.value),
        p: totalValue ? `${((holding.value / totalValue) * 100).toFixed(1)}%` : '0%',
      })),
  };
}

function findInfoTableXml(archive) {
  const items = archive.directory && archive.directory.item;
  if (!Array.isArray(items)) {
    throw new Error('Invalid SEC archive index');
  }

  const infoTable = items.find((item) => {
    const name = item.name.toLowerCase();
    return name.endsWith('.xml') && name.includes('info');
  });
  if (infoTable) return infoTable.name;

  const nonPrimaryXml = items.find((item) => {
    const name = item.name.toLowerCase();
    return name.endsWith('.xml') && !name.includes('primary');
  });
  if (nonPrimaryXml) return nonPrimaryXml.name;

  throw new Error('No 13F information table XML found');
}

function parseInfoTable(xml) {
  const blocks = xml.match(/<[^:>]*:?infoTable\b[\s\S]*?<\/[^:>]*:?infoTable>/gi) || [];
  return blocks.map((block) => ({
    name: readXml(block, 'nameOfIssuer'),
    cusip: readXml(block, 'cusip').toUpperCase(),
    value: Number(readXml(block, 'value')) || 0,
    shares: Number(readXml(block, 'sshPrnamt')) || 0,
  })).filter((holding) => holding.name && holding.cusip && holding.value > 0);
}

function aggregateHoldings(holdings) {
  const merged = new Map();
  for (const holding of holdings) {
    const key = holding.cusip || holding.name;
    const current = merged.get(key) || { ...holding, value: 0, shares: 0 };
    current.value += holding.value;
    current.shares += holding.shares;
    merged.set(key, current);
  }
  return Array.from(merged.values());
}

function readXml(block, tag) {
  const match = block.match(new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, 'i'));
  return match ? decodeXml(match[1].trim()) : '';
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function secJson(url, secUserAgent) {
  const response = await fetch(url, { headers: secHeaders(secUserAgent) });
  if (!response.ok) {
    throw new Error(`SEC request failed ${response.status}: ${url}`);
  }
  return response.json();
}

async function secText(url, secUserAgent) {
  const response = await fetch(url, { headers: secHeaders(secUserAgent) });
  if (!response.ok) {
    throw new Error(`SEC request failed ${response.status}: ${url}`);
  }
  return response.text();
}

function secHeaders(secUserAgent) {
  return {
    'User-Agent': secUserAgent,
    'Accept': 'application/json, text/xml, application/xml;q=0.9, */*;q=0.8',
  };
}

function formatUsdThousands(value) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(value).toLocaleString()}`;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
