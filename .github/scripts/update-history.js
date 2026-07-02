/**
 * update-history.js
 *
 * Fetches openfootball match data, updates history.json standings snapshots,
 * and (if ODDS_API_KEY is set) fetches H2H odds from The Odds API and writes odds.json.
 */

"use strict";
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const DATA_URL     = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
const HISTORY_FILE = path.join(__dirname, "../../history.json");
const ODDS_FILE    = path.join(__dirname, "../../odds.json");

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

const OWNERS     = ["Matt", "Sean", "Zach", "Rusty"];
const TEAM_OWNER = Object.fromEntries(DRAFT.map(d => [d.team, d.owner]));
const POINTS     = { groupWin:3, groupDraw:1, advance:5, r32Win:10, r16Win:10, qfWin:10, sfWin:15, champion:20 };

// ── helpers ────────────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error("JSON parse failed: " + e.message)); }
      });
    }).on("error", reject);
  });
}

// Like fetchJSON but also returns status code and response headers
function fetchFull(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        let body;
        try { body = JSON.parse(raw); } catch(e) { body = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body });
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
  for (const m of matches) {
    if (!m.group || !isPlayed(m)) continue;
    const o1 = TEAM_OWNER[m.team1], o2 = TEAM_OWNER[m.team2];
    if (!o1 || !o2) continue;
    const [g1, g2] = m.score.ft;
    if      (g1 > g2) { totals[o1] += POINTS.groupWin; }
    else if (g2 > g1) { totals[o2] += POINTS.groupWin; }
    else              { totals[o1] += POINTS.groupDraw; totals[o2] += POINTS.groupDraw; }
  }
  // ── advance bonus (+5): must stay in sync with browser compute() pre-pass ──
  const advanced = new Set();

  // 1. R32 bracket — teams openfootball has already named
  for (const m of matches) {
    if (m.round !== "Round of 32") continue;
    if (m.team1 in TEAM_OWNER) advanced.add(m.team1);
    if (m.team2 in TEAM_OWNER) advanced.add(m.team2);
  }

  // 2. Manual tiebreaker overrides (matches browser's CLINCHED_ADVANCE set)
  //    Update this whenever index.html's CLINCHED_ADVANCE is updated.
  const CLINCHED_ADVANCE = new Set(["USA", "Argentina"]);
  for (const tm of CLINCHED_ADVANCE) {
    if (tm in TEAM_OWNER) advanced.add(tm);
  }

  // 3. Mathematical clinch: scan every group, mark top-2 of complete groups
  //    and any team whose pts strictly exceed 3rd-place's max possible.
  //    Uses all 4 teams per group (including non-pool teams) for accurate standings.
  for (const grp of "ABCDEFGHIJKL") {
    const gms = matches.filter(m => m.group === `Group ${grp}` && isPlayed(m));
    if (!gms.length) continue;

    const gs = {};
    for (const m of gms) {
      for (const [tm, gf, ga] of [[m.team1, m.score.ft[0], m.score.ft[1]], [m.team2, m.score.ft[1], m.score.ft[0]]]) {
        if (!gs[tm]) gs[tm] = { pts: 0, gd: 0, gf: 0, played: 0 };
        gs[tm].pts    += gf > ga ? 3 : gf === ga ? 1 : 0;
        gs[tm].gd     += gf - ga;
        gs[tm].gf     += gf;
        gs[tm].played += 1;
      }
    }

    const rows = Object.entries(gs)
      .sort(([, a], [, b]) => (b.pts - a.pts) || (b.gd - a.gd) || (b.gf - a.gf));
    if (rows.length < 3) continue;

    const thirdMax  = rows[2][1].pts + 3 * (3 - rows[2][1].played);
    const groupDone = rows.every(([, r]) => r.played === 3);

    for (const [tm, stats] of rows.slice(0, 2)) {
      if (!(tm in TEAM_OWNER)) continue;
      if ((stats.pts > thirdMax || groupDone) && !advanced.has(tm)) {
        advanced.add(tm);
        console.log(`  [clinch] ${tm} (Group ${grp}) pts=${stats.pts} thirdMax=${thirdMax} groupDone=${groupDone}`);
      }
    }
  }

  console.log(`  Advance bonus applied to: ${[...advanced].join(", ")}`);
  for (const t of advanced) totals[TEAM_OWNER[t]] += POINTS.advance;
  const koRounds = [
    ["Round of 32",   POINTS.r32Win], ["Round of 16",   POINTS.r16Win],
    ["Quarter-final", POINTS.qfWin],  ["Semi-final",    POINTS.sfWin],
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
        const p  = m.score.p,  et = m.score.et;
        if (Array.isArray(p)  && p.length  === 2 && p[0]  !== p[1])  winner = p[0]  > p[1]  ? m.team1 : m.team2;
        else if (Array.isArray(et) && et.length === 2 && et[0] !== et[1]) winner = et[0] > et[1] ? m.team1 : m.team2;
      }
      if (winner && TEAM_OWNER[winner]) totals[TEAM_OWNER[winner]] += pts;
    }
  }
  return { ...totals, played: matches.filter(isPlayed).length };
}

