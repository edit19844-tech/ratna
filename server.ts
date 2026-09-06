import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { generateCustomChartHtml } from './src/utils/chartGenerator';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// File-based persistence for admin data so changes survive dev server restarts & sync across all users
const DATA_DIR = path.join(process.cwd(), 'data');
const ADMIN_STORE_FILE = path.join(DATA_DIR, 'admin_store.json');

interface StoredAdminData {
  customMarkets: Array<{
    id: string;
    name: string;
    result: string;
    timing: string;
    nameColor?: string;
    isHighlighted?: boolean;
    isCustom?: boolean;
  }>;
  highlightOverrides: Record<string, boolean>;
  marketOverrides: Record<string, { result?: string; timing?: string; nameColor?: string; isHighlighted?: boolean }>;
  deletedMarkets?: string[];
  adminSettings?: any;
  topGuessers?: string[];
  fastResults?: string[];
}

let storedAdminData: StoredAdminData = {
  customMarkets: [],
  highlightOverrides: {},
  marketOverrides: {},
  deletedMarkets: [],
};

// Initialize persistent storage
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(ADMIN_STORE_FILE)) {
    const raw = fs.readFileSync(ADMIN_STORE_FILE, 'utf-8');
    storedAdminData = JSON.parse(raw);
    console.log(`[Storage] Loaded admin store: ${storedAdminData.customMarkets?.length || 0} custom markets, ${Object.keys(storedAdminData.highlightOverrides || {}).length} highlight overrides.`);
  } else {
    fs.writeFileSync(ADMIN_STORE_FILE, JSON.stringify(storedAdminData, null, 2), 'utf-8');
  }
} catch (e) {
  console.warn('[Storage] Error initializing admin store file:', e);
}

function saveAdminStoreToFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(ADMIN_STORE_FILE, JSON.stringify(storedAdminData, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[Storage] Error saving admin store file:', e);
  }
}

// In-memory cache for live scraped data
let cachedData: any = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 15000; // 15 seconds cache

/**
 * Scraper function for https://sattamatkajodi.net/
 */
