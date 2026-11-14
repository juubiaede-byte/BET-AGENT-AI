const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;

// =====================================
// CONFIGURATION
// =====================================

const MAX_HOUR = 60;
const MAX_DAY = 180;
const MAX_ANALYSIS_AGE = 24 * 60 * 60 * 1000;
const CACHE_FIXTURES_MS = 5 * 60 * 1000;
const CACHE_CATALOG_MS = 12 * 60 * 60 * 1000;

const RESEARCH_CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_RESEARCH_PER_DAY = 10;
const MAX_SEARCHES_PER_MATCH = 6;
const MAX_RESULTS_PER_SEARCH = 8;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FOOTBALL_CHARTS_KEY = process.env.FOOTBALL_CHARTS_KEY;
const THESPORTSDB_KEY = process.env.THESPORTSDB_KEY || "123";

// =====================================
// OUTILS GENERAUX
// =====================================

function httpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateTeamName(value, fieldName) {
  const name = String(value || "").trim();

  if (!name || name.length > 100) {
    throw httpError(`${fieldName} doit contenir entre 1 et 100 caractères.`, 400);
  }

  return name;
}

// =====================================
// SUPABASE
// =====================================

function dbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

function checkDatabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Configuration Supabase manquante.");
  }
}

async function dbRequest(path, options = {}) {
  checkDatabaseConfig();

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: dbHeaders(options.headers || {})
  });

  if (!response.ok) {
    console.error("Supabase error:", await response.text());
    throw new Error("Erreur de base de données.");
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// =====================================
// NETTOYAGE
// =====================================

async function cleanupExpired() {
  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - MAX_ANALYSIS_AGE).toISOString();

  await Promise.all([
    dbRequest(`match_analyses?expires_at=lt.${encodeURIComponent(now)}`, {
      method: "DELETE"
    }),
    dbRequest(`api_cache?expires_at=lt.${encodeURIComponent(now)}`, {
      method: "DELETE"
    }),
    dbRequest(`api_requests?requested_at=lt.${encodeURIComponent(dayAgo)}`, {
      method: "DELETE"
    })
  ]);
}

let cleanupRunning = false;

async function scheduledCleanup() {
  if (cleanupRunning) return;

  cleanupRunning = true;

  try {
    await cleanupExpired();
  } catch (error) {
    console.error("Nettoyage:", error.message);
  } finally {
    cleanupRunning = false;
  }
}

setInterval(scheduledCleanup, 10 * 60 * 1000);

// =====================================
// QUOTAS PERSISTANTS
// =====================================

async function reserveRequest(provider) {
  const result = await dbRequest("rpc/reserve_api_request", {
    method: "POST",
    body: JSON.stringify({
      p_provider: provider,
      p_max_hour: MAX_HOUR,
      p_max_day: MAX_DAY
    })
  });

  const row = Array.isArray(result) ? result[0] : result;

  if (!row || !row.allowed) {
    throw httpError("Quota API atteint.", 429);
  }

  return {
    hourlyUsed: Number(row.hourly_used),
    dailyUsed: Number(row.daily_used)
  };
}

async function getUsage() {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const rows = await dbRequest(
    `api_requests?select=requested_at&requested_at=gt.${encodeURIComponent(dayAgo)}`
  );

  const hourly = rows.filter(item => item.requested_at > hourAgo).length;
  const daily = rows.length;

  return {
    hourly: {
      used: hourly,
      remaining: Math.max(0, MAX_HOUR - hourly),
      limit: MAX_HOUR
    },
    daily: {
      used: daily,
      remaining: Math.max(0, MAX_DAY - daily),
      limit: MAX_DAY
    }
  };
}

// =====================================
// CACHE PERSISTANT
// =====================================

async function getCache(key) {
  const encoded = encodeURIComponent(key);
  const rows = await dbRequest(
    `api_cache?cache_key=eq.${encoded}&select=data,expires_at&limit=1`
  );

  if (!rows.length) return null;

  const item = rows[0];

  if (new Date(item.expires_at).getTime() <= Date.now()) {
    await dbRequest(`api_cache?cache_key=eq.${encoded}`, {
      method: "DELETE"
    });
    return null;
  }

  return item.data;
}

