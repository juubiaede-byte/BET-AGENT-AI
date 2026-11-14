const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;

// =====================================
// CONFIGURATION 4.5
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

const PREDICTION_RETENTION_DAYS = 30;
const PREDICTION_RETENTION_MS =
PREDICTION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FOOTBALL_CHARTS_KEY = process.env.FOOTBALL_CHARTS_KEY;
const THESPORTSDB_KEY = process.env.THESPORTSDB_KEY || "123";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const GROQ_MODEL = "openai/gpt-oss-120b";

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
throw httpError(
${fieldName} doit contenir entre 1 et 100 caractères.,
400
);
}

return name;
}

function average(values) {
if (!values.length) return 0;
return values.reduce((a, b) => a + b, 0) / values.length;
}

function poisson(lambda, goals) {
let factorial = 1;

for (let i = 2; i <= goals; i++) factorial *= i;

return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function percent(value) {
return Math.round(value * 1000) / 10;
}

function isoDate(date) {
return new Date(date).toISOString();
}

function safeNumber(value) {
const number = Number(value);
return Number.isFinite(number) ? number : null;
}

// =====================================
// SUPABASE
// =====================================

function dbHeaders(extra = {}) {
return {
apikey: SUPABASE_KEY,
Authorization: Bearer ${SUPABASE_KEY},
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
${SUPABASE_URL}/rest/v1/${path},
{
...options,
headers: dbHeaders(options.headers || {})
}
);

if (!response.ok) {
const message = await response.text();
console.error("Supabase:", message);
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

const predictionExpiry = new Date(
Date.now() - PREDICTION_RETENTION_MS
).toISOString();

await Promise.all([
dbRequest(
match_analyses?expires_at=lt.${encodeURIComponent(now)},
{ method: "DELETE" }
),

dbRequest(  
  `api_cache?expires_at=lt.${encodeURIComponent(now)}`,  
  { method: "DELETE" }  
),  

dbRequest(  
  `api_requests?requested_at=lt.${encodeURIComponent(dayAgo)}`,  
  { method: "DELETE" }  
),  

dbRequest(  
  `predictions?expires_at=lt.${encodeURIComponent(now)}`,  
  { method: "DELETE" }  
),  

dbRequest(  
  `daily_reports?report_date=lt.${encodeURIComponent(  
    new Date(Date.now() - PREDICTION_RETENTION_MS)  
      .toISOString().slice(0, 10)  
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
const hourAgo = new Date(
Date.now() - 60 * 60 * 1000
).toISOString();

const dayAgo = new Date(
Date.now() - 24 * 60 * 60 * 1000
).toISOString();

const rows = await dbRequest(
api_requests?select=requested_at&requested_at=gt.${encodeURIComponent(dayAgo)}
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
const encoded = encodeURIComponent(key);

const rows = await dbRequest(
api_cache?cache_key=eq.${encoded}&select=data,expires_at&limit=1
);

if (!rows.length) return null;

const item = rows[0];

if (new Date(item.expires_at).getTime() <= Date.now()) {
await dbRequest(
api_cache?cache_key=eq.${encoded},
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
throw httpError(
Erreur ${provider}: HTTP ${response.status},
response.status
);
}

const data = await response.json();

await setCache(url, provider, data, cacheDuration);

return { data, fromCache: false };
}

// =====================================
// FOURNISSEUR FOOTBALL-DATA
// =====================================

async function footballDataFetch(
endpoint,
cacheDuration = CACHE_FIXTURES_MS
) {
if (!FOOTBALL_DATA_TOKEN) {
throw httpError(
"Jeton FOOTBALL_DATA_TOKEN manquant dans Render.",
503
);
}

return trackedFetch(
https://api.football-data.org/v4/${endpoint},
"FOOTBALL_DATA",
{
headers: {
"X-Auth-Token": FOOTBALL_DATA_TOKEN
}
},
cacheDuration
);
}

app.get("/api/providers/football-data/test", async (req, res) => {
try {
const result = await footballDataFetch(
"competitions/",
CACHE_CATALOG_MS
);

const competitions = safeArray(  
  result.data.competitions  
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
// FOURNISSEUR FOOTBALL CHARTS
// =====================================

async function footballChartsFetch(endpoint) {
if (!FOOTBALL_CHARTS_KEY) {
throw httpError(
"Clé FOOTBALL_CHARTS_KEY manquante dans Render.",
503
);
}

return trackedFetch(
https://footballcharts-backend.onrender.com/api/v1/${endpoint},
"FOOTBALL_CHARTS",
{
headers: {
Authorization: Bearer ${FOOTBALL_CHARTS_KEY}
}
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
// FOURNISSEUR THESPORTSDB
// =====================================

async function theSportsDBFetch(endpoint) {
const url =
https://www.thesportsdb.com/api/v1/json/${THESPORTSDB_KEY}/${endpoint};

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
    league =>  
      String(league.strSport || "").toLowerCase() === "soccer"  
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
// CATALOGUE MULTI-FOURNISSEURS
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
const raw = Array.isArray(result.data)
? result.data
: safeArray(result.data.leagues || result.data.results);

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
  teamsAvailable: false  
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
  league =>  
    String(league.strSport || "").toLowerCase() === "soccer"  
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

const total = providers.reduce(
(sum, item) => sum + item.count,
0
);

res.json({
app: "BET AGENT AI",
version: "4.5",
status: total > 0 ? "completed" : "unavailable",
totalCompetitionEntries: total,
providers,
errors
});
});

// =====================================
// CATALOGUE DES EQUIPES
// =====================================

app.get("/api/catalog/teams", async (req, res) => {
try {
const provider = String(
req.query.provider || ""
).trim().toLowerCase();

const competitionId = String(  
  req.query.competitionId || req.query.leagueId || ""  
).trim();  

if (!competitionId || competitionId.length > 50) {  
  throw httpError(  
    "Indique competitionId (ou leagueId).",  
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
    "Endpoint des équipes Football Charts non confirmé.",  
    501  
  );  
} else {  
  throw httpError("Fournisseur invalide.", 400);  
}  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
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
throw httpError(
"Limite quotidienne de recherches Internet atteinte.",
429
);
}

researchCount++;
}

function decodeXml(value = "") {
return String(value)
.replace(/<!\(CDATA\[([\s\S]*?)\)]>/g, "$1")
.replace(/&/g, "&")
.replace(/"/g, '"')
.replace(/'|'/g, "'")
.replace(/</g, "<")
.replace(/>/g, ">")
.replace(/&#(\d+);/g, (, n) =>
String.fromCharCode(Number(n))
)
.replace(/&#x([0-9a-f]+);/gi, (, n) =>
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
<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>,
"i"
);

const match = block.match(expression);
return match ? cleanText(match[1]) : "";
}

function parseGoogleNewsRSS(xml) {
const blocks =
xml.match(/<item\b[^>]>[\s\S]?</item>/gi) || [];

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
/^https://news.google.com//i.test(item.link)
);
}

async function googleNewsSearch(query) {
const cacheKey = GOOGLE_NEWS_RSS:${query};
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
https://news.google.com/rss/search?${params.toString()};

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
"User-Agent": "BET-AGENT-AI/4.5",
Accept: "application/rss+xml, application/xml, text/xml"
}
});
} finally {
clearTimeout(timeout);
}

if (!response.ok) {
throw new Error(
Google Actualités HTTP ${response.status}.
);
}

const xml = await response.text();

if (!xml.includes("<rss") && !xml.includes("<feed")) {
throw new Error("Réponse RSS invalide.");
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

function buildResearchPlan(home, away) {
return [
{
category: "Match et actualités",
query: "${home}" "${away}" football match actualités
},
{
category: "Blessures domicile",
query: "${home}" blessures blessés suspendus football
},
{
category: "Blessures extérieur",
query: "${away}" blessures blessés suspendus football
},
{
category: "Compositions et tactique",
query: "${home}" "${away}" compositions probables football
}
];
}

function buildFollowUpPlan(home, away, articles) {
const text = articles.map(article =>
${article.title} ${article.description}
).join(" ").toLowerCase();

const pattern =
/\b(blessé|blessure|injury|injured|absent|absence|suspendu|suspension|forfait|incertain|doubtful|out for|ruled out)\b/i;

if (!pattern.test(text)) return [];

return [
{
category: "Vérification des absences",
query: "${home}" OR "${away}" blessure joueur forfait dernière nouvelle
},
{
category: "Remplaçants et compositions",
query: "${home}" "${away}" remplaçant titulaire absent composition
}
];
}

function detectPossibleAbsences(articles) {
const pattern =
/\b(blessé|blessure|injury|injured|absent|absence|suspendu|suspension|forfait|incertain|doubtful|ruled out)\b/i;

return articles
.filter(article =>
pattern.test(${article.title} ${article.description})
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

app.get("/api/research", async (req, res) => {
try {
const home = validateTeamName(req.query.home, "home");
const away = validateTeamName(req.query.away, "away");

if (home.toLowerCase() === away.toLowerCase()) {  
  throw httpError("Les équipes doivent être différentes.", 400);  
}  

checkResearchLimit();  

const plan = buildResearchPlan(home, away);  
const searches = [];  
const searchErrors = [];  
let articles = [];  

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

articles.sort((a, b) =>  
  new Date(b.publishedAt || 0).getTime() -  
  new Date(a.publishedAt || 0).getTime()  
);  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
  status: "completed",  
  teams: { home, away },  
  searchEngine: "Google Actualités RSS",  
  searchesGenerated: searches.length,  
  searches,  
  articlesFound: articles.length,  
  articles,  
  possibleAbsences: detectPossibleAbsences(articles),  
  followUpTriggered: followUps.length > 0,  
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
message: error.message
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

const fixtures = safeArray(  
  result.data.matches  
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

function validateForm(form, label, required = true) {
if (!Array.isArray(form)) {
if (required) {
throw httpError(
${label} : indique 3 à 10 résultats.,
400
);
}
return null;
}

if (form.length < 3 || form.length > 10) {
throw httpError(
${label} : indique entre 3 et 10 matchs.,
400
);
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
${label} : gf et ga doivent être des buts entiers positifs.,
400
);
}

return form.map(match => ({
gf: Number(match.gf),
ga: Number(match.ga)
}));
}

function analyzeMatch(home, away) {
const homeHomeForm = validateForm(
home.homeForm || home.form,
"Forme domicile",
true
);

const awayAwayForm = validateForm(
away.awayForm || away.form,
"Forme extérieure",
true
);

const homeAwayForm = home.awayForm
? validateForm(home.awayForm, "Forme extérieure domicile", true)
: null;

const awayHomeForm = away.homeForm
? validateForm(away.homeForm, "Forme domicile extérieur", true)
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
  "Estimation statistique basée sur les résultats fournis. Elle ne garantit pas le résultat."

};
}

// =====================================
// GENERATION DES PRONOSTICS 4.5
// =====================================

function predictionKey(
fixtureId,
market,
selection,
line = null
) {
return [
String(fixtureId),
market,
selection,
line === null ? "" : String(line)
].join("|").toLowerCase();
}

function makePredictionRows({
fixtureId,
home,
away,
kickoff,
analysis
}) {
const lambdaHome = analysis.expectedGoals.home;
const lambdaAway = analysis.expectedGoals.away;
const rows = [];

function add(market, selection, probability, line = null) {
const p = safeNumber(probability);

rows.push({  
  prediction_key: predictionKey(  
    fixtureId,  
    market,  
    selection,  
    line  
  ),  
  fixture_id: String(fixtureId),  
  home_team: home,  
  away_team: away,  
  match_start: kickoff,  
  market,  
  selection,  
  line,  
  probability: p === null ? null : Math.max(  
    0,  
    Math.min(100, p)  
  ),  
  status: p === null ? "unavailable" : "pending",  
  expires_at: new Date(  
    new Date(kickoff).getTime() + PREDICTION_RETENTION_MS  
  ).toISOString()  
});

}

// Calcul des probabilités exactes sur une grille de scores.
const grid = [];
let homeWin = 0;
let draw = 0;
let awayWin = 0;
let bttsYes = 0;
let totalOver = {
0.5: 0,
1.5: 0,
2.5: 0,
3.5: 0,
4.5: 0
};

let homeGoals = Array(7).fill(0);
let awayGoals = Array(7).fill(0);

for (let h = 0; h <= 12; h++) {
for (let a = 0; a <= 12; a++) {
const probability =
poisson(lambdaHome, h) *
poisson(lambdaAway, a);

grid.push({  
    home: h,  
    away: a,  
    probability  
  });  

  if (h > a) homeWin += probability;  
  else if (h === a) draw += probability;  
  else awayWin += probability;  

  if (h > 0 && a > 0) bttsYes += probability;  

  const total = h + a;  

  for (const line of Object.keys(totalOver)) {  
    if (total > Number(line)) {  
      totalOver[line] += probability;  
    }  
  }  

  if (h < 7) homeGoals[h] += probability;  
  if (a < 7) awayGoals[a] += probability;  
}

}

// 1X2
add("1X2", "1", percent(homeWin));
add("1X2", "X", percent(draw));
add("1X2", "2", percent(awayWin));

// Double chance
add("DOUBLE_CHANCE", "1X", percent(homeWin + draw));
add("DOUBLE_CHANCE", "X2", percent(draw + awayWin));
add("DOUBLE_CHANCE", "12", percent(homeWin + awayWin));

// Draw no bet
const homeDnb = homeWin + draw > 0
? homeWin / (homeWin + awayWin)
: 0;

const awayDnb = homeWin + awayWin > 0
? awayWin / (homeWin + awayWin)
: 0;

add("DNB", "DOMICILE", percent(homeDnb));
add("DNB", "EXTERIEUR", percent(awayDnb));

// Buts équipe domicile et extérieur
for (let goals = 1; goals <= 6; goals++) {
const homeProbability = homeGoals
.slice(goals)
.reduce((sum, value) => sum + value, 0);

const awayProbability = awayGoals  
  .slice(goals)  
  .reduce((sum, value) => sum + value, 0);  

add(  
  "TEAM_GOALS_HOME",  
  `PLUS_${goals}`,  
  percent(homeProbability),  
  goals - 0.5  
);  

add(  
  "TEAM_GOALS_AWAY",  
  `PLUS_${goals}`,  
  percent(awayProbability),  
  goals - 0.5  
);

}

// Total buts
for (const line of Object.keys(totalOver)) {
const over = totalOver[line];

add(  
  "TOTAL_GOALS",  
  `OVER_${line}`,  
  percent(over),  
  Number(line)  
);  

add(  
  "TOTAL_GOALS",  
  `UNDER_${line}`,  
  percent(1 - over),  
  Number(line)  
);

}

// Les deux équipes marquent
add("BTTS", "YES", percent(bttsYes));
add("BTTS", "NO", percent(1 - bttsYes));

// Scores exacts : les 5 probabilités les plus élevées
grid.sort((a, b) => b.probability - a.probability);

for (const score of grid.slice(0, 5)) {
add(
"EXACT_SCORE",
${score.home}-${score.away},
percent(score.probability)
);
}

// Marchés non disponibles sans statistiques réelles
const unavailableMarkets = [
["CORNERS_TOTAL", "STATISTIQUES_REQUISES"],
["CORNERS_HOME", "STATISTIQUES_REQUISES"],
["CORNERS_AWAY", "STATISTIQUES_REQUISES"],
["YELLOW_CARDS", "STATISTIQUES_REQUISES"],
["RED_CARDS", "STATISTIQUES_REQUISES"],
["FOULS_TOTAL", "STATISTIQUES_REQUISES"],
["FOULS_HOME", "STATISTIQUES_REQUISES"],
["FOULS_AWAY", "STATISTIQUES_REQUISES"],
["OFFSIDES_TOTAL", "STATISTIQUES_REQUISES"],
["OFFSIDES_HOME", "STATISTIQUES_REQUISES"],
["OFFSIDES_AWAY", "STATISTIQUES_REQUISES"],
["HALF_TIME_RESULT", "DONNEES_MI_TEMPS_REQUISES"],
["SECOND_HALF_RESULT", "DONNEES_MI_TEMPS_REQUISES"],
["HALF_TIME_GOALS", "DONNEES_MI_TEMPS_REQUISES"],
["SECOND_HALF_GOALS", "DONNEES_MI_TEMPS_REQUISES"]
];

for (const [market, selection] of unavailableMarkets) {
add(market, selection, null);
}

return rows;
}

async function saveAutomaticPredictions(params) {
const rows = makePredictionRows(params);

if (!rows.length) return [];

await dbRequest(
"predictions?on_conflict=prediction_key",
{
method: "POST",
headers: {
Prefer: "resolution=ignore-duplicates,return=representation"
},
body: JSON.stringify(rows)
}
);

return rows;
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

const homeName = validateTeamName(  
  home.name,  
  "Nom de l'équipe domicile"  
);  

const awayName = validateTeamName(  
  away.name,  
  "Nom de l'équipe extérieure"  
);  

if (homeName.toLowerCase() === awayName.toLowerCase()) {  
  throw httpError("Les équipes doivent être différentes.", 400);  
}  

const analysis = analyzeMatch(home, away);  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
  status: "Analyse manuelle calculée",  
  saved: false,  
  teams: {  
    home: homeName,  
    away: awayName  
  },  
  analysis,  
  note:  
    "Analyse manuelle non associée à un match programmé. Aucun pronostic n'est enregistré dans l'historique."  
});

} catch (error) {
res.status(error.status || 400).json({
error: error.message
});
}
});

// =====================================
// ANALYSE PROGRAMMEE + ENREGISTREMENT
// =====================================

app.post("/api/analyze", async (req, res) => {
try {
await scheduledCleanup();

const {  
  home,  
  away,  
  fixtureId,  
  matchStart  
} = req.body || {};  

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

if (homeName.toLowerCase() === awayName.toLowerCase()) {  
  throw httpError("Les équipes doivent être différentes.", 400);  
}  

const analysis = analyzeMatch(home, away);  
const created = new Date();  

const analysisExpires = new Date(  
  created.getTime() + MAX_ANALYSIS_AGE  
);  

const fixtureKey = String(fixtureId).startsWith("football-data:")  
  ? String(fixtureId)  
  : `football-data:${String(fixtureId)}`;  

// Sauvegarde de l'analyse 24 heures  
await dbRequest("match_analyses", {  
  method: "POST",  
  headers: {  
    Prefer: "return=minimal"  
  },  
  body: JSON.stringify({  
    fixture_id: fixtureKey,  
    home_team: homeName,  
    away_team: awayName,  
    match_start: kickoff.toISOString(),  
    analysis,  
    created_at: created.toISOString(),  
    expires_at: analysisExpires.toISOString()  
  })  
});  

// Sauvegarde automatique de tous les marchés calculables  
const predictions = await saveAutomaticPredictions({  
  fixtureId: fixtureKey,  
  home: homeName,  
  away: awayName,  
  kickoff: kickoff.toISOString(),  
  analysis  
});  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
  status: "Analyse et pronostics enregistrés",  
  teams: {  
    home: homeName,  
    away: awayName  
  },  
  fixtureId: fixtureKey,  
  analysis,  
  predictions: {  
    generated: predictions.length,  
    saved: true,  
    available: predictions.filter(  
      item => item.status === "pending"  
    ).length,  
    unavailable: predictions.filter(  
      item => item.status === "unavailable"  
    ).length  
  },  
  expiresAt: analysisExpires.toISOString(),  
  predictionRetentionDays: PREDICTION_RETENTION_DAYS  
});

} catch (error) {
console.error("Analyse:", error.message);

res.status(error.status || 400).json({  
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
const limit = Math.min(
500,
Math.max(1, Number(req.query.limit) || 100)
);

let filters =  
  `select=*&order=match_start.desc&limit=${limit}`;  

if (  
  status &&  
  ["pending", "won", "lost", "void", "unavailable"].includes(status)  
) {  
  filters += `&status=eq.${encodeURIComponent(status)}`;  
}  

if (market) {  
  filters += `&market=eq.${encodeURIComponent(market)}`;  
}  

const rows = await dbRequest(`predictions?${filters}`);  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
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
"predictions?select=market,status,probability&limit=10000"
);

const summary = {  
  total: rows.length,  
  pending: 0,  
  won: 0,  
  lost: 0,  
  void: 0,  
  unavailable: 0,  
  settled: 0,  
  accuracy: null,  
  byMarket: {}  
};  

for (const row of rows) {  
  if (summary[row.status] !== undefined) {  
    summary[row.status]++;  
  }  

  if (!summary.byMarket[row.market]) {  
    summary.byMarket[row.market] = {  
      total: 0,  
      pending: 0,  
      won: 0,  
      lost: 0,  
      void: 0,  
      unavailable: 0,  
      accuracy: null  
    };  
  }  

  const item = summary.byMarket[row.market];  
  item.total++;  

  if (item[row.status] !== undefined) {  
    item[row.status]++;  
  }  
}  

summary.settled = summary.won + summary.lost;  

summary.accuracy = summary.settled  
  ? percent(summary.won / summary.settled)  
  : null;  

for (const item of Object.values(summary.byMarket)) {  
  const settled = item.won + item.lost;  

  item.accuracy = settled  
    ? percent(item.won / settled)  
    : null;  
}  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
  performance: summary  
});

} catch (error) {
res.status(500).json({
error: error.message
});
}
});

// =====================================
// REGLEMENT DES PRONOSTICS
// FOOTBALL-DATA UNIQUEMENT POUR SES IDS
// =====================================

function getFootballDataId(fixtureId) {
const value = String(fixtureId || "");

if (!value.startsWith("football-data:")) {
return null;
}

const id = value.slice("football-data:".length);

return /^\d+$/.test(id) ? id : null;
}

function evaluatePrediction(row, homeGoals, awayGoals) {
const total = homeGoals + awayGoals;
const selection = row.selection;
const market = row.market;
const line = safeNumber(row.line);

if (market === "1X2") {
if (selection === "1") return homeGoals > awayGoals ? "won" : "lost";
if (selection === "X") return homeGoals === awayGoals ? "won" : "lost";
if (selection === "2") return homeGoals < awayGoals ? "won" : "lost";
}

if (market === "DOUBLE_CHANCE") {
if (selection === "1X") return homeGoals >= awayGoals ? "won" : "lost";
if (selection === "X2") return awayGoals >= homeGoals ? "won" : "lost";
if (selection === "12") return homeGoals !== awayGoals ? "won" : "lost";
}

if (market === "DNB") {
if (homeGoals === awayGoals) return "void";

if (selection === "DOMICILE") {  
  return homeGoals > awayGoals ? "won" : "lost";  
}  

if (selection === "EXTERIEUR") {  
  return awayGoals > homeGoals ? "won" : "lost";  
}

}

if (market === "TEAM_GOALS_HOME") {
const required = Number(selection.replace("PLUS_", ""));
return homeGoals >= required ? "won" : "lost";
}

if (market === "TEAM_GOALS_AWAY") {
const required = Number(selection.replace("PLUS_", ""));
return awayGoals >= required ? "won" : "lost";
}

if (market === "TOTAL_GOALS" && line !== null) {
if (selection.startsWith("OVER_")) {
return total > line ? "won" : "lost";
}

if (selection.startsWith("UNDER_")) {  
  return total < line ? "won" : "lost";  
}

}

if (market === "BTTS") {
const both = homeGoals > 0 && awayGoals > 0;

if (selection === "YES") return both ? "won" : "lost";  
if (selection === "NO") return both ? "lost" : "won";

}

if (market === "EXACT_SCORE") {
return selection === ${homeGoals}-${awayGoals}
? "won"
: "lost";
}

// Marchés statistiques non évaluables sans statistiques fiables.
return "unavailable";
}

async function settleFixture(fixtureId) {
const rows = await dbRequest(
predictions?fixture_id=eq.${encodeURIComponent(fixtureId)}&status=eq.pending&select=*
);

if (!rows.length) {
return {
fixtureId,
evaluated: 0,
message: "Aucun pronostic en attente."
};
}

const footballId = getFootballDataId(fixtureId);

if (!footballId) {
return {
fixtureId,
evaluated: 0,
message: "Identifiant non compatible avec Football-Data."
};
}

const result = await footballDataFetch(
matches/${footballId},
0
);

const match = result.data;

if (match.status === "CANCELLED" || match.status === "POSTPONED") {
await dbRequest(
predictions?fixture_id=eq.${encodeURIComponent(fixtureId)}&status=eq.pending,
{
method: "PATCH",
headers: {
Prefer: "return=minimal"
},
body: JSON.stringify({
status: "void",
result_source: "Football-Data.org",
resolved_at: new Date().toISOString()
})
}
);

return {  
  fixtureId,  
  evaluated: rows.length,  
  status: "void"  
};

}

if (match.status !== "FINISHED") {
return {
fixtureId,
evaluated: 0,
status: match.status,
message: "Match pas encore terminé."
};
}

const homeGoals = safeNumber(
match.score?.fullTime?.home
);

const awayGoals = safeNumber(
match.score?.fullTime?.away
);

if (homeGoals === null || awayGoals === null) {
return {
fixtureId,
evaluated: 0,
message: "Score final non disponible."
};
}

let evaluated = 0;

for (const row of rows) {
const status = evaluatePrediction(
row,
homeGoals,
awayGoals
);

await dbRequest(  
  `predictions?prediction_key=eq.${encodeURIComponent(row.prediction_key)}`,  
  {  
    method: "PATCH",  
    headers: {  
      Prefer: "return=minimal"  
    },  
    body: JSON.stringify({  
      status,  
      actual_value: homeGoals + awayGoals,  
      actual_selection: `${homeGoals}-${awayGoals}`,  
      result_source: "Football-Data.org",  
      resolved_at: new Date().toISOString()  
    })  
  }  
);  

evaluated++;

}

return {
fixtureId,
evaluated,
score: ${homeGoals}-${awayGoals},
status: "FINISHED"
};
}

// =====================================
// EVALUATION AUTOMATIQUE DES MATCHS FINIS
// =====================================

app.post("/api/predictions/settle", async (req, res) => {
try {
const rows = await dbRequest(
"predictions?select=fixture_id&status=eq.pending&limit=1000"
);

const fixtureIds = [  
  ...new Set(rows.map(row => row.fixture_id))  
];  

const results = [];  

for (const fixtureId of fixtureIds) {  
  try {  
    results.push(await settleFixture(fixtureId));  
  } catch (error) {  
    results.push({  
      fixtureId,  
      error: error.message  
    });  
  }  
}  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
  fixturesChecked: fixtureIds.length,  
  results  
});

} catch (error) {
res.status(500).json({
error: error.message
});
}
});

// =====================================
// RAPPORT QUOTIDIEN GROQ
// DATE ALGERIE UTC+1
// =====================================

function algeriaDate(date = new Date()) {
return new Intl.DateTimeFormat("en-CA", {
timeZone: "Africa/Algiers",
year: "numeric",
month: "2-digit",
day: "2-digit"
}).format(date);
}

function yesterdayAlgeria() {
const now = new Date();
const today = algeriaDate(now);

const [year, month, day] = today.split("-").map(Number);
const utc = new Date(Date.UTC(year, month - 1, day));

utc.setUTCDate(utc.getUTCDate() - 1);

return [
utc.getUTCFullYear(),
String(utc.getUTCMonth() + 1).padStart(2, "0"),
String(utc.getUTCDate()).padStart(2, "0")
].join("-");
}

async function generateDailyReport(reportDate) {
const existing = await dbRequest(
daily_reports?report_date=eq.${encodeURIComponent(reportDate)}&select=report&limit=1
);

if (existing.length) {
return {
alreadyGenerated: true,
report: existing[0].report
};
}

const start = new Date(
${reportDate}T00:00:00+01:00
).toISOString();

const end = new Date(
new Date(start).getTime() + 24 * 60 * 60 * 1000
).toISOString();

const rows = await dbRequest(
predictions?select=*&match_start=gte.${encodeURIComponent(start)}&match_start=lt.${encodeURIComponent(end)}&limit=10000
);

const aggregate = {
date: reportDate,
total: rows.length,
won: 0,
lost: 0,
pending: 0,
void: 0,
unavailable: 0,
accuracy: null,
markets: {}
};

for (const row of rows) {
if (aggregate[row.status] !== undefined) {
aggregate[row.status]++;
}

if (!aggregate.markets[row.market]) {  
  aggregate.markets[row.market] = {  
    total: 0,  
    won: 0,  
    lost: 0,  
    pending: 0,  
    void: 0,  
    unavailable: 0,  
    accuracy: null  
  };  
}  

const market = aggregate.markets[row.market];  
market.total++;  

if (market[row.status] !== undefined) {  
  market[row.status]++;  
}

}

const settled = aggregate.won + aggregate.lost;

aggregate.accuracy = settled
? percent(aggregate.won / settled)
: null;

for (const market of Object.values(aggregate.markets)) {
const count = market.won + market.lost;

market.accuracy = count  
  ? percent(market.won / count)  
  : null;

}

let aiReport = null;
let groqError = null;

if (GROQ_API_KEY) {
try {
const controller = new AbortController();
const timeout = setTimeout(
() => controller.abort(),
30000
);

let response;  

  try {  
    response = await fetch(  
      "https://api.groq.com/openai/v1/chat/completions",  
      {  
        method: "POST",  
        signal: controller.signal,  
        headers: {  
          Authorization: `Bearer ${GROQ_API_KEY}`,  
          "Content-Type": "application/json"  
        },  
        body: JSON.stringify({  
          model: GROQ_MODEL,  
          temperature: 0.2,  
          response_format: {  
            type: "json_object"  
          },  
          messages: [  
            {  
              role: "system",  
              content:  
                "Tu es un analyste statistique de football. " +  
                "Analyse uniquement les données fournies. " +  
                "Ne prétends jamais qu'une tendance est certaine. " +  
                "Ne recommande pas de miser de l'argent. " +  
                "Retourne un JSON avec les clés: summary, strengths, weaknesses, marketAnalysis, recommendations, limitations."  
            },  
            {  
              role: "user",  
              content:  
                "Rapport des pronostics du " +  
                reportDate +  
                ". Analyse les performances par marché, " +  
                "les réussites, les échecs, les limites et les pistes d'amélioration. " +  
                "Données: " +  
                JSON.stringify(aggregate)  
            }  
          ]  
        })  
      }  
    );  
  } finally {  
    clearTimeout(timeout);  
  }  

  if (!response.ok) {  
    throw new Error(  
      `Groq HTTP ${response.status}: ${await response.text()}`  
    );  
  }  

  const data = await response.json();  
  const content = data.choices?.[0]?.message?.content;  

  if (!content) {  
    throw new Error("Réponse Groq vide.");  
  }  

  aiReport = JSON.parse(content);  

} catch (error) {  
  groqError = error.message;  
}

} else {
groqError = "GROQ_API_KEY non configurée.";
}

const report = {
date: reportDate,
generatedAt: new Date().toISOString(),
statistics: aggregate,
ai: aiReport,
aiError: groqError,
model: GROQ_MODEL
};

await dbRequest("daily_reports", {
method: "POST",
headers: {
Prefer: "resolution=ignore-duplicates,return=representation"
},
body: JSON.stringify({
report_date: reportDate,
report,
created_at: new Date().toISOString()
})
});

return {
alreadyGenerated: false,
report
};
}

// =====================================
// ROUTE PROTEGEE DU RAPPORT QUOTIDIEN
// =====================================

app.post("/api/jobs/daily-report", async (req, res) => {
try {
if (!CRON_SECRET) {
throw httpError(
"CRON_SECRET n'est pas configuré.",
503
);
}

const authorization = req.headers.authorization || "";  
const expected = `Bearer ${CRON_SECRET}`;  

if (authorization !== expected) {  
  throw httpError("Accès refusé.", 401);  
}  

const reportDate = yesterdayAlgeria();  
const result = await generateDailyReport(reportDate);  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
  status: "completed",  
  reportDate,  
  alreadyGenerated: result.alreadyGenerated,  
  report: result.report  
});

} catch (error) {
res.status(error.status || 500).json({
status: "error",
message: error.message
});
}
});

// =====================================
// CONSULTER LES RAPPORTS
// =====================================

app.get("/api/reports", async (req, res) => {
try {
const limit = Math.min(
30,
Math.max(1, Number(req.query.limit) || 10)
);

const rows = await dbRequest(  
  `daily_reports?select=*&order=report_date.desc&limit=${limit}`  
);  

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
  results: rows.length,  
  reports: rows  
});

} catch (error) {
res.status(500).json({
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
// COMPTEUR ET ETAT DU SERVEUR
// =====================================

app.get("/api/usage", async (req, res) => {
try {
await scheduledCleanup();

res.json({  
  app: "BET AGENT AI",  
  version: "4.5",  
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

app.get("/", (req, res) => {
res.json({
app: "BET AGENT AI",
status: "Serveur connecté",
version: "4.5",
database: "Supabase",
providers: [
"Football-Data.org",
"Football Charts",
"TheSportsDB",
"Google Actualités RSS",
"Groq AI"
],
features: [
"Catalogue multi-fournisseurs",
"Recherche Internet autonome",
"Détection indicative des absences",
"Analyse Poisson domicile/extérieur",
"Pronostics automatiques 1X2",
"Double chance et DNB",
"Buts par équipe",
"Total de buts",
"BTTS",
"Scores exacts",
"Enregistrement automatique Supabase",
"Suivi des résultats",
"Performance par marché",
"Rapport quotidien Groq",
"Rétention des pronostics 30 jours",
"Protection par quotas API"
],
endpoints: [
"/api/fixtures",
"/api/catalog",
"/api/catalog/teams",
"/api/research",
"/api/analyze",
"/api/analyze/manual",
"/api/analyses",
"/api/predictions",
"/api/predictions/performance",
"/api/predictions/settle",
"/api/reports",
"/api/usage"
]
});
});

// =====================================
// DEMARRAGE
// =====================================

app.listen(PORT, () => {
console.log(
BET AGENT AI version 4.5 lancée sur le port ${PORT}
);
});