async function fetchSattaMatkaJodiData() {
  const now = Date.now();
  if (cachedData && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedData;
  }

  try {
    const response = await fetch('https://sattamatkajodi.net/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();

    // 1. Extract Live Updates (Ticker)
    const liveUpdates: Array<{ name: string; result: string }> = [];
    const liveSecIdx = html.indexOf('LIVE UPDATE');
    if (liveSecIdx !== -1) {
      const liveSub = html.substring(liveSecIdx, liveSecIdx + 2500);
      const itemRegex =
        /<span style="color:red[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span style="color:blue[^>]*>([\s\S]*?)<\/span>/gi;
      let m;
      while ((m = itemRegex.exec(liveSub)) !== null) {
        const name = m[1].replace(/<[^>]*>/g, '').trim();
        const result = m[2].replace(/<[^>]*>/g, '').trim();
        if (name && result) {
          liveUpdates.push({ name, result });
        }
      }
    }

    // 2. Extract Markets List
    const markets: Array<{
      id: string;
      name: string;
      result: string;
      timing: string;
      nameColor: string;
      isHighlighted?: boolean;
      jodiChartUrl?: string;
      panelChartUrl?: string;
    }> = [];
    const fixRegex =
      /<div class="(fix|news2)"[^>]*>[\s\S]*?<span style="color:([^";]*)[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span style="color:[^>]*>([\s\S]*?)<\/span>/gi;
    let fm;
    let index = 0;
    while ((fm = fixRegex.exec(html)) !== null) {
      const cls = fm[1];
      const colorRaw = fm[2]?.toLowerCase() || '';
      const name = fm[3].replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '').trim();
      const rawResult = fm[4].replace(/<[^>]*>/g, '').trim();
      const timing = '';

      // Extract Jodi and Panel chart URLs from bounded card sub-string
      const sub = html.substring(fm.index, fm.index + 1200);
      const jodiMatch = sub.match(/class="jodichartleft"><a href="([^"]*)"/i) || sub.match(/href="([^"]*)"[^>]*>Jodi/i);
      const panelMatch = sub.match(/class="panelchartright"><a href="([^"]*)"/i) || sub.match(/href="([^"]*)"[^>]*>Panel/i);
      
      const jodiChartUrl = jodiMatch ? (jodiMatch[1].startsWith('http') ? jodiMatch[1] : `https://sattamatkajodi.net${jodiMatch[1].startsWith('/') ? '' : '/'}${jodiMatch[1]}`) : undefined;
      const panelChartUrl = panelMatch ? (panelMatch[1].startsWith('http') ? panelMatch[1] : `https://sattamatkajodi.net${panelMatch[1].startsWith('/') ? '' : '/'}${panelMatch[1]}`) : undefined;

      if (name) {
        // Strip out marketing/advertising suffixes (e.g. Hindi booking promo text)
        const result = rawResult.split(/[卐☛☞\n\r]/)[0].trim() || rawResult;

        let nameColor = 'text-[#1d4ed8]'; // default blue
        if (colorRaw.includes('red') || colorRaw.includes('brown')) nameColor = 'text-[#b91c1c]';
        else if (colorRaw.includes('green')) nameColor = 'text-[#15803d]';
        else if (colorRaw.includes('purple')) nameColor = 'text-[#6b21a8]';

        // news2 class on the source represents the prominent highlighted yellow row
        const isHighlighted = cls === 'news2' || name.toUpperCase().includes('KALYAN MORNING');

        markets.push({
          id: 'live_' + index++,
          name,
          result: result || 'Loading...',
          timing: timing || '(12:00 - 02:00)',
          nameColor,
          isHighlighted,
          jodiChartUrl,
          panelChartUrl,
        });
      }
    }

    // 3. Extract Lucky Numbers
    let todayAnk = '2-3-4-9';
    let todayFinalAnk = 'K-7, M-2';
    const luckyIdx = html.indexOf('Today Satta Matka Lucky Number');
    if (luckyIdx !== -1) {
      const luckySub = html.substring(luckyIdx, luckyIdx + 1000);
      const rows = luckySub.match(/<tr>[\s\S]*?<\/tr>/gi);
      if (rows && rows.length >= 2) {
        const tds = rows[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        if (tds && tds.length >= 2) {
          todayAnk = tds[0].replace(/<[^>]*>/g, '').trim() || todayAnk;
          todayFinalAnk = tds[1].replace(/<[^>]*>/g, '').trim() || todayFinalAnk;
        }
      }
    }

    cachedData = {
      success: true,
      source: 'ratan-live-engine',
      timestamp: new Date().toISOString(),
      liveUpdates,
      markets,
      luckyNumbers: {
        todayAnk,
        todayFinalAnk,
      },
    };
    lastFetchTime = now;
    return cachedData;
  } catch (error: any) {
    console.error('Error fetching live data from sattamatkajodi.net:', error.message);
    if (cachedData) {
      return cachedData;
    }
    return {
      success: false,
      error: error.message,
      liveUpdates: [],
      markets: [],
      luckyNumbers: {
        todayAnk: '2-3-4-9',
        todayFinalAnk: 'K-7, M-2',
      },
    };
  }
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Real-time synchronization endpoint with sattamatkajodi.net
app.get('/api/satta-live-sync', async (req, res) => {
  try {
    const rawData = await fetchSattaMatkaJodiData();

    // Merge with admin stored custom markets and overrides
    const customMarkets = storedAdminData.customMarkets || [];
    const highlightOverrides = storedAdminData.highlightOverrides || {};
    const marketOverrides = storedAdminData.marketOverrides || {};
    const deletedSet = new Set(
      (storedAdminData.deletedMarkets || []).map((d: string) => d.toUpperCase().trim())
    );

    // 1. Process scraped markets with admin overrides and filter out deleted markets
    const processedScrapedMarkets = (rawData.markets || [])
      .filter((m: any) => {
        const key = m.name.toUpperCase().trim();
        return !deletedSet.has(key) && !deletedSet.has(String(m.id).toUpperCase().trim());
      })
      .map((m: any) => {
        const key = m.name.toUpperCase().trim();
        const override = marketOverrides[key] || {};
        const hasHighlightOverride = Object.prototype.hasOwnProperty.call(highlightOverrides, key);

        const isHighlighted = hasHighlightOverride
          ? highlightOverrides[key]
          : override.isHighlighted !== undefined
          ? override.isHighlighted
          : m.isHighlighted;

        return {
          ...m,
          result: override.result || m.result,
          timing: override.timing || m.timing,
          nameColor: override.nameColor || m.nameColor,
          isHighlighted: Boolean(isHighlighted),
        };
      });

    // 2. Process custom markets added by admin and filter out deleted markets
    const customList = customMarkets
      .filter((cm: any) => {
        const key = cm.name.toUpperCase().trim();
        return !deletedSet.has(key) && !deletedSet.has(String(cm.id).toUpperCase().trim());
      })
      .map((cm: any) => {
        const key = cm.name.toUpperCase().trim();
        const hasHighlightOverride = Object.prototype.hasOwnProperty.call(highlightOverrides, key);
        return {
          ...cm,
          isHighlighted: hasHighlightOverride ? highlightOverrides[key] : Boolean(cm.isHighlighted),
          isCustom: true,
        };
      });

    // Custom markets appear at top of list so visitors & admin see added markets immediately
    const existingCustomNames = new Set(customList.map((c: any) => c.name.toUpperCase().trim()));
    const nonDuplicateScraped = processedScrapedMarkets.filter(
      (m: any) => !existingCustomNames.has(m.name.toUpperCase().trim())
    );

    const finalMarkets = [...customList, ...nonDuplicateScraped];

    const finalData = {
      ...rawData,
      markets: finalMarkets,
      deletedMarkets: storedAdminData.deletedMarkets || [],
      adminSettings: storedAdminData.adminSettings || null,
      topGuessers: storedAdminData.topGuessers || null,
      fastResults: storedAdminData.fastResults || null,
    };

    res.json(finalData);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save admin markets (custom markets, highlights, and individual overrides)
app.post('/api/admin/markets', (req, res) => {
  try {
    const { markets, customMarkets, highlightOverrides, deletedMarkets } = req.body;

    if (Array.isArray(markets)) {
      // Clear active markets from deletedMarkets
      const activeNames = new Set(markets.map((m: any) => m.name.toUpperCase().trim()));
      if (storedAdminData.deletedMarkets) {
        storedAdminData.deletedMarkets = storedAdminData.deletedMarkets.filter(
          (d) => !activeNames.has(d.toUpperCase().trim())
        );
      }

      // Extract custom markets (those with isCustom or id starting with 'm_' or not from live feed)
      const customs = markets.filter(
        (m: any) => m.isCustom || String(m.id).startsWith('m_') || String(m.id).startsWith('custom_')
      );
      storedAdminData.customMarkets = customs;

      // Extract highlight and field overrides for ALL markets
      const overrides: Record<string, boolean> = {};
      const mOverrides: Record<string, any> = {};
      markets.forEach((m: any) => {
        const key = m.name.toUpperCase().trim();
        overrides[key] = Boolean(m.isHighlighted);
        mOverrides[key] = {
          result: m.result,
          timing: m.timing,
          nameColor: m.nameColor,
          isHighlighted: Boolean(m.isHighlighted),
        };
      });
      storedAdminData.highlightOverrides = overrides;
      storedAdminData.marketOverrides = mOverrides;
    } else {
      if (Array.isArray(customMarkets)) {
        storedAdminData.customMarkets = customMarkets;
      }
      if (highlightOverrides && typeof highlightOverrides === 'object') {
        storedAdminData.highlightOverrides = {
          ...storedAdminData.highlightOverrides,
          ...highlightOverrides,
        };
      }
    }

    if (Array.isArray(deletedMarkets)) {
      storedAdminData.deletedMarkets = Array.from(
        new Set([
          ...(storedAdminData.deletedMarkets || []),
          ...deletedMarkets.map((d: any) => String(d).toUpperCase().trim()),
        ])
      );
    }

    saveAdminStoreToFile();
    // Reset cache to immediately serve fresh data
    lastFetchTime = 0;
    chartCache.clear();

    res.json({
      success: true,
      customCount: storedAdminData.customMarkets.length,
      highlightCount: Object.keys(storedAdminData.highlightOverrides).length,
      deletedCount: storedAdminData.deletedMarkets?.length || 0,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save all admin data (settings, guessers, fast results, markets)
app.post('/api/admin/all-data', (req, res) => {
  try {
    const { adminSettings, topGuessers, fastResults, markets, deletedMarkets } = req.body;
    if (adminSettings) storedAdminData.adminSettings = adminSettings;
    if (Array.isArray(topGuessers)) storedAdminData.topGuessers = topGuessers;
    if (Array.isArray(fastResults)) storedAdminData.fastResults = fastResults;
    if (Array.isArray(deletedMarkets)) {
      storedAdminData.deletedMarkets = Array.from(
        new Set([
          ...(storedAdminData.deletedMarkets || []),
          ...deletedMarkets.map((d: any) => String(d).toUpperCase().trim()),
        ])
      );
    }
    if (Array.isArray(markets)) {
      const activeNames = new Set(markets.map((m: any) => m.name.toUpperCase().trim()));
      if (storedAdminData.deletedMarkets) {
        storedAdminData.deletedMarkets = storedAdminData.deletedMarkets.filter(
          (d) => !activeNames.has(d.toUpperCase().trim())
        );
      }
      const customs = markets.filter(
        (m: any) => m.isCustom || String(m.id).startsWith('m_') || String(m.id).startsWith('custom_')
      );
      storedAdminData.customMarkets = customs;
      const overrides: Record<string, boolean> = {};
      const mOverrides: Record<string, any> = {};
      markets.forEach((m: any) => {
        const key = m.name.toUpperCase().trim();
        overrides[key] = Boolean(m.isHighlighted);
        mOverrides[key] = {
          result: m.result,
          timing: m.timing,
          nameColor: m.nameColor,
          isHighlighted: Boolean(m.isHighlighted),
        };
      });
      storedAdminData.highlightOverrides = overrides;
      storedAdminData.marketOverrides = mOverrides;
    }

    saveAdminStoreToFile();
    lastFetchTime = 0;
    chartCache.clear();
    res.json({ success: true, message: 'All admin data updated and persisted to server' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Quick single-market result update endpoint for zero-latency manual entry
app.post('/api/admin/quick-market-update', (req, res) => {
  try {
    const { name, result, timing } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: 'Market name is required' });
    }

    const cleanName = String(name).toUpperCase().trim();
    if (!storedAdminData.marketOverrides) storedAdminData.marketOverrides = {};
    storedAdminData.marketOverrides[cleanName] = {
      ...storedAdminData.marketOverrides[cleanName],
      result: result !== undefined ? String(result).trim() : storedAdminData.marketOverrides[cleanName]?.result,
      timing: timing !== undefined ? String(timing).trim() : storedAdminData.marketOverrides[cleanName]?.timing,
    };

    // If it's also in customMarkets, update it there too
    if (Array.isArray(storedAdminData.customMarkets)) {
      storedAdminData.customMarkets = storedAdminData.customMarkets.map((cm) => {
        if (cm.name.toUpperCase().trim() === cleanName) {
          return {
            ...cm,
            result: result !== undefined ? String(result).trim() : cm.result,
            timing: timing !== undefined ? String(timing).trim() : cm.timing,
          };
        }
        return cm;
      });
    }

    saveAdminStoreToFile();
    // Zero-latency cache invalidation
    lastFetchTime = 0;
    chartCache.clear();

    res.json({ success: true, message: `Market ${cleanName} updated live instantly`, market: storedAdminData.marketOverrides[cleanName] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get admin stored data
app.get('/api/admin/store', (req, res) => {
  res.json({
    success: true,
    data: storedAdminData,
  });
});

// Real-time chart records endpoint (e.g. prabhat-panel-chart.php)
const chartCache = new Map<string, { data: any; timestamp: number }>();

app.get('/api/satta-chart', async (req, res) => {
  try {
    const rawMarket = String(req.query.market || 'prabhat').toLowerCase().trim();
    const type = String(req.query.type || 'panel').toLowerCase().trim(); // 'panel' or 'jodi'
    const queryChartUrl = req.query.chartUrl ? String(req.query.chartUrl).trim() : '';
    const fallbackResult = req.query.fallbackResult ? String(req.query.fallbackResult).trim() : '';
    const isCustomQuery = req.query.isCustom === 'true' || queryChartUrl === '#custom';

    const cacheKey = `${queryChartUrl || rawMarket}_${type}_${fallbackResult}`;

    const cached = chartCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < 30 * 1000) {
      return res.json(cached.data);
    }

    let targetUrl = queryChartUrl;
    let marketDisplayName = rawMarket.toUpperCase();

    // Check if deleted
    const deletedSet = new Set((storedAdminData.deletedMarkets || []).map((d: string) => d.toUpperCase().trim()));
    if (deletedSet.has(marketDisplayName.toUpperCase()) || deletedSet.has(rawMarket.toUpperCase())) {
      return res.status(404).json({ success: false, error: 'This market has been deleted' });
    }

    // Check if this is a custom market added by admin FIRST
    const customMatch = (storedAdminData.customMarkets || []).find(
      (cm: any) =>
        cm.name.toUpperCase().trim() === marketDisplayName.toUpperCase() ||
        cm.name.toUpperCase().trim() === rawMarket.toUpperCase()
    );

    const adminOverride =
      storedAdminData.marketOverrides?.[marketDisplayName.toUpperCase()]?.result ||
      storedAdminData.marketOverrides?.[rawMarket.toUpperCase()]?.result ||
      customMatch?.result;

    const liveResult = fallbackResult || adminOverride || customMatch?.result || '123-45-678';

    // If explicitly custom OR matches customMarkets OR queryChartUrl is #custom:
    // Generate custom chart with the user's EXACT manual number immediately!
    if (isCustomQuery || customMatch || queryChartUrl === '#custom') {
      const generatedTable = generateCustomChartHtml(marketDisplayName, type as 'jodi' | 'panel', liveResult);
      const resultPayload = {
        success: true,
        sourceUrl: '#custom',
        market: marketDisplayName,
        type,
        liveResult,
        tableHtml: generatedTable,
        timestamp: new Date().toISOString(),
      };
      chartCache.set(cacheKey, { data: resultPayload, timestamp: now });
      return res.json(resultPayload);
    }

    // Look up in cached markets if specific URL not provided
    const foundMarket = (cachedData?.markets || []).find((m: any) =>
      m.name.toLowerCase().trim() === rawMarket.toLowerCase().trim()
    );

    if (foundMarket) {
      marketDisplayName = foundMarket.name;
      if (!targetUrl) {
        targetUrl = type === 'jodi' ? (foundMarket.jodiChartUrl || '') : (foundMarket.panelChartUrl || '');
      }
    }

    // If market has no known official chart url, generate custom chart with EXACT manual number
    if (!targetUrl) {
      const generatedTable = generateCustomChartHtml(marketDisplayName, type as 'jodi' | 'panel', liveResult);
      const resultPayload = {
        success: true,
        sourceUrl: '#custom',
        market: marketDisplayName,
        type,
        liveResult,
        tableHtml: generatedTable,
        timestamp: new Date().toISOString(),
      };
      chartCache.set(cacheKey, { data: resultPayload, timestamp: now });
      return res.json(resultPayload);
    }

    // Default known mappings for standard markets if still not set
    if (!targetUrl) {
      if (rawMarket.includes('prabhat-night')) {
        marketDisplayName = 'PRABHAT NIGHT';
        targetUrl = type === 'jodi'
          ? 'https://sattamatkajodi.net/record/prabhat-night-chart.php'
          : 'https://sattamatkajodi.net/record/prabhat-night-panel-chart.php';
      } else if (rawMarket.includes('kalyan-morning')) {
        marketDisplayName = 'KALYAN MORNING';
        targetUrl = type === 'jodi'
          ? 'https://sattamatkajodi.net/record/kalyan-morning-chart.php'
          : 'https://sattamatkajodi.net/record/kalyan-morning-penal-chart.php';
      } else if (rawMarket.includes('kalyan')) {
        marketDisplayName = 'KALYAN';
        targetUrl = type === 'jodi'
          ? 'https://sattamatkajodi.net/record/kalyan-chart.php'
          : 'https://sattamatkajodi.net/record/kalyan-panel-chart.php';
      } else if (rawMarket.includes('morning-milan') || rawMarket.includes('milan-morning')) {
        marketDisplayName = 'MORNING MILAN';
        targetUrl = type === 'jodi'
          ? 'https://sattamatkajodi.net/record/morning-milan-chart.php'
          : 'https://sattamatkajodi.net/record/morning-milan-penal-chart.php';
      } else if (rawMarket.includes('raja-rani')) {
        marketDisplayName = 'RAJA RANI MORNING';
        targetUrl = type === 'jodi'
          ? 'https://sattamatkajodi.net/record/raja-rani-morning-chart.php'
          : 'https://sattamatkajodi.net/record/raja-rani-morning-panel-chart.php';
      } else {
        marketDisplayName = rawMarket.toUpperCase();
        targetUrl = '';
      }
    }

    let tableHtml = '';
    if (targetUrl) {
      try {
        const response = await fetch(targetUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml',
          },
        });

        if (response.ok) {
          const html = await response.text();
          const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
          tableHtml = tableMatch ? tableMatch[0] : '';
        }
      } catch (e) {
        console.warn('Scraping error for chart, falling back to generated chart:', e);
      }
    }

    if (!tableHtml) {
      tableHtml = generateCustomChartHtml(marketDisplayName, type as 'jodi' | 'panel', liveResult);
    }

    const resultPayload = {
      success: true,
      sourceUrl: targetUrl,
      market: marketDisplayName,
      type,
      liveResult,
      tableHtml,
      timestamp: new Date().toISOString(),
    };

    chartCache.set(cacheKey, { data: resultPayload, timestamp: now });
    res.json(resultPayload);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