async function setCache(key, provider, data, duration) {
  const expires = new Date(Date.now() + duration).toISOString();

  await dbRequest("api_cache?on_conflict=cache_key", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      cache_key: key,
      provider,
      data,
      created_at: new Date().toISOString(),
      expires_at: expires
    })
  });
}

// =====================================
// APPELS API CENTRALISES
// =====================================

async function trackedFetch(url, provider, options = {}, cacheDuration = CACHE_FIXTURES_MS) {
  const cached = await getCache(url);

  if (cached !== null) {
    return { data: cached, fromCache: true };
  }

  await reserveRequest(provider);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response;

  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw httpError(`Erreur ${provider}: HTTP ${response.status}`, response.status);
  }

  const data = await response.json();
  await setCache(url, provider, data, cacheDuration);

  return { data, fromCache: false };
}

// =====================================
// FOOTBALL-DATA.ORG
// =====================================

async function footballDataFetch(endpoint, cacheDuration = CACHE_FIXTURES_MS) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw httpError("Jeton FOOTBALL_DATA_TOKEN manquant dans Render.", 503);
  }

  return trackedFetch(
    `https://api.football-data.org/v4/${endpoint}`,
    "FOOTBALL_DATA",
    {
      headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN }
    },
    cacheDuration
  );
}

app.get("/api/providers/football-data/test", async (req, res) => {
  try {
    const result = await footballDataFetch("competitions/", CACHE_CATALOG_MS);

    const competitions = safeArray(result.data.competitions).map(c => ({
      id: c.id,
      name: c.name,
      country: c.area?.name,
      countryCode: c.area?.code,
      code: c.code,
      type: c.type,
      emblem: c.emblem
    }));

    res.json({
      provider: "Football-Data.org",
      status: "connected",
      competitionsAvailable: competitions.length,
      competitions,
      cache: result.fromCache,
      quotas: await getUsage()
    });
  } catch (error) {
    res.status(error.status || 500).json({
      provider: "Football-Data.org",
      status: "error",
      message: error.message,
      quotas: await getUsage().catch(() => null)
    });
  }
});

// =====================================
// FOOTBALL CHARTS
// =====================================

async function footballChartsFetch(endpoint) {
  if (!FOOTBALL_CHARTS_KEY) {
    throw httpError("Clé FOOTBALL_CHARTS_KEY manquante dans Render.", 503);
  }

  return trackedFetch(
    `https://footballcharts-backend.onrender.com/api/v1/${endpoint}`,
    "FOOTBALL_CHARTS",
    {
      headers: { Authorization: `Bearer ${FOOTBALL_CHARTS_KEY}` }
    },
    CACHE_CATALOG_MS
  );
}

app.get("/api/providers/football-charts/test", async (req, res) => {
  try {
    const result = await footballChartsFetch("leagues/");
    const data = result.data;

    const leagues = Array.isArray(data)
      ? data
      : safeArray(data.leagues || data.results);

    res.json({
      provider: "Football Charts",
      status: "connected",
      leaguesAvailable: leagues.length,
      leagues,
      teamsEndpoint: "Non confirmé : aucune route équipes n'est appelée.",
      cache: result.fromCache,
      quotas: await getUsage()
    });
  } catch (error) {
    res.status(error.status || 500).json({
      provider: "Football Charts",
      status: "error",
      message: error.message,
      quotas: await getUsage().catch(() => null)
    });
  }
});

// =====================================
// THESPORTSDB
// =====================================

async function theSportsDBFetch(endpoint) {
  const url = `https://www.thesportsdb.com/api/v1/json/${THESPORTSDB_KEY}/${endpoint}`;

  return trackedFetch(
    url,
    "THESPORTSDB",
    {},
    CACHE_CATALOG_MS
  );
}

