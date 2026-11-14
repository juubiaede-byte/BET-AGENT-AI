
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;

// =====================================
// CONFIGURATION
// =====================================

const VERSION = "4.5";

const MAX_HOUR = 60;
const MAX_DAY = 180;

const MAX_ANALYSIS_AGE = 24 * 60 * 60 * 1000;
const PREDICTION_RETENTION = 30 * 24 * 60 * 60 * 1000;

const CACHE_FIXTURES_MS = 5 * 60 * 1000;
const CACHE_CATALOG_MS = 12 * 60 * 60 * 1000;
const RESEARCH_CACHE_MS = 6 * 60 * 60 * 1000;

const MAX_RESEARCH_PER_DAY = 10;
const MAX_RESULTS_PER_SEARCH = 8;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FOOTBALL_CHARTS_KEY = process.env.FOOTBALL_CHARTS_KEY;
const THESPORTSDB_KEY = process.env.THESPORTSDB_KEY || "123";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// =====================================
// OUTILS
// =====================================

function httpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateTeamName(value, label) {
  const name = String(value || "").trim();

  if (!name || name.length > 100) {
    throw httpError(`${label} doit contenir entre 1 et 100 caractères.`, 400);
  }

  return name;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function sameTeam(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);

  return x && y && (x === y || x.includes(y) || y.includes(x));
}

function percent(value) {
  return Math.round(value * 1000) / 10;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function validDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// =====================================
// SUPABASE
// =====================================

function checkDatabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Configuration Supabase manquante.");
  }
}

function dbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
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
    const detail = await response.text();
    console.error("Supabase:", detail);
    throw new Error("Erreur de base de données Supabase.");
  }

  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

// =====================================
// QUOTAS
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

  return row;
}

async function getUsage() {
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const dayAgo = new Date(Date.now() - 86400000).toISOString();

  const rows = await dbRequest(
    `api_requests?select=requested_at&requested_at=gt.${encodeURIComponent(dayAgo)}`
  );

  const hourly = rows.filter(
    item => item.requested_at > hourAgo
  ).length;

  return {
    hourly: {
      used: hourly,
      remaining: Math.max(0, MAX_HOUR - hourly),
      limit: MAX_HOUR
    },
    daily: {
      used: rows.length,
      remaining: Math.max(0, MAX_DAY - rows.length),
      limit: MAX_DAY
    }
  };
}

// =====================================
// CACHE PERSISTANT
// =====================================

async function getCache(key) {
  const rows = await dbRequest(
    `api_cache?cache_key=eq.${encodeURIComponent(key)}&select=data,expires_at&limit=1`
  );

  if (!rows.length) return null;

  const item = rows[0];

  if (new Date(item.expires_at).getTime() <= Date.now()) {
    await dbRequest(
      `api_cache?cache_key=eq.${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
    return null;
  }

  return item.data;
}

async function setCache(key, provider, data, duration) {
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
      expires_at: new Date(Date.now() + duration).toISOString()
    })
  });
}

// =====================================
// APPELS API CENTRALISES
// =====================================

async function trackedFetch(
  url,
  provider,
  options = {},
  cacheDuration = CACHE_FIXTURES_MS
) {
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
    throw httpError(
      `${provider}: HTTP ${response.status}`,
      response.status
    );
  }

  const data = await response.json();

  await setCache(url, provider, data, cacheDuration);

  return { data, fromCache: false };
}

// =====================================
// FOURNISSEUR 1 : FOOTBALL-DATA
// =====================================

async function footballDataFetch(
  endpoint,
  cacheDuration = CACHE_FIXTURES_MS
) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw httpError("Football-Data non configuré.", 503);
  }

  return trackedFetch(
    `https://api.football-data.org/v4/${endpoint}`,
    "FOOTBALL_DATA",
    {
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_TOKEN
      }
    },
    cacheDuration
  );
}

// =====================================
// FOURNISSEUR 2 : FOOTBALL CHARTS
// =====================================

async function footballChartsFetch(endpoint) {
  if (!FOOTBALL_CHARTS_KEY) {
    throw httpError("Football Charts non configuré.", 503);
  }

  return trackedFetch(
    `https://footballcharts-backend.onrender.com/api/v1/${endpoint}`,
    "FOOTBALL_CHARTS",
    {
      headers: {
        Authorization: `Bearer ${FOOTBALL_CHARTS_KEY}`
      }
    },
    CACHE_CATALOG_MS
  );
}

// =====================================
// FOURNISSEUR 3 : THESPORTSDB
// =====================================

async function theSportsDBFetch(endpoint) {
  const url =
    `https://www.thesportsdb.com/api/v1/json/${THESPORTSDB_KEY}/${endpoint}`;

  return trackedFetch(
    url,
    "THESPORTSDB",
    {},
    CACHE_CATALOG_MS
  );
}

// =====================================
// TEST DES FOURNISSEURS
// =====================================