// ── odds ───────────────────────────────────────────────────────────────────
// Team name normalisation — The Odds API spellings → our spellings
const ODDS_NAME_MAP = {
  "United States":                "USA",
  "Bosnia and Herzegovina":       "Bosnia & Herzegovina",
  "Cote d'Ivoire":                "Ivory Coast",
  "Ivory Coast":                  "Ivory Coast",
  "Turkey":                       "Turkey",
  "Curacao":                      "Curaçao",
  "Democratic Republic of Congo": "DR Congo",
};
const normName = n => ODDS_NAME_MAP[n] || n;

function americanToProb(price) {
  const dec = price > 0 ? (price / 100) + 1 : (100 / Math.abs(price)) + 1;
  return 1 / dec;
}
function normalizeOutcomes(outcomes) {
  const raw   = outcomes.map(o => americanToProb(o.price));
  const total = raw.reduce((s, p) => s + p, 0);
  return outcomes.map((o, i) => ({ name: normName(o.name), p: raw[i] / total }));
}

async function updateOdds(apiKey) {
  if (!apiKey) {
    console.log("ODDS_API_KEY not set — skipping odds update.");
    console.log("  → Add it as a GitHub repository secret named ODDS_API_KEY");
    return;
  }
  console.log("ODDS_API_KEY is set ✓");

  // ── Step 1: list available sports to find the World Cup key ──────────────
  console.log("\nListing available sports to find the World Cup event key…");
  const sportsResp = await fetchFull(
    `https://api.the-odds-api.com/v4/sports?apiKey=${encodeURIComponent(apiKey)}&all=true`
  );
  console.log(`Sports list: HTTP ${sportsResp.status}`);

  if (sportsResp.status !== 200) {
    console.error("Could not retrieve sports list. Check that ODDS_API_KEY is valid.");
    console.error("Response:", JSON.stringify(sportsResp.body).slice(0, 300));
    return;
  }

  const allSports = Array.isArray(sportsResp.body) ? sportsResp.body : [];
  const soccerAll = allSports.filter(s =>
    s.group?.toLowerCase().includes("soccer") ||
    s.group?.toLowerCase().includes("football") ||
    s.key?.includes("soccer") || s.key?.includes("football")
  );
  console.log(`\nAll soccer/football sports (${soccerAll.length}):`);
  soccerAll.forEach(s => console.log(`  [${s.active ? "ACTIVE" : "inactive"}] key="${s.key}"  title="${s.title}"`));

  const wcCandidates = allSports.filter(s =>
    s.key?.toLowerCase().includes("world_cup") ||
    s.title?.toLowerCase().includes("world cup")
  );
  console.log(`\nWorld Cup candidates: ${wcCandidates.length}`);
  wcCandidates.forEach(s => console.log(`  [${s.active?"ACTIVE":"inactive"}] key="${s.key}"  title="${s.title}"`));

  // Prefer an active World Cup sport; fall back to first candidate or default
  const sportKey = (wcCandidates.find(s => s.active) || wcCandidates[0])?.key || "soccer_world_cup";
  console.log(`\nUsing sport key: "${sportKey}"`);

  // ── Step 2: fetch H2H odds for that sport ─────────────────────────────────
  console.log("Fetching H2H match odds…");
  const oddsResp = await fetchFull(
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds` +
    `?apiKey=${encodeURIComponent(apiKey)}&regions=us&markets=h2h&oddsFormat=american`
  );
  const remaining = oddsResp.headers["x-requests-remaining"] ?? "?";
  const used      = oddsResp.headers["x-requests-used"]      ?? "?";
  console.log(`H2H odds: HTTP ${oddsResp.status} | used=${used} remaining=${remaining}`);

  if (oddsResp.status !== 200) {
    console.error("Odds request failed:", JSON.stringify(oddsResp.body).slice(0, 300));
    return;
  }

  const matches = Array.isArray(oddsResp.body) ? oddsResp.body : [];
  console.log(`Received ${matches.length} match objects.`);

  // ── Step 3: compute per-team implied win probability ──────────────────────
  const now      = Date.now();
  const teamOdds = {};

  for (const match of matches) {
    const mt = new Date(match.commence_time).getTime();
    if (mt < now - 2 * 60 * 60 * 1000) continue;   // skip matches started > 2 h ago
    if (!match.bookmakers?.length) continue;

    const home = normName(match.home_team);
    const away = normName(match.away_team);

    const bookieProbs = [];
    for (const bk of match.bookmakers) {
      const h2h = bk.markets?.find(m => m.key === "h2h");
      if (!h2h?.outcomes?.length) continue;
      bookieProbs.push(normalizeOutcomes(h2h.outcomes));
    }
    if (!bookieProbs.length) continue;

    const avgProb = nm => {
      const vals = bookieProbs.map(bp => bp.find(o => o.name === nm)?.p ?? 0);
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };

    const homeProb = avgProb(home);
    const awayProb = avgProb(away);
    const drawProb = avgProb("Draw");

    for (const [team, winP, opp] of [[home, homeProb, away], [away, awayProb, home]]) {
      if (!teamOdds[team] || mt < teamOdds[team].matchTime) {
        teamOdds[team] = {
          winProb:  Math.round(winP               * 1000) / 1000,
          drawProb: Math.round(drawProb           * 1000) / 1000,
          loseProb: Math.round((1-winP-drawProb)  * 1000) / 1000,
          opp, matchTime: mt,
        };
      }
    }
  }

  const teamCount = Object.keys(teamOdds).length;

  // Also build match-level American odds for bracket/standings display.
  // Keyed by sorted team pair: "France|Germany" → { t1, t2, line1, line2, drawLine, matchTime }
  const matchOdds = {};
  const decToAmerican = dec => dec >= 2
    ? Math.round((dec - 1) * 100)
    : Math.round(-100 / (dec - 1));

  for (const match of matches) {
    const mt = new Date(match.commence_time).getTime();
    if (mt < now - 2 * 60 * 60 * 1000) continue;
    if (!match.bookmakers?.length) continue;
    const home = normName(match.home_team), away = normName(match.away_team);
    const collected = { [home]: [], [away]: [], Draw: [] };
    for (const bk of match.bookmakers) {
      const h2h = bk.markets?.find(m => m.key === "h2h");
      if (!h2h?.outcomes?.length) continue;
      for (const o of h2h.outcomes) {
        const nm = normName(o.name);
        if (nm in collected) collected[nm].push(o.price);
      }
    }
    const avgAmerican = prices => {
      if (!prices.length) return null;
      const avgDec = prices.map(p => p > 0 ? (p/100)+1 : (100/Math.abs(p))+1)
                           .reduce((s,v) => s+v, 0) / prices.length;
      return decToAmerican(avgDec);
    };
    const key = [home, away].sort().join("|");
    matchOdds[key] = {
      t1: home, t2: away,
      line1: avgAmerican(collected[home]),
      line2: avgAmerican(collected[away]),
      drawLine: avgAmerican(collected.Draw),
      matchTime: mt,
    };
  }

  const out = { fetchedAt: new Date().toISOString(), remaining, used, sportKey, teamCount, teamOdds, matchOdds };
  fs.writeFileSync(ODDS_FILE, JSON.stringify(out, null, 2) + "\n");

  if (teamCount > 0) {
    console.log(`\nodds.json written ✓ — ${teamCount} teams, ${remaining} calls remaining this month.`);
    Object.entries(teamOdds).slice(0, 4).forEach(([t, o]) =>
      console.log(`  ${t} vs ${o.opp}: Win ${Math.round(o.winProb*100)}% / Draw ${Math.round(o.drawProb*100)}%`)
    );
  } else {
    console.log(`\nodds.json written — 0 teams found. The sport may be between stages or bookmakers haven't posted odds yet.`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  // --- history ---
  console.log("Fetching match data…");
  const data = await fetchJSON(DATA_URL);
  const snap = computeStandings(data.matches);
  const today = new Date().toISOString().slice(0, 10);

  let history = [];
  if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));

  const existingIdx = history.findIndex(h => h.date === today);
  const entry = { date: today, ...snap };
  if (existingIdx >= 0) {
    history[existingIdx] = entry;
    console.log(`Updated snapshot for ${today}: Matt=${snap.Matt} Sean=${snap.Sean} Zach=${snap.Zach} Rusty=${snap.Rusty} played=${snap.played}`);
  } else {
    history.push(entry);
    console.log(`Added snapshot for ${today}: Matt=${snap.Matt} Sean=${snap.Sean} Zach=${snap.Zach} Rusty=${snap.Rusty} played=${snap.played}`);
  }

  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length > 120) history = history.slice(-120);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + "\n");
  console.log(`history.json written (${history.length} snapshots).`);

  // --- odds ---
  await updateOdds(process.env.ODDS_API_KEY || "");
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