app.get("/api/providers/thesportsdb/test", async (req, res) => {
  try {
    const result = await theSportsDBFetch("all_leagues.php");
    const leagues = safeArray(result.data.leagues);

    res.json({
      provider: "TheSportsDB",
      status: "connected",
      leaguesAvailable: leagues.length,
      footballLeaguesAvailable: leagues.filter(
        league => String(league.strSport || "").toLowerCase() === "soccer"
      ).length,
      leagues,
      cache: result.fromCache,
      quotas: await getUsage()
    });
  } catch (error) {
    res.status(error.status || 500).json({
      provider: "TheSportsDB",
      status: "error",
      message: error.message,
      quotas: await getUsage().catch(() => null)
    });
  }
});

// =====================================
// CATALOGUE DES CHAMPIONNATS
// =====================================

app.get("/api/catalog", async (req, res) => {
  const providers = [];
  const errors = [];

  try {
    const result = await footballDataFetch("competitions/", CACHE_CATALOG_MS);

    const competitions = safeArray(result.data.competitions).map(c => ({
      provider: "football-data",
      id: String(c.id),
      name: c.name,
      country: c.area?.name || "",
      countryCode: c.area?.code || "",
      code: c.code || "",
      type: c.type || "",
      emblem: c.emblem || ""
    }));

    providers.push({
      provider: "Football-Data.org",
      status: "connected",
      count: competitions.length,
      competitions
    });
  } catch (error) {
    errors.push({
      provider: "Football-Data.org",
      message: error.message
    });

    providers.push({
      provider: "Football-Data.org",
      status: "error",
      count: 0,
      competitions: []
    });
  }

  try {
    const result = await footballChartsFetch("leagues/");
    const data = result.data;

    const raw = Array.isArray(data)
      ? data
      : safeArray(data.leagues || data.results);

    const competitions = raw.map(league => ({
      provider: "football-charts",
      id: String(
        league.league ||
        league.id ||
        league.idLeague ||
        league.name ||
        ""
      ),
      name: league.name || league.league || "Championnat",
      country: league.country || "",
      seasons: safeArray(league.seasons),
      url: league.url || ""
    }));

    providers.push({
      provider: "Football Charts",
      status: "connected",
      count: competitions.length,
      competitions,
      teamsAvailable: false,
      note: "Le catalogue des ligues est disponible, mais l'endpoint des équipes n'est pas confirmé."
    });
  } catch (error) {
    errors.push({
      provider: "Football Charts",
      message: error.message
    });

    providers.push({
      provider: "Football Charts",
      status: "error",
      count: 0,
      competitions: []
    });
  }

  try {
    const result = await theSportsDBFetch("all_leagues.php");

    const raw = safeArray(result.data.leagues).filter(
      league => String(league.strSport || "").toLowerCase() === "soccer"
    );

    const competitions = raw.map(league => ({
      provider: "thesportsdb",
      id: String(league.idLeague || ""),
      name: league.strLeague || "Championnat",
      country: league.strCountry || "",
      alternateName: league.strLeagueAlternate || ""
    }));

    providers.push({
      provider: "TheSportsDB",
      status: "connected",
      count: competitions.length,
      competitions
    });
  } catch (error) {
    errors.push({
      provider: "TheSportsDB",
      message: error.message
    });

    providers.push({
      provider: "TheSportsDB",
      status: "error",
      count: 0,
      competitions: []
    });
  }

  const total = providers.reduce((sum, item) => sum + item.count, 0);

  res.json({
    app: "BET AGENT AI",
    version: "4.4",
    status: total > 0 ? "completed" : "unavailable",
    totalCompetitionEntries: total,
    providers,
    errors,
    note: "Les entrées peuvent se recouper entre fournisseurs. La disponibilité des équipes dépend du fournisseur et de la compétition."
  });
});

// =====================================
// CATALOGUE DES EQUIPES PAR CHAMPIONNAT
// =====================================