app.get("/api/providers/football-data/test", async (req, res) => {
  try {
    const result = await footballDataFetch(
      "competitions/",
      CACHE_CATALOG_MS
    );

    const competitions = safeArray(
      result.data.competitions
    );

    res.json({
      provider: "Football-Data.org",
      status: "connected",
      competitionsAvailable: competitions.length,
      cache: result.fromCache,
      quotas: await getUsage()
    });
  } catch (error) {
    res.status(error.status || 500).json({
      provider: "Football-Data.org",
      status: "error",
      message: error.message
    });
  }
});

app.get("/api/providers/football-charts/test", async (req, res) => {
  try {
    const result = await footballChartsFetch("leagues/");

    const leagues = Array.isArray(result.data)
      ? result.data
      : safeArray(result.data.leagues || result.data.results);

    res.json({
      provider: "Football Charts",
      status: "connected",
      leaguesAvailable: leagues.length,
      matchVerification: "not_confirmed",
      cache: result.fromCache
    });
  } catch (error) {
    res.status(error.status || 500).json({
      provider: "Football Charts",
      status: "error",
      message: error.message
    });
  }
});

app.get("/api/providers/thesportsdb/test", async (req, res) => {
  try {
    const result = await theSportsDBFetch("all_leagues.php");

    const leagues = safeArray(result.data.leagues)
      .filter(x =>
        String(x.strSport || "").toLowerCase() === "soccer"
      );

    res.json({
      provider: "TheSportsDB",
      status: "connected",
      footballLeaguesAvailable: leagues.length,
      cache: result.fromCache
    });
  } catch (error) {
    res.status(error.status || 500).json({
      provider: "TheSportsDB",
      status: "error",
      message: error.message
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
    const result = await footballDataFetch(
      "competitions/",
      CACHE_CATALOG_MS
    );

    const competitions = safeArray(
      result.data.competitions
    ).map(c => ({
      provider: "football-data",
      id: String(c.id),
      name: c.name,
      country: c.area?.name || "",
      countryCode: c.area?.code || "",
      emblem: c.emblem || ""
    }));

    providers.push({
      provider: "Football-Data.org",
      status: "connected",
      competitions
    });
  } catch (error) {
    errors.push({
      provider: "Football-Data.org",
      message: error.message
    });
  }

  try {
    const result = await footballChartsFetch("leagues/");

    const raw = Array.isArray(result.data)
      ? result.data
      : safeArray(result.data.leagues || result.data.results);

    providers.push({
      provider: "Football Charts",
      status: "connected",
      competitions: raw.map(item => ({
        provider: "football-charts",
        id: String(
          item.league || item.id || item.idLeague || item.name || ""
        ),
        name: item.name || item.league || "Championnat",
        country: item.country || "",
        seasons: safeArray(item.seasons),
        url: item.url || ""
      }))
    });
  } catch (error) {
    errors.push({
      provider: "Football Charts",
      message: error.message
    });
  }

  try {
    const result = await theSportsDBFetch("all_leagues.php");

    const raw = safeArray(result.data.leagues)
      .filter(item =>
        String(item.strSport || "").toLowerCase() === "soccer"
      );

    providers.push({
      provider: "TheSportsDB",
      status: "connected",
      competitions: raw.map(item => ({
        provider: "thesportsdb",
        id: String(item.idLeague),
        name: item.strLeague,
        country: item.strCountry || ""
      }))
    });
  } catch (error) {
    errors.push({
      provider: "TheSportsDB",
      message: error.message
    });
  }

  const total = providers.reduce(
    (sum, p) => sum + p.competitions.length,
    0
  );

  res.json({
    app: "BET AGENT AI",
    version: VERSION,
    status: total ? "completed" : "unavailable",
    totalCompetitionEntries: total,
    providers,
    errors
  });
});

// =====================================
// EQUIPES PAR CHAMPIONNAT
// =====================================

app.get("/api/catalog/teams", async (req, res) => {
  try {
    const provider = String(req.query.provider || "")
      .trim()
      .toLowerCase();

    const competitionId = String(
      req.query.competitionId || req.query.leagueId || ""
    ).trim();

    if (!competitionId || competitionId.length > 50) {
      throw httpError("competitionId obligatoire.", 400);
    }

    let teams = [];
    let cache = false;

    if (provider === "football-data") {
      const result = await footballDataFetch(
        `competitions/${encodeURIComponent(competitionId)}/teams`,
        CACHE_CATALOG_MS
      );

      cache = result.fromCache;

      teams = safeArray(result.data.teams).map(team => ({
        id: team.id,
        name: team.name,
        shortName: team.shortName || "",
        crest: team.crest || ""
      }));
    } else if (provider === "thesportsdb") {
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
        "Route officielle des équipes non confirmée pour Football Charts.",
        501
      );
    } else {
      throw httpError("Fournisseur invalide.", 400);
    }

    res.json({
      version: VERSION,
      provider,
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
// RECHERCHE GOOGLE ACTUALITES
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
    throw httpError("Quota de recherche Internet atteint.", 429);
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
    .replace(/&gt;/g, ">");
}

function cleanText(value = "") {
  return decodeXml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getXmlTag(block, tag) {
  const match = block.match(
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    )
  );

  return match ? cleanText(match[1]) : "";
}

function parseGoogleNewsRSS(xml) {
  const blocks = xml.match(
    /<item\b[^>]*>[\s\S]*?<\/item>/gi
  ) || [];

  return blocks.map(block => {
    const published = getXmlTag(block, "pubDate");
    const timestamp = Date.parse(published);

    return {
      title: getXmlTag(block, "title"),
      link: getXmlTag(block, "link"),
      source: getXmlTag(block, "source") || "Source non précisée",
      publishedAt: Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString()
        : null,
      description: getXmlTag(block, "description").slice(0, 700)
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
    return { ...cached, fromCache: true };
  }

  const params = new URLSearchParams({
    q: query,
    hl: "fr",
    gl: "FR",
    ceid: "FR:fr"
  });

  const response = await fetch(
    `https://news.google.com/rss/search?${params}`,
    { signal: AbortSignal.timeout(12000) }
  );

  if (!response.ok) {
    throw new Error(`Google Actualités HTTP ${response.status}`);
  }

  const xml = await response.text();
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

function buildResearchPlan(home, away) {
  return [
    {
      category: "Actualités du match",
      query: `"${home}" "${away}" football match actualités`
    },
    {
      category: "Blessures domicile",
      query: `"${home}" blessures blessés suspendus football`
    },
    {
      category: "Blessures extérieur",
      query: `"${away}" blessures blessés suspendus football`
    },
    {
      category: "Compositions",
      query: `"${home}" "${away}" compositions probables football`
    }
  ];
}

app.get("/api/research", async (req, res) => {
  try {
    const home = validateTeamName(req.query.home, "home");
    const away = validateTeamName(req.query.away, "away");

    if (normalizeName(home) === normalizeName(away)) {
      throw httpError("Les équipes doivent être différentes.", 400);
    }

    checkResearchLimit();

    const searches = [];
    let articles = [];
    const errors = [];

    for (const item of buildResearchPlan(home, away)) {
      try {
        const result = await googleNewsSearch(item.query);

        searches.push({
          category: item.category,
          results: result.resultCount,
          cache: result.fromCache
        });

        articles.push(...result.articles);
      } catch (error) {
        errors.push({
          query: item.query,
          message: error.message
        });
      }
    }

    const unique = new Map();

    for (const article of articles) {
      unique.set(article.link, article);
    }

    articles = [...unique.values()].sort(
      (a, b) =>
        new Date(b.publishedAt || 0) -
        new Date(a.publishedAt || 0)
    );

    const absencePattern =
      /blessure|blessé|injury|injured|absent|suspendu|suspension|forfait|doubtful|ruled out/i;

    const possibleAbsences = articles
      .filter(article =>
        absencePattern.test(
          `${article.title} ${article.description}`
        )
      )
      .map(article => ({
        title: article.title,
        source: article.source,
        publishedAt: article.publishedAt,
        link: article.link,
        status: "À vérifier"
      }));

    res.json({
      app: "BET AGENT AI",
      version: VERSION,
      teams: { home, away },
      searchEngine: "Google Actualités RSS",
      searches,
      articlesFound: articles.length,
      articles,
      possibleAbsences,
      limitations: [
        "Les titres et extraits RSS sont analysés.",
        "Les absences ne sont pas automatiquement confirmées.",
        "Les articles postérieurs au coup d'envoi ne doivent pas justifier un pronostic pré-match."
      ],
      errors,
      researchUsage: {
        usedToday: researchCount,
        remainingToday: Math.max(
          0,
          MAX_RESEARCH_PER_DAY - researchCount
        ),
        dailyLimit: MAX_RESEARCH_PER_DAY
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      status: "error",
      message: error.message
    });
  }
});

// =====================================
// MATCHS DANS LES 12 PROCHAINES HEURES
// =====================================

app.get("/api/fixtures", async (req, res) => {
  try {
    const now = new Date();
    const end = new Date(now.getTime() + 12 * 3600000);

    const dateFrom = now.toISOString().slice(0, 10);
    const dateTo = end.toISOString().slice(0, 10);

    const result = await footballDataFetch(
      `matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );

    const fixtures = safeArray(result.data.matches)
      .filter(match => {
        const kickoff = validDate(match.utcDate);

        return kickoff &&
          kickoff >= now &&
          kickoff <= end &&
          match.status === "SCHEDULED";
      })
      .map(match => ({
        provider: "football-data",
        fixtureId: String(match.id),
        home: match.homeTeam?.name,
        away: match.awayTeam?.name,
        matchStart: match.utcDate,
        competition: match.competition?.name,
        status: match.status
      }));

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
      error: error.message
    });
  }
});

// =====================================
// MOTEUR POISSON
// =====================================

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

function validateForm(form, label) {
  if (!Array.isArray(form) || form.length < 3 || form.length > 10) {
    throw httpError(`${label} : indique 3 à 10 résultats.`, 400);
  }

  return form.map(match => {
    const gf = Number(match.gf);
    const ga = Number(match.ga);

    if (
      !Number.isInteger(gf) ||
      !Number.isInteger(ga) ||
      gf < 0 ||
      ga < 0
    ) {
      throw httpError(`${label} : résultats invalides.`, 400);
    }

    return { gf, ga };
  });
}

function analyzeMatch(home, away) {
  const homeForm = validateForm(
    home.homeForm || home.form,
    "Forme domicile"
  );

  const awayForm = validateForm(
    away.awayForm || away.form,
    "Forme extérieure"
  );

  const homeAttack = average(homeForm.map(x => x.gf));
  const homeDefense = average(homeForm.map(x => x.ga));
  const awayAttack = average(awayForm.map(x => x.gf));
  const awayDefense = average(awayForm.map(x => x.ga));

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

  const scorelines = [];

  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const probability =
        poisson(expectedHome, h) *
        poisson(expectedAway, a);

      scorelines.push({
        score: `${h}-${a}`,
        homeGoals: h,
        awayGoals: a,
        probability: percent(probability)
      });

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (h + a >= 2) over15 += probability;
      if (h + a >= 3) over25 += probability;
      if (h + a >= 4) over35 += probability;
      if (h > 0 && a > 0) btts += probability;
    }
  }

  scorelines.sort(
    (a, b) => b.probability - a.probability
  );

  return {
    method: "Poisson domicile / extérieur",

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

    mostLikelyScores: scorelines.slice(0, 5),

    data: {
      homeMatches: homeForm.length,
      awayMatches: awayForm.length
    },

    warning:
      "Estimation mathématique fondée sur les résultats saisis. Ce n'est pas une garantie."
  };
}

// =====================================
// VERIFICATION FOOTBALL-DATA
// =====================================

async function verifyFootballData(fixtureId, home, away, kickoff) {
  if (!FOOTBALL_DATA_TOKEN) {
    return {
      provider: "football-data",
      status: "unavailable",
      confirmed: false,
      reason: "Fournisseur non configuré."
    };
  }

  if (!/^\d+$/.test(String(fixtureId))) {
    return {
      provider: "football-data",
      status: "not_checked",
      confirmed: false,
      reason: "Identifiant Football-Data non fourni."
    };
  }

  try {
    const result = await footballDataFetch(
      `matches/${encodeURIComponent(fixtureId)}`
    );

    const match = result.data;

    const teamsMatch =
      sameTeam(match.homeTeam?.name, home) &&
      sameTeam(match.awayTeam?.name, away);

    const dateMatch = kickoff &&
      validDate(match.utcDate) &&
      Math.abs(
        new Date(match.utcDate).getTime() - kickoff.getTime()
      ) <= 6 * 60 * 60 * 1000;

    const confirmed = Boolean(teamsMatch && dateMatch);

    return {
      provider: "football-data",
      status: confirmed ? "confirmed" : "conflict",
      confirmed,
      teamsMatch,
      dateMatch,
      matchId: String(match.id),
      matchStatus: match.status,
      home: match.homeTeam?.name,
      away: match.awayTeam?.name,
      matchStart: match.utcDate,
      cache: result.fromCache
    };
  } catch (error) {
    return {
      provider: "football-data",
      status: "error",
      confirmed: false,
      reason: error.message
    };
  }
}

// =====================================
// VERIFICATION THESPORTSDB
// =====================================

async function searchSportsDbTeam(name) {
  const result = await theSportsDBFetch(
    `searchteams.php?t=${encodeURIComponent(name)}`
  );

  const teams = safeArray(result.data.teams);

  return teams.find(team =>
    sameTeam(team.strTeam, name)
  ) || null;
}

async function verifySportsDb(home, away, kickoff) {
  try {
    const [homeTeam, awayTeam] = await Promise.all([
      searchSportsDbTeam(home),
      searchSportsDbTeam(away)
    ]);

    if (!homeTeam || !awayTeam) {
      return {
        provider: "thesportsdb",
        status: "not_found",
        confirmed: false,
        reason: "Une ou deux équipes introuvables."
      };
    }

    const result = await theSportsDBFetch(
      `eventsnext.php?id=${encodeURIComponent(homeTeam.idTeam)}`
    );

    const events = safeArray(result.data.events);

    const target = events.find(event => {
      const teamsMatch =
        sameTeam(event.strHomeTeam, home) &&
        sameTeam(event.strAwayTeam, away);

      if (!teamsMatch) return false;

      if (!kickoff) return true;

      const eventDate = validDate(
        `${event.date || ""}T${event.strTime || "00:00:00"}Z`
      );

      return eventDate &&
        Math.abs(eventDate.getTime() - kickoff.getTime()) <=
          24 * 60 * 60 * 1000;
    });

    if (!target) {
      return {
        provider: "thesportsdb",
        status: "not_found",
        confirmed: false,
        reason: "Match correspondant non trouvé dans les prochains événements."
      };
    }

    return {
      provider: "thesportsdb",
      status: "confirmed",
      confirmed: true,
      eventId: target.idEvent,
      home: target.strHomeTeam,
      away: target.strAwayTeam,
      matchDate: target.date
    };
  } catch (error) {
    return {
      provider: "thesportsdb",
      status: "error",
      confirmed: false,
      reason: error.message
    };
  }
}

// =====================================
// VERIFICATION DES TROIS FOURNISSEURS
// =====================================

async function verifyAllProviders(
  fixtureId,
  home,
  away,
  kickoff
) {
  const results = await Promise.all([
    verifyFootballData(fixtureId, home, away, kickoff),

    verifySportsDb(home, away, kickoff),

    Promise.resolve({
      provider: "football-charts",
      status: "not_verified",
      confirmed: false,
      reason:
        "Catalogue des championnats disponible, mais route officielle de vérification des matchs non confirmée."
    })
  ]);

  const confirmed = results.filter(item => item.confirmed);

  return {
    providers: results,
    confirmedCount: confirmed.length,
    accepted: confirmed.length >= 1,
    rule: "Une seule source fiable suffit.",
    sourceUsed: confirmed.map(item => item.provider)
  };
}

// =====================================
// GENERATION DES PRONOSTICS
// =====================================

function generatePredictions(analysis) {
  const p = analysis.probabilities;
  const xg = analysis.expectedGoals;

  const predictions = [];

  function add(market, selection, probability, line = null) {
    if (
      !Number.isFinite(probability) ||
      probability <= 0 ||
      probability > 100
    ) return;

    predictions.push({
      market,
      selection,
      probability: Number(probability.toFixed(1)),
      line
    });
  }

  // 1X2
  add("1X2", "Domicile", p.homeWin);
  add("1X2", "Match nul", p.draw);
  add("1X2", "Extérieur", p.awayWin);

  // Double chance
  add("DOUBLE_CHANCE", "1X", p.homeWin + p.draw);
  add("DOUBLE_CHANCE", "X2", p.draw + p.awayWin);
  add("DOUBLE_CHANCE", "12", p.homeWin + p.awayWin);

  // Buts totaux
  add("TOTAL_GOALS", "Over 1.5", p.over15, 1.5);
  add("TOTAL_GOALS", "Over 2.5", p.over25, 2.5);
  add("TOTAL_GOALS", "Over 3.5", p.over35, 3.5);
  add("TOTAL_GOALS", "Under 2.5", p.under25, 2.5);

  // BTTS
  add("BTTS", "Oui", p.btts);
  add("BTTS", "Non", 100 - p.btts);

  // Buts par équipe : 1+ à 6+
  for (let goals = 1; goals <= 6; goals++) {
    let homeProbability = 0;
    let awayProbability = 0;

    for (let i = goals; i <= 12; i++) {
      homeProbability += poisson(xg.home, i);
      awayProbability += poisson(xg.away, i);
    }

    add(
      "TEAM_GOALS_HOME",
      `Domicile ${goals}+`,
      percent(homeProbability),
      goals
    );

    add(
      "TEAM_GOALS_AWAY",
      `Extérieur ${goals}+`,
      percent(awayProbability),
      goals
    );
  }

  // Draw No Bet
  const homeDnb =
    p.homeWin / Math.max(0.0001, p.homeWin + p.awayWin) * 100;

  const awayDnb =
    p.awayWin / Math.max(0.0001, p.homeWin + p.awayWin) * 100;

  add("DRAW_NO_BET", "Domicile", homeDnb);
  add("DRAW_NO_BET", "Extérieur", awayDnb);

  // Scores exacts calculés
  for (const score of analysis.mostLikelyScores) {
    add(
      "EXACT_SCORE",
      score.score,
      score.probability
    );
  }

  return predictions;
}

// =====================================
// SAUVEGARDE AUTOMATIQUE
// =====================================

async function savePredictions(
  fixtureId,
  home,
  away,
  kickoff,
  predictions
) {
  const expires = new Date(
    kickoff.getTime() + PREDICTION_RETENTION
  ).toISOString();

  const rows = predictions.map(item => {
    const key = [
      fixtureId,
      item.market,
      item.selection
    ].join(":");

    return {
      prediction_key: key,
      fixture_id: String(fixtureId),
      home_team: home,
      away_team: away,
      match_start: kickoff.toISOString(),
      market: item.market,
      selection: item.selection,
      line: item.line,
      probability: item.probability,
      status: "pending",
      expires_at: expires
    };
  });

  if (!rows.length) return 0;

  await dbRequest("predictions?on_conflict=prediction_key", {
    method: "POST",
    headers: {
      Prefer: "resolution=ignore-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  });

  return rows.length;
}

// =====================================
// ANALYSE MANUELLE
// =====================================

app.post("/api/analyze/manual", async (req, res) => {
  try {
    const { home, away } = req.body || {};

    if (!home || !away) {
      throw httpError("Les deux équipes sont obligatoires.", 400);
    }

    const homeName = validateTeamName(home.name, "Équipe domicile");
    const awayName = validateTeamName(away.name, "Équipe extérieure");

    if (normalizeName(homeName) === normalizeName(awayName)) {
      throw httpError("Les équipes doivent être différentes.", 400);
    }

    const analysis = analyzeMatch(home, away);

    res.json({
      app: "BET AGENT AI",
      version: VERSION,
      status: "Analyse manuelle calculée",
      saved: false,
      teams: {
        home: homeName,
        away: awayName
      },
      analysis,
      predictions: generatePredictions(analysis),
      note:
        "Analyse manuelle non liée à une rencontre confirmée. Aucun pronostic n'est enregistré dans l'historique."
    });
  } catch (error) {
    res.status(error.status || 400).json({
      status: "error",
      message: error.message
    });
  }
});

// =====================================
// ANALYSE D'UN MATCH PROGRAMME
// =====================================

app.post("/api/analyze", async (req, res) => {
  try {
    const {
      home,
      away,
      fixtureId,
      matchStart
    } = req.body || {};

    if (!home || !away || !fixtureId || !matchStart) {
      throw httpError(
        "Match, équipes, identifiant et date obligatoires.",
        400
      );
    }

    const homeName = validateTeamName(home.name, "Équipe domicile");
    const awayName = validateTeamName(away.name, "Équipe extérieure");

    const kickoff = validDate(matchStart);
    const now = new Date();

    if (
      !kickoff ||
      kickoff < now ||
      kickoff.getTime() > now.getTime() + 12 * 3600000
    ) {
      throw httpError(
        "Le match doit commencer dans les 12 prochaines heures.",
        400
      );
    }

    const verification = await verifyAllProviders(
      fixtureId,
      homeName,
      awayName,
      kickoff
    );

    if (!verification.accepted) {
      return res.status(422).json({
        app: "BET AGENT AI",
        version: VERSION,
        status: "match_not_confirmed",
        accepted: false,
        verification,
        message:
          "Aucun fournisseur n'a confirmé suffisamment ce match. Aucun pronostic n'est validé."
      });
    }

    const analysis = analyzeMatch(home, away);
    const predictions = generatePredictions(analysis);

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

    const savedCount = await savePredictions(
      fixtureId,
      homeName,
      awayName,
      kickoff,
      predictions
    );

    res.json({
      app: "BET AGENT AI",
      version: VERSION,
      status: "Analyse confirmée et enregistrée",
      accepted: true,
      teams: {
        home: homeName,
        away: awayName
      },
      verification,
      analysis,
      predictions,
      predictionsSaved: savedCount,
      predictionsRetentionDays: 30,
      analysisExpiresAt: expires.toISOString(),
      warning:
        "Les probabilités Poisson reposent sur les résultats fournis dans la requête. La confirmation du match ne valide pas automatiquement la qualité des statistiques utilisées."
    });
  } catch (error) {
    res.status(error.status || 400).json({
      status: "error",
      message: error.message
    });
  }
});

// =====================================
// HISTORIQUE DES ANALYSES
// =====================================

app.get("/api/analyses", async (req, res) => {
  try {
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
// LISTE DES PRONOSTICS
// =====================================

app.get("/api/predictions", async (req, res) => {
  try {
    const status = String(req.query.status || "").trim();
    const market = String(req.query.market || "").trim();

    let path =
      "predictions?select=*&expires_at=gt." +
      encodeURIComponent(new Date().toISOString()) +
      "&order=match_start.asc";

    if (status) {
      path += `&status=eq.${encodeURIComponent(status)}`;
    }

    if (market) {
      path += `&market=eq.${encodeURIComponent(market)}`;
    }

    const rows = await dbRequest(path);

    res.json({
      results: rows.length,
      predictions: rows
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================
// PERFORMANCE DES PRONOSTICS
// =====================================

app.get("/api/predictions/performance", async (req, res) => {
  try {
    const rows = await dbRequest(
      `predictions?select=market,status,probability&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`
    );

    const markets = {};

    for (const item of rows) {
      if (!markets[item.market]) {
        markets[item.market] = {
          total: 0,
          won: 0,
          lost: 0,
          pending: 0,
          void: 0,
          unavailable: 0
        };
      }

      const group = markets[item.market];

      group.total++;

      if (group[item.status] !== undefined) {
        group[item.status]++;
      }
    }

    for (const group of Object.values(markets)) {
      const evaluated = group.won + group.lost;

      group.accuracy = evaluated
        ? percent(group.won / evaluated)
        : null;
    }

    res.json({
      totalPredictions: rows.length,
      markets
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================
// EVALUATION DES RESULTATS FOOTBALL-DATA
// =====================================

async function evaluateFootballDataPredictions() {
  const now = new Date().toISOString();

  const rows = await dbRequest(
    `predictions?select=*&status=eq.pending&match_start=lt.${encodeURIComponent(now)}`
  );

  const groups = new Map();

  for (const row of rows) {
    if (!String(row.fixture_id).startsWith("football-data:")) {
      continue;
    }

    const id = String(row.fixture_id).replace("football-data:", "");

    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }

  const evaluated = [];

  for (const [id, predictions] of groups.entries()) {
    try {
      const result = await footballDataFetch(`matches/${id}`);
      const match = result.data;

      if (match.status === "CANCELLED") {
        for (const prediction of predictions) {
          await updatePrediction(prediction.id, {
            status: "void",
            result_source: "Football-Data.org",
            resolved_at: new Date().toISOString()
          });
        }

        evaluated.push({
          fixtureId: id,
          status: "void"
        });

        continue;
      }

      if (match.status !== "FINISHED") continue;

      const homeGoals = match.score?.fullTime?.home;
      const awayGoals = match.score?.fullTime?.away;

      if (
        !Number.isFinite(homeGoals) ||
        !Number.isFinite(awayGoals)
      ) continue;

      for (const prediction of predictions) {
        const outcome = evaluateMarket(
          prediction,
          homeGoals,
          awayGoals
        );

        if (!outcome) continue;

        await updatePrediction(prediction.id, {
          status: outcome.status,
          actual_value: outcome.actualValue,
          actual_selection: outcome.actualSelection,
          result_source: "Football-Data.org",
          resolved_at: new Date().toISOString()
        });
      }

      evaluated.push({
        fixtureId: id,
        status: "evaluated"
      });
    } catch (error) {
      console.error("Évaluation match", id, error.message);
    }
  }

  return {
    matchesProcessed: evaluated.length,
    results: evaluated
  };
}

function evaluateMarket(prediction, homeGoals, awayGoals) {
  const total = homeGoals + awayGoals;
  const selection = prediction.selection;
  const market = prediction.market;

  let won = false;

  if (market === "1X2") {
    won =
      (selection === "Domicile" && homeGoals > awayGoals) ||
      (selection === "Match nul" && homeGoals === awayGoals) ||
      (selection === "Extérieur" && awayGoals > homeGoals);
  } else if (market === "DOUBLE_CHANCE") {
    won =
      (selection === "1X" && homeGoals >= awayGoals) ||
      (selection === "X2" && awayGoals >= homeGoals) ||
      (selection === "12" && homeGoals !== awayGoals);
  } else if (market === "TOTAL_GOALS") {
    const line = Number(prediction.line);

    if (selection.startsWith("Over")) {
      won = total > line;
    } else {
      won = total < line;
    }
  } else if (market === "BTTS") {
    const yes = homeGoals > 0 && awayGoals > 0;
    won = selection === "Oui" ? yes : !yes;
  } else if (market === "TEAM_GOALS_HOME") {
    const line = Number(prediction.line);
    won = homeGoals >= line;
  } else if (market === "TEAM_GOALS_AWAY") {
    const line = Number(prediction.line);
    won = awayGoals >= line;
  } else if (market === "EXACT_SCORE") {
    won = selection === `${homeGoals}-${awayGoals}`;
  } else if (market === "DRAW_NO_BET") {
    if (homeGoals === awayGoals) {
      return {
        status: "void",
        actualValue: total,
        actualSelection: "Match nul"
      };
    }

    won =
      (selection === "Domicile" && homeGoals > awayGoals) ||
      (selection === "Extérieur" && awayGoals > homeGoals);
  } else {
    return null;
  }

  return {
    status: won ? "won" : "lost",
    actualValue: total,
    actualSelection: `${homeGoals}-${awayGoals}`
  };
}

async function updatePrediction(id, values) {
  await dbRequest(
    `predictions?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal"
      },
      body: JSON.stringify(values)
    }
  );
}

// =====================================
// ROUTE EVALUATION
// =====================================

app.post("/api/predictions/evaluate", async (req, res) => {
  try {
    const result = await evaluateFootballDataPredictions();

    res.json({
      status: "completed",
      ...result
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// =====================================
// RAPPORT QUOTIDIEN GROQ
// =====================================

function getAlgeriaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function generateDailyReport() {
  if (!GROQ_API_KEY) {
    throw httpError("GROQ_API_KEY non configurée.", 503);
  }

  const evaluation = await evaluateFootballDataPredictions();
  const today = getAlgeriaDate();

  const rows = await dbRequest(
    `predictions?select=market,status,probability,home_team,away_team,match_start&match_start=gte.${encodeURIComponent(today + "T00:00:00+01:00")}&match_start=lt.${encodeURIComponent(today + "T23:59:59+01:00")}`
  );

  const summary = {};

  for (const row of rows) {
    if (!summary[row.market]) {
      summary[row.market] = {
        won: 0,
        lost: 0,
        pending: 0,
        void: 0,
        unavailable: 0
      };
    }

    if (summary[row.market][row.status] !== undefined) {
      summary[row.market][row.status]++;
    }
  }

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [
          {
            role: "system",
            content:
              "Tu es un analyste de performances de pronostics sportifs. Analyse uniquement les données fournies. N'invente aucune statistique. Propose des améliorations prudentes, sans prétendre entraîner le modèle."
          },
          {
            role: "user",
            content: JSON.stringify({
              date: today,
              evaluation,
              marketStatistics: summary,
              totalPredictions: rows.length
            })
          }
        ],
        response_format: {
          type: "json_object"
        },
        temperature: 0.2
      })
    }
  );

  if (!response.ok) {
    throw httpError(`Erreur Groq HTTP ${response.status}`, 502);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Réponse Groq vide.");
  }

  let report;

  try {
    report = JSON.parse(content);
  } catch {
    report = {
      analysis: content
    };
  }

  const finalReport = {
    date: today,
    generatedAt: new Date().toISOString(),
    totalPredictions: rows.length,
    marketStatistics: summary,
    evaluation,
    groqAnalysis: report
  };

  await dbRequest("daily_reports?on_conflict=report_date", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      report_date: today,
      report: finalReport,
      created_at: new Date().toISOString()
    })
  });

  return finalReport;
}

// =====================================
// SECURITE CRON
// =====================================

function verifyCron(req) {
  if (!CRON_SECRET) {
    throw httpError("CRON_SECRET non configuré.", 503);
  }

  const authorization = req.headers.authorization || "";

  if (authorization !== `Bearer ${CRON_SECRET}`) {
    throw httpError("Accès non autorisé.", 401);
  }
}

app.post("/api/jobs/daily-report", async (req, res) => {
  try {
    verifyCron(req);

    const report = await generateDailyReport();

    res.json({
      status: "completed",
      report
    });
  } catch (error) {
    res.status(error.status || 500).json({
      status: "error",
      message: error.message
    });
  }
});

// =====================================
// RAPPORTS QUOTIDIENS
// =====================================

app.get("/api/daily-reports/latest", async (req, res) => {
  try {
    const rows = await dbRequest(
      "daily_reports?select=*&order=report_date.desc&limit=1"
    );

    res.json({
      report: rows[0] || null
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/api/daily-reports/:date", async (req, res) => {
  try {
    const date = String(req.params.date || "");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw httpError("Date invalide.", 400);
    }

    const rows = await dbRequest(
      `daily_reports?report_date=eq.${encodeURIComponent(date)}&select=*&limit=1`
    );

    res.json({
      report: rows[0] || null
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message
    });
  }
});

// =====================================
// NETTOYAGE DES DONNEES EXPIREES
// =====================================

async function cleanupExpired() {
  const now = new Date().toISOString();

  const predictionCutoff = new Date(
    Date.now() - PREDICTION_RETENTION
  ).toISOString();

  const reportCutoff = getAlgeriaDate();

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
      `api_requests?requested_at=lt.${encodeURIComponent(
        new Date(Date.now() - 86400000).toISOString()
      )}`,
      { method: "DELETE" }
    ),

    dbRequest(
      `predictions?expires_at=lt.${encodeURIComponent(predictionCutoff)}`,
      { method: "DELETE" }
    ),

    dbRequest(
      `daily_reports?report_date=lt.${encodeURIComponent(
        new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      )}`,
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
// COMPTEUR
// =====================================

app.get("/api/usage", async (req, res) => {
  try {
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
// PAGE PRINCIPALE
// =====================================

app.get("/", (req, res) => {
  res.json({
    app: "BET AGENT AI",
    version: VERSION,
    status: "Serveur connecté",
    database: "Supabase",
    providers: [
      "Football-Data.org",
      "Football Charts",
      "TheSportsDB",
      "Google Actualités RSS",
      "Groq"
    ],
    features: [
      "Catalogue multi-fournisseurs",
      "Catalogue des équipes",
      "Recherche Google Actualités",
      "Vérification multi-fournisseurs",
      "Une source fiable suffit pour confirmer le match",
      "Analyse Poisson",
      "Pronostics automatiques",
      "Sauvegarde automatique des marchés",
      "Historique des pronostics",
      "Évaluation des résultats disponibles",
      "Statistiques de performance",
      "Rapport quotidien Groq",
      "Quotas API persistants",
      "Cache Supabase"
    ]
  });
});

// =====================================
// DEMARRAGE
// =====================================

app.listen(PORT, () => {
  console.log(
    `BET AGENT AI version ${VERSION} lancée sur le port ${PORT}`
  );
});
