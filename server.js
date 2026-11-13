
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;

// =====================================
// CONFIGURATION DES QUOTAS
// =====================================

const MAX_HOUR = 60;
const MAX_DAY = 180;

const requestHistory = [];
const cache = new Map();

const CACHE_FIXTURES_MS = 5 * 60 * 1000;

function cleanHistory() {
  const now = Date.now();

  while (
    requestHistory.length &&
    now - requestHistory[0] >= 24 * 60 * 60 * 1000
  ) {
    requestHistory.shift();
  }
}

function getUsage() {
  cleanHistory();

  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  const hourly = requestHistory.filter(
    time => time > hourAgo
  ).length;

  const daily = requestHistory.length;

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

function canMakeRequest() {
  const usage = getUsage();

  return (
    usage.hourly.remaining > 0 &&
    usage.daily.remaining > 0
  );
}

// =====================================
// CACHE
// =====================================

function getCache(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data, duration) {
  cache.set(key, {
    data,
    expires: Date.now() + duration
  });
}

// =====================================
// GESTION CENTRALISEE DES API
// =====================================

async function trackedFetch(url, options = {}) {
  const cached = getCache(url);

  if (cached) {
    return {
      data: cached,
      fromCache: true
    };
  }

  if (!canMakeRequest()) {
    const error = new Error("Quota API atteint");
    error.status = 429;
    throw error;
  }

  // Compter chaque appel réellement envoyé.
  requestHistory.push(Date.now());

  const response = await fetch(url, options);

  if (!response.ok) {
    const error = new Error("Erreur du fournisseur API");
    error.status = 502;
    throw error;
  }

  const data = await response.json();

  if (data.errors && Object.keys(data.errors).length > 0) {
    const error = new Error("Le fournisseur a refusé la demande");
    error.status = 502;
    throw error;
  }

  return {
    data,
    fromCache: false
  };
}

// =====================================
// ROUTE PRINCIPALE
// =====================================

app.get("/", (req, res) => {
  res.json({
    app: "BET AGENT AI",
    status: "Serveur connecté",
    version: "2.0"
  });
});

// =====================================
// COMPTEUR DES REQUETES
// =====================================

app.get("/api/usage", (req, res) => {
  res.json({
    app: "BET AGENT AI",
    quotas: getUsage(),
    cacheEntries: cache.size,
    protection: "active"
  });
});

// =====================================
// RECUPERATION DES MATCHS
// =====================================

app.get("/api/fixtures", async (req, res) => {
  try {
    const date =
      req.query.date ||
      new Date().toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        error: "Format de date invalide. Utilise AAAA-MM-JJ."
      });
    }

    if (!process.env.API_FOOTBALL_KEY) {
      return res.status(503).json({
        error: "Clé API-Football non configurée sur Render."
      });
    }

    const url =
      `https://v3.football.api-sports.io/fixtures?date=${date}`;

    const result = await trackedFetch(url, {
      headers: {
        "x-apisports-key": process.env.API_FOOTBALL_KEY
      }
    });

    // Mise en cache des matchs.
    if (!result.fromCache) {
      setCache(url, result.data, CACHE_FIXTURES_MS);
    }

    res.json({
      ...result.data,
      cache: result.fromCache,
      quotas: getUsage()
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "Impossible de récupérer les matchs",
      quotas: getUsage()
    });
  }
});

// =====================================
// MOTEUR DE PROBABILITES
// =====================================

function average(values) {
  if (!values.length) return null;

  return values.reduce((a, b) => a + b, 0) / values.length;
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
    team.form.every(
      match =>
        Number.isFinite(match.gf) &&
        Number.isFinite(match.ga) &&
        match.gf >= 0 &&
        match.ga >= 0
    );

  if (!validForm(home) || !validForm(away)) {
    throw new Error(
      "Il faut au moins 3 matchs récents valides par équipe."
    );
  }

  const homeAttack = average(home.form.map(m => m.gf));
  const homeDefense = average(home.form.map(m => m.ga));

  const awayAttack = average(away.form.map(m => m.gf));
  const awayDefense = average(away.form.map(m => m.ga));

  // Estimation statistique provisoire des buts attendus.
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
    method: "Poisson - estimation basée sur la forme récente",

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
      "Estimations statistiques, pas des garanties. " +
      "Le modèle ne tient pas encore compte des blessures, " +
      "compositions, xG ou cotes."
  };
}

// =====================================
// ROUTE ANALYSE
// =====================================

app.post("/api/analyze", (req, res) => {
  try {
    const { home, away } = req.body;

    if (!home || !away) {
      return res.status(400).json({
        error: "Informations des deux équipes nécessaires."
      });
    }

    const analysis = analyzeMatch(home, away);

    res.json({
      app: "BET AGENT AI",
      status: "Analyse terminée",
      teams: {
        home: home.name || "Domicile",
        away: away.name || "Extérieur"
      },
      analysis
    });

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

// =====================================
// ERREURS
// =====================================

app.use((err, req, res, next) => {
  res.status(500).json({
    error: "Erreur interne du serveur."
  });
});

// =====================================
// DEMARRAGE
// =====================================

app.listen(PORT, () => {
  console.log(
    `BET AGENT AI lancé sur le port ${PORT}`
  );
});