app.get("/api/catalog/teams", async (req, res) => {
  try {
    const provider = String(req.query.provider || "").trim().toLowerCase();

    const competitionId = String(
      req.query.competitionId || req.query.leagueId || ""
    ).trim();

    if (!competitionId || competitionId.length > 50) {
      throw httpError(
        "Indique competitionId (ou leagueId) dans la requête.",
        400
      );
    }

    let teams = [];
    let cache = false;
    let providerName = "";

    if (provider === "football-data") {
      providerName = "Football-Data.org";

      const result = await footballDataFetch(
        `competitions/${encodeURIComponent(competitionId)}/teams`,
        CACHE_CATALOG_MS
      );

      cache = result.fromCache;

      teams = safeArray(result.data.teams).map(team => ({
        id: team.id,
        name: team.name,
        shortName: team.shortName || "",
        tla: team.tla || "",
        crest: team.crest || ""
      }));

    } else if (provider === "thesportsdb") {
      providerName = "TheSportsDB";

      const result = await theSportsDBFetch(
        `lookup_all_teams.php?id=${encodeURIComponent(competitionId)}`
      );

      cache = result.fromCache;

      teams = safeArray(result.data.teams).map(team => ({
        id: team.idTeam,
        name: team.strTeam,
        shortName: team.strTeamShort || "",
        country: team.strCountry || "",
        badge: team.strTeamBadge || ""
      }));

    } else if (provider === "football-charts") {
      throw httpError(
        "Football Charts : le catalogue des championnats est disponible, mais aucune route officielle des équipes n'a été confirmée. Pour éviter une erreur, cette source n'est pas appelée.",
        501
      );

    } else {
      throw httpError(
        "Fournisseur invalide. Utilise football-data ou thesportsdb.",
        400
      );
    }

    res.json({
      app: "BET AGENT AI",
      version: "4.4",
      provider: providerName,
      competitionId,
      results: teams.length,
      teams,
      cache
    });

  } catch (error) {
    res.status(error.status || 500).json({
      status: "error",
      message: error.message
    });
  }
});

// =====================================
// RECHERCHE INTERNET AUTONOME
// GOOGLE ACTUALITES RSS
// =====================================

let researchDay = new Date().toISOString().slice(0, 10);
let researchCount = 0;

function checkResearchLimit() {
  const today = new Date().toISOString().slice(0, 10);

  if (today !== researchDay) {
    researchDay = today;
    researchCount = 0;
  }

  if (researchCount >= MAX_RESEARCH_PER_DAY) {
    throw httpError(
      "Limite quotidienne de recherches Internet atteinte.",
      429
    );
  }

  researchCount++;
}

function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    );
}

function cleanText(value = "") {
  return decodeXml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getXmlTag(block, tag) {
  const expression = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );

  const match = block.match(expression);

  return match ? cleanText(match[1]) : "";
}

function parseGoogleNewsRSS(xml) {
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  return blocks.map(block => {
    const title = getXmlTag(block, "title");
    const link = getXmlTag(block, "link");
    const published = getXmlTag(block, "pubDate");
    const description = getXmlTag(block, "description");
    const source = getXmlTag(block, "source");

    const timestamp = Date.parse(published);

    return {
      title,
      link,
      source: source || "Source non précisée",
      publishedAt: Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : null,
      description: description.slice(0, 700)
    };
  }).filter(item =>
    item.title &&
    item.link &&
    /^https:\/\/news\.google\.com\//i.test(item.link)
  );
}

async function googleNewsSearch(query) {
  const cacheKey = `GOOGLE_NEWS_RSS:${query}`;

  const cached = await getCache(cacheKey);

  if (cached !== null) {
    return {
      ...cached,
      fromCache: true
    };
  }

  const params = new URLSearchParams({
    q: query,
    hl: "fr",
    gl: "FR",
    ceid: "FR:fr"
  });

  const url =
    `https://news.google.com/rss/search?${params.toString()}`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    12000
  );

  let response;

  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "BET-AGENT-AI/4.4",
        Accept: "application/rss+xml, application/xml, text/xml"
      }
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `Google Actualités a répondu HTTP ${response.status}.`
    );
  }

  const xml = await response.text();

  if (!xml.includes("<rss") && !xml.includes("<feed")) {
    throw new Error("Réponse RSS Google Actualités invalide.");
  }

  const articles = parseGoogleNewsRSS(xml)
    .slice(0, MAX_RESULTS_PER_SEARCH);

  const result = {
    query,
    articles,
    resultCount: articles.length,
    fromCache: false
  };

  await setCache(
    cacheKey,
    "GOOGLE_NEWS_RSS",
    result,
    RESEARCH_CACHE_MS
  );

  return result;
}

