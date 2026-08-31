import { TOP100_MANAGERS, TOP100_META } from './top100.js';

const DEFAULT_SEC_USER_AGENT = 'InoMoney/1.0';
const CACHE_TTL_SECONDS = 3600;
const NAME_STOP_WORDS = new Set(['the', 'and', 'inc', 'incorporated', 'llc', 'lp', 'l', 'p', 'company', 'co', 'group', 'management', 'investment', 'investments', 'asset', 'advisors', 'advisor', 'corp', 'corporation', 'limited', 'ltd']);

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

    if (url.pathname === '/manager-holdings') {
      return handleManagerHoldings(url, env, ctx);
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
    filerName: submissions.name || institution.name,
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

async function handleManagerHoldings(url, env, ctx) {
  const rank = Number(url.searchParams.get('rank'));
  if (!Number.isInteger(rank) || rank < 1 || rank > TOP100_MANAGERS.length) {
    return jsonResponse({ error: 'rank must be an integer from 1 to 100' }, 400);
  }

  const cacheKey = new Request(url.origin + `/manager-holdings?rank=${rank}&v=top100-v3`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return withCors(cached);

  const manager = TOP100_MANAGERS[rank - 1];
  try {
    const secUserAgent = env.SEC_USER_AGENT || DEFAULT_SEC_USER_AGENT;
    const candidates = await findSecCandidates(manager, secUserAgent);
    let lastError = null;

    for (const cik of candidates.slice(0, 3)) {
      try {
        const institution = await loadInstitution({
          id: `top100-${manager.rank}`,
          name: manager.nameEn,
          mgr: manager.nameZh,
          style: 'Asset Manager',
          cik,
        }, secUserAgent);
        const response = jsonResponse({
          source: 'SEC EDGAR',
          discovery: 'SEC EDGAR search index',
          manager,
          cik,
          filerName: institution.filerName,
          filingDate: institution.filingDate,
          reportDate: institution.reportDate,
          accession: institution.accession,
          holdings: institution.holdings,
        }, 200, { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` });
        ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
        return response;
      } catch (error) {
        lastError = error;
      }
    }

    const detail = lastError ? ` ${lastError.message}` : '';
    return jsonResponse({
      error: `未找到 ${manager.nameEn} 可核验的 SEC 13F 持仓申报。${detail}`,
      manager,
    }, 404);
  } catch (error) {
    return jsonResponse({ error: error.message, manager }, 502);
  }
}

async function findSecCandidates(manager, secUserAgent) {
  if (manager.secCik) return [manager.secCik];

  const queries = [manager.nameEn];
  const firstName = normalizeName(manager.nameEn).split(' ').find((token) => token.length > 3 && !NAME_STOP_WORDS.has(token));
  if (firstName && firstName !== normalizeName(manager.nameEn)) queries.push(firstName);

  const candidates = new Map();
  for (const query of queries) {
    const search = await secJson(
      `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=13F-HR&from=0&size=100`,
      secUserAgent
    );
    const hits = search.hits && search.hits.hits;
    if (!Array.isArray(hits)) continue;

    for (const hit of hits) {
      const source = hit._source || {};
      const displayName = Array.isArray(source.display_names) ? source.display_names.join(' ') : '';
      const score = nameMatchScore(manager.nameEn, displayName);
      if (score < 0.6 || !Array.isArray(source.ciks)) continue;
      for (const cik of source.ciks) {
        const normalizedCik = String(cik).padStart(10, '0');
        const current = candidates.get(normalizedCik);
        const period = source.period_ending || '';
        if (!current || score > current.score || (score === current.score && period > current.period)) {
          candidates.set(normalizedCik, { score, period });
        }
      }
    }
  }

  return Array.from(candidates.entries())
    .sort((a, b) => b[1].score - a[1].score || b[1].period.localeCompare(a[1].period))
    .map(([cik]) => cik);
}

function normalizeName(value) {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function nameMatchScore(target, candidate) {
  const targetTokens = normalizeName(target).split(' ').filter((token) => token.length > 2 && !NAME_STOP_WORDS.has(token));
  const candidateTokens = new Set(normalizeName(candidate).split(' '));
  if (!targetTokens.length) return 0;
  const matches = targetTokens.filter((token) => candidateTokens.has(token)).length;
  return matches / targetTokens.length;
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
