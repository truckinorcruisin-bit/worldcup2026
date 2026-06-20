/**
 * update-history.js
 *
 * Fetches the latest openfootball/worldcup.json, computes pool standings,
 * and appends (or updates) today's snapshot in history.json.
 *
 * Run by GitHub Actions on a schedule.  Mirrors the scoring logic in index.html.
 */

"use strict";
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const DATA_URL    = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
const HISTORY_FILE = path.join(__dirname, "../../history.json");

// ── draft roster (must stay in sync with index.html) ───────────────────────
const DRAFT = [
  { owner:"Rusty", team:"Spain",                  round:1  },
  { owner:"Sean",  team:"France",                 round:1  },
  { owner:"Matt",  team:"England",                round:1  },
  { owner:"Zach",  team:"Argentina",              round:1  },
  { owner:"Zach",  team:"Brazil",                 round:2  },
  { owner:"Matt",  team:"Portugal",               round:2  },
  { owner:"Sean",  team:"Germany",                round:2  },
  { owner:"Rusty", team:"Norway",                 round:2  },
  { owner:"Rusty", team:"Netherlands",            round:3  },
  { owner:"Sean",  team:"Belgium",                round:3  },
  { owner:"Matt",  team:"Mexico",                 round:3  },
  { owner:"Zach",  team:"Colombia",               round:3  },
  { owner:"Zach",  team:"Morocco",                round:4  },
  { owner:"Matt",  team:"Switzerland",            round:4  },
  { owner:"Sean",  team:"USA",                    round:4  },
  { owner:"Rusty", team:"Japan",                  round:4  },
  { owner:"Rusty", team:"Turkey",                 round:5  },
  { owner:"Sean",  team:"Uruguay",                round:5  },
  { owner:"Matt",  team:"Egypt",                  round:5  },
  { owner:"Zach",  team:"Croatia",                round:5  },
  { owner:"Zach",  team:"Ecuador",                round:6  },
  { owner:"Matt",  team:"South Korea",            round:6  },
  { owner:"Sean",  team:"Canada",                 round:6  },
  { owner:"Rusty", team:"Austria",                round:6  },
  { owner:"Rusty", team:"Senegal",                round:7  },
  { owner:"Sean",  team:"Scotland",               round:7  },
  { owner:"Matt",  team:"Ivory Coast",            round:7  },
  { owner:"Zach",  team:"Sweden",                 round:7  },
  { owner:"Zach",  team:"Czech Republic",         round:8  },
  { owner:"Matt",  team:"Algeria",                round:8  },
  { owner:"Sean",  team:"Paraguay",               round:8  },
  { owner:"Rusty", team:"Ghana",                  round:8  },
  { owner:"Rusty", team:"Bosnia & Herzegovina",   round:9  },
  { owner:"Sean",  team:"DR Congo",               round:9  },
  { owner:"Matt",  team:"Iran",                   round:9  },
  { owner:"Zach",  team:"Australia",              round:9  },
  { owner:"Zach",  team:"Saudi Arabia",           round:10 },
  { owner:"Matt",  team:"Uzbekistan",             round:10 },
  { owner:"Sean",  team:"South Africa",           round:10 },
  { owner:"Rusty", team:"New Zealand",            round:10 },
  { owner:"Rusty", team:"Tunisia",                round:11 },
  { owner:"Sean",  team:"Cape Verde",             round:11 },
  { owner:"Matt",  team:"Iraq",                   round:11 },
  { owner:"Zach",  team:"Panama",                 round:11 },
  { owner:"Zach",  team:"Qatar",                  round:12 },
  { owner:"Matt",  team:"Jordan",                 round:12 },
  { owner:"Sean",  team:"Curaçao",                round:12 },
  { owner:"Rusty", team:"Haiti",                  round:12 },
];

const OWNERS    = ["Matt", "Sean", "Zach", "Rusty"];
const TEAM_OWNER = Object.fromEntries(DRAFT.map(d => [d.team, d.owner]));