// =====================================
// GENERATEUR DE REQUETES
// =====================================

function buildResearchPlan(home, away) {
  return [
    {
      category: "Match et actualités",
      query: `"${home}" "${away}" football match actualités`
    },
    {
      category: "Blessures et suspensions domicile",
      query: `"${home}" blessures blessés suspendus football`
    },
    {
      category: "Blessures et suspensions extérieur",
      query: `"${away}" blessures blessés suspendus football`
    },
    {
      category: "Compositions et tactique",
      query: `"${home}" "${away}" compositions probables football`
    }
  ];
}

function buildFollowUpPlan(home, away, articles) {
  const text = articles.map(article =>
    `${article.title} ${article.description}`
  ).join(" ").toLowerCase();

  const absencePattern =
    /\b(blessé|blessure|injury|injured|absent|absence|suspendu|suspension|forfait|incertain|doubtful|out for|ruled out)\b/i;

  if (!absencePattern.test(text)) return [];

  return [
    {
      category: "Vérification des absences",
      query: `"${home}" OR "${away}" blessure joueur forfait dernière nouvelle`
    },
    {
      category: "Remplaçants et compositions",
      query: `"${home}" "${away}" remplaçant titulaire absent composition`
    }
  ];
}

// =====================================
// DETECTION PRUDENTE DES ABSENCES
// =====================================

function detectPossibleAbsences(articles) {
  const pattern =
    /\b(blessé|blessure|injury|injured|absent|absence|suspendu|suspension|forfait|incertain|doubtful|ruled out)\b/i;

  return articles
    .filter(article =>
      pattern.test(`${article.title} ${article.description}`)
    )
    .map(article => ({
      title: article.title,
      source: article.source,
      publishedAt: article.publishedAt,
      link: article.link,
      status: "Information à vérifier",
      warning:
        "La présence de mots liés aux absences ne confirme pas une blessure."
    }));
}

// =====================================
// ROUTE DE RECHERCHE INTERNET
// =====================================

