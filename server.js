
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;

const MAX_HOUR = 60;
const MAX_DAY = 180;
const MAX_ANALYSIS_AGE = 24 * 60 * 60 * 1000;
const CACHE_FIXTURES_MS = 5 * 60 * 1000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

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

// Test et découverte des compétitions accessibles
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
// SERVEUR
// =====================================

app.get("/", (req, res) => {
  res.json({
    app: "BET AGENT AI",
    status: "Serveur connecté",
    version: "4.0",
    database: "Supabase",
    providers: ["Football-Data.org"]
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
    `BET AGENT AI lancé sur le port ${PORT}`
  );
});
