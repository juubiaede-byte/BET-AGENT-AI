
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

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: dbHeaders(options.headers || {})
    }
  );

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
  const dayAgo = new Date(
    Date.now() - MAX_ANALYSIS_AGE
  ).toISOString();

  await Promise.all([
    dbRequest(
      `match_analyses?expires_at=lt.${encodeURIComponent(now)}`,
      { method: "DELETE" }
    ),
    dbRequest(
      `api_cache?expires_at=lt.${encodeURIComponent(now)}`,
      { method: "DELETE" }
    ),
    dbRequest(
      `api_requests?requested_at=lt.${encodeURIComponent(dayAgo)}`,
      { method: "DELETE" }
    )
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
    const error = new Error("Quota API atteint.");
    error.status = 429;
    throw error;
  }

  return {
    hourlyUsed: Number(row.hourly_used),
    dailyUsed: Number(row.daily_used)
  };
}

async function getUsage() {
  const hourAgo = new Date(
    Date.now() - 60 * 60 * 1000
  ).toISOString();

  const dayAgo = new Date(
    Date.now() - 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = await dbRequest(
    `api_requests?select=requested_at&requested_at=gt.${encodeURIComponent(dayAgo)}`
  );

  const hourly = rows.filter(
    item => item.requested_at > hourAgo
  ).length;

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
    await dbRequest(
      `api_cache?cache_key=eq.${encoded}`,
      { method: "DELETE" }
    );
    return null;
  }

  return item.data;
}

async function setCache(key, provider, data, duration) {
  const expires = new Date(
    Date.now() + duration
  ).toISOString();

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

async function trackedFetch(url, provider, options = {}) {
  const cached = await getCache(url);

  if (cached !== null) {
    return {
      data: cached,
      fromCache: true
    };
  }

  await reserveRequest(provider);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

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
    const error = new Error(
      `Erreur ${provider}: HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  const data = await response.json();

  await setCache(
    url,
    provider,
    data,
    CACHE_FIXTURES_MS
  );

  return {
    data,
    fromCache: false
  };
}

// =====================================
// FOOTBALL-DATA.ORG
// =====================================

async function footballDataFetch(endpoint) {
  if (!FOOTBALL_DATA_TOKEN) {
    const error = new Error(
      "Jeton FOOTBALL_DATA_TOKEN manquant dans Render."
    );
    error.status = 503;
    throw error;
  }

  return trackedFetch(
    `https://api.football-data.org/v4/${endpoint}`,
    "FOOTBALL_DATA",
    {
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_TOKEN
      }
    }
  );
}