app.get("/api/research", async (req, res) => {
  try {
    const home = validateTeamName(req.query.home, "home");
    const away = validateTeamName(req.query.away, "away");

    if (home.toLowerCase() === away.toLowerCase()) {
      throw httpError("Les deux équipes doivent être différentes.", 400);
    }

    checkResearchLimit();

    const plan = buildResearchPlan(home, away);

    const searches = [];
    let articles = [];
    const searchErrors = [];

    for (const item of plan) {
      try {
        const result = await googleNewsSearch(item.query);

        searches.push({
          category: item.category,
          query: item.query,
          results: result.resultCount,
          cache: result.fromCache
        });

        articles.push(...result.articles);

      } catch (error) {
        searchErrors.push({
          query: item.query,
          message: error.message
        });
      }
    }

    const uniqueArticles = list => {
      const seen = new Set();

      return list.filter(article => {
        if (seen.has(article.link)) return false;
        seen.add(article.link);
        return true;
      });
    };

    articles = uniqueArticles(articles);

    const followUps = buildFollowUpPlan(
      home,
      away,
      articles
    );

    for (const item of followUps.slice(
      0,
      MAX_SEARCHES_PER_MATCH - searches.length
    )) {
      try {
        const result = await googleNewsSearch(item.query);

        searches.push({
          category: item.category,
          query: item.query,
          results: result.resultCount,
          cache: result.fromCache
        });

        articles.push(...result.articles);

      } catch (error) {
        searchErrors.push({
          query: item.query,
          message: error.message
        });
      }
    }

    articles = uniqueArticles(articles);

    articles.sort((a, b) => {
      return (
        new Date(b.publishedAt || 0).getTime() -
        new Date(a.publishedAt || 0).getTime()
      );
    });

    const possibleAbsences =
      detectPossibleAbsences(articles);

    res.json({
      app: "BET AGENT AI",
      module: "Recherche Internet autonome",
      version: "4.4",
      status: "completed",
      teams: {
        home,
        away
      },
      searchEngine: "Google Actualités RSS",
      searchesGenerated: searches.length,
      searches,
      articlesFound: articles.length,
      articles,
      possibleAbsences,
      decision: {
        followUpTriggered: followUps.length > 0,
        reason: followUps.length > 0
          ? "Des informations liées à des absences ont été détectées."
          : "Aucune information liée à une absence détectée dans les premiers résultats."
      },
      limitations: [
        "Les résultats proviennent du flux RSS public de Google Actualités.",
        "Les titres et extraits sont analysés, pas le contenu intégral des articles.",
        "Les blessures et suspensions détectées doivent être vérifiées.",
        "Les probabilités Poisson ne sont pas modifiées par ces résultats."
      ],
      errors: searchErrors,
      researchUsage: {
        usedToday: researchCount,
        remainingToday: Math.max(
          0,
          MAX_RESEARCH_PER_DAY - researchCount
        ),
        dailyLimit: MAX_RESEARCH_PER_DAY
      },
      footballApiQuotas: await getUsage()
    });

  } catch (error) {
    res.status(error.status || 500).json({
      status: "error",
      message: error.message,
      researchUsage: {
        usedToday: researchCount,
        remainingToday: Math.max(
          0,
          MAX_RESEARCH_PER_DAY - researchCount
        ),
        dailyLimit: MAX_RESEARCH_PER_DAY
      }
    });
  }
});

// =====================================
// SERVEUR
// =====================================

app.get("/", (req, res) => {
  res.json({
    app: "BET AGENT AI",
    status: "Serveur connecté",
    version: "4.4",
    database: "Supabase",
    providers: [
      "Football-Data.org",
      "Football Charts",
      "TheSportsDB",
      "Google Actualités RSS"
    ],
    features: [
      "Catalogue des championnats multi-fournisseurs",
      "Catalogue des équipes par championnat lorsque disponible",
      "Recherche Internet indépendante des matchs programmés",
      "Génération automatique de requêtes",
      "Détection indicative des absences",
      "Cache de recherche de 6 heures",
      "Analyse Poisson domicile/extérieur",
      "Analyse manuelle sans fixture"
    ]
  });
});

// =====================================
// COMPTEUR
// =====================================

app.get("/api/usage", async (req, res) => {
  try {
    await scheduledCleanup();

    res.json({
      quotas: await getUsage(),
      research: {
        usedToday: researchCount,
        remainingToday: Math.max(
          0,
          MAX_RESEARCH_PER_DAY - researchCount
        ),
        dailyLimit: MAX_RESEARCH_PER_DAY
      },
      protection: "active",
      database: "connected"
    });

  } catch (error) {
    res.status(503).json({
      error: error.message
    });
  }
});

// =====================================
// MATCHS DANS LES 12 PROCHAINES HEURES
// =====================================