// ── scoring constants (must stay in sync with index.html) ──────────────────
const POINTS = {
  groupWin: 3, groupDraw: 1, advance: 5,
  r32Win: 10, r16Win: 10, qfWin: 10, sfWin: 15, champion: 20,
};

// ── helpers ────────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

function isPlayed(m) {
  return m && m.score && Array.isArray(m.score.ft) && m.score.ft.length === 2;
}

// ── standings computation ──────────────────────────────────────────────────
function computeStandings(matches) {
  const totals = Object.fromEntries(OWNERS.map(o => [o, 0]));
  let playedCount = 0;

  // Group stage
  for (const m of matches) {
    if (!m.group || !isPlayed(m)) continue;
    const o1 = TEAM_OWNER[m.team1], o2 = TEAM_OWNER[m.team2];
    if (!o1 || !o2) continue;
    const [g1, g2] = m.score.ft;
    playedCount++;
    if      (g1 > g2) { totals[o1] += POINTS.groupWin; }
    else if (g2 > g1) { totals[o2] += POINTS.groupWin; }
    else              { totals[o1] += POINTS.groupDraw; totals[o2] += POINTS.groupDraw; }
  }

  // Group-stage advance bonus (teams named in R32 bracket)
  const advanced = new Set();
  for (const m of matches) {
    if (m.round !== "Round of 32") continue;
    if (m.team1 in TEAM_OWNER) advanced.add(m.team1);
    if (m.team2 in TEAM_OWNER) advanced.add(m.team2);
  }
  for (const tm of advanced) totals[TEAM_OWNER[tm]] += POINTS.advance;

  // Knockout rounds
  const koRounds = [
    ["Round of 32",   POINTS.r32Win],
    ["Round of 16",   POINTS.r16Win],
    ["Quarter-final", POINTS.qfWin],
    ["Semi-final",    POINTS.sfWin],
    ["Final",         POINTS.champion],
  ];
  for (const [round, pts] of koRounds) {
    for (const m of matches) {
      if (m.round !== round || !isPlayed(m)) continue;
      const [g1, g2] = m.score.ft;
      let winner = null;
      if      (g1 > g2) winner = m.team1;
      else if (g2 > g1) winner = m.team2;
      else {
        const p  = m.score.p;
        const et = m.score.et;
        if (Array.isArray(p)  && p.length === 2  && p[0]  !== p[1])  winner = p[0]  > p[1]  ? m.team1 : m.team2;
        else if (Array.isArray(et) && et.length === 2 && et[0] !== et[1]) winner = et[0] > et[1] ? m.team1 : m.team2;
      }
      if (winner && TEAM_OWNER[winner]) totals[TEAM_OWNER[winner]] += pts;
    }
  }

  // Count total played matches (all rounds)
  playedCount = matches.filter(isPlayed).length;

  return { ...totals, played: playedCount };
}

// ── odds ───────────────────────────────────────────────────────────────────
const ODDS_FILE  = path.join(__dirname, "../../odds.json");
const ODDS_SPORT = "soccer_world_cup";

// Same name map as index.html — keeps team names consistent
const ODDS_NAME_MAP = {
  "United States":                "USA",
  "Bosnia and Herzegovina":       "Bosnia & Herzegovina",
  "Cote d'Ivoire":                "Ivory Coast",
  "Ivory Coast":                  "Ivory Coast",
  "Turkey":                       "Turkey",
  "Curacao":                      "Curaçao",
  "Democratic Republic of Congo": "DR Congo",
};
function normName(n) { return ODDS_NAME_MAP[n] || n; }

function americanToProb(price) {
  const dec = price > 0 ? (price / 100) + 1 : (100 / Math.abs(price)) + 1;
  return 1 / dec;
}
function normalizeOutcomes(outcomes) {
  const raw   = outcomes.map(o => americanToProb(o.price));
  const total = raw.reduce((s, p) => s + p, 0);
  return outcomes.map((o, i) => ({ name: normName(o.name), p: raw[i] / total }));
}