app.get("/api/providers/football-data/test", async (req, res) => {
  try {
    const result = await footballDataFetch("competitions/");

    const competitions = (
      result.data.competitions || []
    ).map(c => ({
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
    const error = new Error(
      "Clé FOOTBALL_CHARTS_KEY manquante dans Render."
    );
    error.status = 503;
    throw error;
  }

  return trackedFetch(
    `https://footballcharts-backend.onrender.com/api/v1/${endpoint}`,
    "FOOTBALL_CHARTS",
    {
      headers: {
        Authorization: `Bearer ${FOOTBALL_CHARTS_KEY}`
      }
    }
  );
}

app.get("/api/providers/football-charts/test", async (req, res) => {
  try {
    const result = await footballChartsFetch("leagues/");

    const data = result.data;

    const leagues = Array.isArray(data)
      ? data
      : data.leagues || data.results || [];

    res.json({
      provider: "Football Charts",
      status: "connected",
      leaguesAvailable: leagues.length,
      leagues,
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
  const url =
    `https://www.thesportsdb.com/api/v1/json/${THESPORTSDB_KEY}/${endpoint}`;

  return trackedFetch(
    url,
    "THESPORTSDB"
  );
}

app.get("/api/providers/thesportsdb/test", async (req, res) => {
  try {
    const result = await theSportsDBFetch("all_leagues.php");

    const leagues = result.data.leagues || [];

    if (!Array.isArray(leagues)) {
      throw new Error(
        "Format de réponse TheSportsDB inattendu."
      );
    }

    res.json({
      provider: "TheSportsDB",
      status: "connected",
      leaguesAvailable: leagues.length,
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
// RECHERCHE INTERNET AUTONOME
// GOOGLE ACTUALITES RSS
// =====================================

// Limite indépendante des quotas football.
// Attention : compteur en mémoire, remis à zéro au redémarrage.

let researchDay = new Date().toISOString().slice(0, 10);
let researchCount = 0;

function checkResearchLimit() {
  const today = new Date().toISOString().slice(0, 10);

  if (today !== researchDay) {
    researchDay = today;
    researchCount = 0;
  }

  if (researchCount >= MAX_RESEARCH_PER_DAY) {
    const error = new Error(
      "Limite quotidienne de recherches Internet atteinte."
    );
    error.status = 429;
    throw error;
  }

  researchCount++;
}

// Nettoyage et décodage du XML RSS.

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

// Requête RSS Google Actualités.
// Cette fonction ne consomme PAS les quotas des API football.

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
        "User-Agent": "BET-AGENT-AI/4.3",
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
// GENERATEUR DE REQUETES AUTONOME
// =====================================

function buildResearchPlan(home, away) {
  const homeName = home.trim();
  const awayName = away.trim();

  return [
    {
      category: "Match et actualités",
      query: `"${homeName}" "${awayName}" football match actualités`
    },
    {
      category: "Blessures et suspensions domicile",
      query: `"${homeName}" blessures blessés suspendus football`
    },
    {
      category: "Blessures et suspensions extérieur",
      query: `"${awayName}" blessures blessés suspendus football`
    },
    {
      category: "Compositions et tactique",
      query: `"${homeName}" "${awayName}" compositions probables football`
    }
  ];
}

// Les recherches complémentaires sont déclenchées
// uniquement si les premiers résultats évoquent des absences.

function buildFollowUpPlan(home, away, articles) {
  const text = articles.map(article =>
    `${article.title} ${article.description}`
  ).join(" ").toLowerCase();

  const absencePattern =
    /\b(blessé|blessure|injury|injured|absent|absence|suspendu|suspension|forfait|incertain|doubtful|out for|ruled out)\b/i;

  if (!absencePattern.test(text)) {
    return [];
  }

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
      pattern.test(
        `${article.title} ${article.description}`
      )
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
    const home = String(req.query.home || "").trim();
    const away = String(req.query.away || "").trim();

    if (
      !home ||
      !away ||
      home.length > 100 ||
      away.length > 100
    ) {
      return res.status(400).json({
        error: "Indique deux équipes valides dans home et away."
      });
    }

    if (home.toLowerCase() === away.toLowerCase()) {
      return res.status(400).json({
        error: "Les deux équipes doivent être différentes."
      });
    }

    checkResearchLimit();

    const plan = buildResearchPlan(home, away);

    const searches = [];
    let articles = [];
    let searchErrors = [];

    // Première série de recherches.

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

    // Déduplication des articles.

    const uniqueArticles = list => {
      const seen = new Set();

      return list.filter(article => {
        if (seen.has(article.link)) return false;
        seen.add(article.link);
        return true;
      });
    };

    articles = uniqueArticles(articles);

    // Décision de lancer des recherches complémentaires.

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

    // Classement chronologique.

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
      version: "4.3",
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
    version: "4.3",
    database: "Supabase",
    providers: [
      "Football-Data.org",
      "Football Charts",
      "TheSportsDB",
      "Google Actualités RSS"
    ],
    features: [
      "Recherche Internet",
      "Génération automatique de requêtes",
      "Détection indicative des absences",
      "Cache de recherche de 6 heures",
      "Analyse Poisson"
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

    const endpoint =
      `matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    const result = await footballDataFetch(endpoint);

    const fixtures = (
      result.data.matches || []
    ).filter(match => {
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
// =====================================

function average(values) {
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

function analyzeMatch(home, away) {
  const validForm = team =>
    Array.isArray(team.form) &&
    team.form.length >= 3 &&
    team.form.length <= 10 &&
    team.form.every(match =>
      Number.isFinite(match.gf) &&
      Number.isFinite(match.ga) &&
      match.gf >= 0 &&
      match.ga >= 0
    );

  if (!validForm(home) || !validForm(away)) {
    throw new Error(
      "Il faut 3 à 10 matchs valides par équipe."
    );
  }

  const homeAttack = average(home.form.map(m => m.gf));
  const homeDefense = average(home.form.map(m => m.ga));
  const awayAttack = average(away.form.map(m => m.gf));
  const awayDefense = average(away.form.map(m => m.ga));

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
      const p =
        poisson(expectedHome, h) *
        poisson(expectedAway, a);

      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      if (h + a >= 2) over15 += p;
      if (h + a >= 3) over25 += p;
      if (h + a >= 4) over35 += p;
      if (h > 0 && a > 0) btts += p;
    }
  }

  const percent = value =>
    Math.round(value * 1000) / 10;

  return {
    method: "Poisson",
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
      homeMatches: home.form.length,
      awayMatches: away.form.length
    },
    warning:
      "Estimation basée uniquement sur les résultats fournis. " +
      "Ce n'est pas une garantie de résultat."
  };
}

// =====================================
// ENREGISTRER UNE ANALYSE
// =====================================

app.post("/api/analyze", async (req, res) => {
  try {
    await scheduledCleanup();

    const { home, away, fixtureId, matchStart } = req.body;

    if (!home || !away || !fixtureId || !matchStart) {
      return res.status(400).json({
        error: "Match, équipes et date de coup d'envoi obligatoires."
      });
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
      return res.status(400).json({
        error: "Ce match n'est pas dans les 12 prochaines heures."
      });
    }

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
        home_team: home.name || "Domicile",
        away_team: away.name || "Extérieur",
        match_start: kickoff.toISOString(),
        analysis,
        created_at: created.toISOString(),
        expires_at: expires.toISOString()
      })
    });

    res.json({
      app: "BET AGENT AI",
      status: "Analyse enregistrée",
      teams: {
        home: home.name || "Domicile",
        away: away.name || "Extérieur"
      },
      analysis,
      expiresAt: expires.toISOString()
    });

  } catch (error) {
    res.status(400).json({
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
    `BET AGENT AI version 4.3 lancée sur le port ${PORT}`
  );
});