app.get("/api/fixtures", async (req, res) => {
  try {
    await scheduledCleanup();

    const now = new Date();
    const end = new Date(
      now.getTime() + 12 * 60 * 60 * 1000
    );

    const dateFrom = now.toISOString().slice(0, 10);
    const dateTo = end.toISOString().slice(0, 10);

    const result = await footballDataFetch(
      `matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );

    const fixtures = safeArray(result.data.matches).filter(match => {
      const kickoff = new Date(match.utcDate);

      return (
        kickoff >= now &&
        kickoff <= end &&
        match.status === "SCHEDULED"
      );
    });

    res.json({
      provider: "Football-Data.org",
      results: fixtures.length,
      response: fixtures,
      windowHours: 12,
      cache: result.fromCache,
      quotas: await getUsage()
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      quotas: await getUsage().catch(() => null)
    });
  }
});

// =====================================
// MOTEUR POISSON
// DOMICILE / EXTERIEUR
// =====================================

function average(values) {
  if (!values.length) return 0;

  return values.reduce((a, b) => a + b, 0) /
    values.length;
}

function poisson(lambda, goals) {
  let factorial = 1;

  for (let i = 2; i <= goals; i++) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial
  );
}

function validateForm(form, label, required = true) {
  if (!Array.isArray(form)) {
    if (required) {
      throw httpError(`${label} : indique 3 à 10 résultats.`, 400);
    }

    return null;
  }

  if (form.length < 3 || form.length > 10) {
    throw httpError(`${label} : indique entre 3 et 10 matchs.`, 400);
  }

  const valid = form.every(match =>
    match &&
    Number.isFinite(Number(match.gf)) &&
    Number.isFinite(Number(match.ga)) &&
    Number(match.gf) >= 0 &&
    Number(match.ga) >= 0 &&
    Number.isInteger(Number(match.gf)) &&
    Number.isInteger(Number(match.ga))
  );

  if (!valid) {
    throw httpError(
      `${label} : chaque résultat doit contenir des buts entiers positifs (gf et ga).`,
      400
    );
  }

  return form.map(match => ({
    gf: Number(match.gf),
    ga: Number(match.ga)
  }));
}

function analyzeMatch(home, away) {
  // Nouveau format : homeForm / awayForm séparés.
  // Ancien format "form" conservé pour compatibilité.

  const homeHomeForm = validateForm(
    home.homeForm || home.form,
    "Forme de l'équipe à domicile",
    true
  );

  const awayAwayForm = validateForm(
    away.awayForm || away.form,
    "Forme de l'équipe à l'extérieur",
    true
  );

  const homeAwayForm = home.awayForm
    ? validateForm(
        home.awayForm,
        "Forme extérieure de l'équipe domicile",
        true
      )
    : null;

  const awayHomeForm = away.homeForm
    ? validateForm(
        away.homeForm,
        "Forme domicile de l'équipe extérieure",
        true
      )
    : null;

  const homeAttack = average(
    homeHomeForm.map(match => match.gf)
  );

  const homeDefense = average(
    homeHomeForm.map(match => match.ga)
  );

  const awayAttack = average(
    awayAwayForm.map(match => match.gf)
  );

  const awayDefense = average(
    awayAwayForm.map(match => match.ga)
  );

  const expectedHome = Math.max(
    0.15,
    Math.min(4.5, (homeAttack + awayDefense) / 2)
  );

  const expectedAway = Math.max(
    0.15,
    Math.min(4.5, (awayAttack + homeDefense) / 2)
  );

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let btts = 0;

  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const probability =
        poisson(expectedHome, h) *
        poisson(expectedAway, a);

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (h + a >= 2) over15 += probability;
      if (h + a >= 3) over25 += probability;
      if (h + a >= 4) over35 += probability;
      if (h > 0 && a > 0) btts += probability;
    }
  }

  const percent = value =>
    Math.round(value * 1000) / 10;

  return {
    method: "Poisson avec distinction domicile/extérieur",

    expectedGoals: {
      home: Number(expectedHome.toFixed(2)),
      away: Number(expectedAway.toFixed(2))
    },

    probabilities: {
      homeWin: percent(homeWin),
      draw: percent(draw),
      awayWin: percent(awayWin),
      over15: percent(over15),
      over25: percent(over25),
      over35: percent(over35),
      under25: percent(1 - over25),
      btts: percent(btts)
    },

    data: {
      homeTeamHomeMatches: homeHomeForm.length,
      awayTeamAwayMatches: awayAwayForm.length,
      homeTeamAwayMatches: homeAwayForm ? homeAwayForm.length : 0,
      awayTeamHomeMatches: awayHomeForm ? awayHomeForm.length : 0,
      additionalSplitFormsProvided: Boolean(
        homeAwayForm && awayHomeForm
      )
    },

    calculation: {
      homeExpectedGoals:
        "Moyenne entre buts marqués à domicile par l'équipe qui reçoit et buts encaissés à l'extérieur par l'équipe visiteuse.",

      awayExpectedGoals:
        "Moyenne entre buts marqués à l'extérieur par l'équipe visiteuse et buts encaissés à domicile par l'équipe qui reçoit."
    },

    warning:
      "Estimation basée sur les résultats saisis manuellement. " +
      "Elle ne garantit pas le résultat d'un match."
  };
}

// =====================================
// ANALYSE MANUELLE SANS MATCH PROGRAMME
// =====================================

app.post("/api/analyze/manual", async (req, res) => {
  try {
    const { home, away } = req.body || {};

    if (!home || !away) {
      throw httpError("Les deux équipes sont obligatoires.", 400);
    }

    const homeName = validateTeamName(
      home.name,
      "Nom de l'équipe domicile"
    );

    const awayName = validateTeamName(
      away.name,
      "Nom de l'équipe extérieure"
    );

    if (homeName.toLowerCase() === awayName.toLowerCase()) {
      throw httpError("Les deux équipes doivent être différentes.", 400);
    }

    const analysis = analyzeMatch(home, away);

    res.json({
      app: "BET AGENT AI",
      version: "4.4",
      status: "Analyse manuelle calculée",
      saved: false,

      teams: {
        home: homeName,
        away: awayName
      },

      analysis,

      note:
        "Cette analyse n'est pas associée à un match programmé et n'est pas enregistrée dans l'historique."
    });

  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message
    });
  }
});

// =====================================
// ENREGISTRER UNE ANALYSE DE MATCH PROGRAMME
// =====================================

app.post("/api/analyze", async (req, res) => {
  try {
    await scheduledCleanup();

    const { home, away, fixtureId, matchStart } = req.body || {};

    if (!home || !away || !fixtureId || !matchStart) {
      throw httpError(
        "Match, équipes et date de coup d'envoi obligatoires.",
        400
      );
    }

    const kickoff = new Date(matchStart);
    const now = new Date();

    const end = new Date(
      now.getTime() + 12 * 60 * 60 * 1000
    );

    if (
      Number.isNaN(kickoff.getTime()) ||
      kickoff < now ||
      kickoff > end
    ) {
      throw httpError(
        "Ce match n'est pas dans les 12 prochaines heures.",
        400
      );
    }

    const homeName = validateTeamName(
      home.name,
      "Nom de l'équipe domicile"
    );

    const awayName = validateTeamName(
      away.name,
      "Nom de l'équipe extérieure"
    );

    const analysis = analyzeMatch(home, away);

    const created = new Date();

    const expires = new Date(
      created.getTime() + MAX_ANALYSIS_AGE
    );

    await dbRequest("match_analyses", {
      method: "POST",

      headers: {
        Prefer: "return=minimal"
      },

      body: JSON.stringify({
        fixture_id: String(fixtureId),
        home_team: homeName,
        away_team: awayName,
        match_start: kickoff.toISOString(),
        analysis,
        created_at: created.toISOString(),
        expires_at: expires.toISOString()
      })
    });

    res.json({
      app: "BET AGENT AI",
      version: "4.4",
      status: "Analyse enregistrée",

      teams: {
        home: homeName,
        away: awayName
      },

      analysis,
      expiresAt: expires.toISOString()
    });

  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message
    });
  }
});

// =====================================
// HISTORIQUE DES ANALYSES
// =====================================

app.get("/api/analyses", async (req, res) => {
  try {
    await scheduledCleanup();

    const rows = await dbRequest(
      `match_analyses?select=*&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=created_at.desc`
    );

    res.json({
      results: rows.length,
      analyses: rows
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================
// DEMARRAGE
// =====================================

app.listen(PORT, () => {
  console.log(
    `BET AGENT AI version 4.4 lancée sur le port ${PORT}`
  );
});