// https.get wrapper that also returns response headers
function fetchWithHeaders(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({
            status:  res.statusCode,
            headers: res.headers,
            body:    JSON.parse(Buffer.concat(chunks).toString()),
          });
        } catch(e) { reject(new Error("JSON parse failed: " + e.message)); }
      });
    }).on("error", reject);
  });
}

async function updateOdds(apiKey) {
  if (!apiKey) {
    console.log("ODDS_API_KEY not set — skipping odds update.");
    return;
  }
  console.log("Fetching odds from The Odds API…");

  const url = `https://api.the-odds-api.com/v4/sports/${ODDS_SPORT}/odds` +
              `?apiKey=${encodeURIComponent(apiKey)}&regions=us&markets=h2h&oddsFormat=american`;

  const { status, headers, body } = await fetchWithHeaders(url);
  const remaining = headers["x-requests-remaining"] ?? "?";
  const used      = headers["x-requests-used"]      ?? "?";

  if (status !== 200) {
    console.warn(`Odds API returned ${status} — skipping odds update. Response: ${JSON.stringify(body).slice(0, 120)}`);
    return;
  }

  const now     = Date.now();
  const teamOdds = {};

  for (const match of body) {
    const mt = new Date(match.commence_time).getTime();
    // Include matches not yet started or started within the last 2 hours
    if (mt < now - 2 * 60 * 60 * 1000) continue;
    if (!match.bookmakers?.length) continue;

    const home = normName(match.home_team);
    const away = normName(match.away_team);

    // Collect normalized probabilities from each bookmaker, then average
    const bookieProbs = [];
    for (const bk of match.bookmakers) {
      const h2h = bk.markets?.find(m => m.key === "h2h");
      if (!h2h?.outcomes?.length) continue;
      bookieProbs.push(normalizeOutcomes(h2h.outcomes));
    }
    if (!bookieProbs.length) continue;

    const avgProb = (nm) => {
      const vals = bookieProbs.map(bp => bp.find(o => o.name === nm)?.p ?? 0);
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };

    const homeProb = avgProb(home);
    const awayProb = avgProb(away);
    const drawProb = avgProb("Draw");

    for (const [team, winP, opp] of [[home, homeProb, away], [away, awayProb, home]]) {
      // Keep only the next upcoming match per team
      if (!teamOdds[team] || mt < teamOdds[team].matchTime) {
        teamOdds[team] = {
          winProb:  Math.round(winP  * 1000) / 1000,
          drawProb: Math.round(drawProb * 1000) / 1000,
          loseProb: Math.round((1 - winP - drawProb) * 1000) / 1000,
          opp,
          matchTime: mt,
        };
      }
    }
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    remaining,
    used,
    teamCount: Object.keys(teamOdds).length,
    teamOdds,
  };

  fs.writeFileSync(ODDS_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`odds.json written — ${out.teamCount} teams, ${remaining} API calls remaining.`);
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("Fetching match data…");
  const data = await fetchJSON(DATA_URL);
  const snap = computeStandings(data.matches);

  // Today's date in UTC (Actions runs in UTC)
  const today = new Date().toISOString().slice(0, 10);

  // Load existing history (or start fresh)
  let history = [];
  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  }

  // Always update today's entry (scores can change during the day)
  const existingIdx = history.findIndex(h => h.date === today);
  const entry = { date: today, ...snap };
  if (existingIdx >= 0) {
    history[existingIdx] = entry;
    console.log(`Updated snapshot for ${today}: Matt=${snap.Matt} Sean=${snap.Sean} Zach=${snap.Zach} Rusty=${snap.Rusty} played=${snap.played}`);
  } else {
    history.push(entry);
    console.log(`Added snapshot for ${today}: Matt=${snap.Matt} Sean=${snap.Sean} Zach=${snap.Zach} Rusty=${snap.Rusty} played=${snap.played}`);
  }

  // Keep sorted by date, cap at 120 entries (well past the tournament)
  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length > 120) history = history.slice(-120);

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + "\n");
  console.log(`history.json written (${history.length} snapshots).`);

  // Odds update — graceful skip if key not set
  await updateOdds(process.env.ODDS_API_KEY || "");
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
