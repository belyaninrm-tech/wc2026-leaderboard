'use strict';

const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
// DATA_SOURCE options:
//   'openfootball'  — free, no auth, updated ~daily from GitHub (default)
//   'football-data' — free account at football-data.org, live standings
//
// For football-data.org: register free at https://www.football-data.org/client/register
// then set FOOTBALL_DATA_KEY=your_token
const DATA_SOURCE       = process.env.DATA_SOURCE       || 'openfootball';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '';

const PARTICIPANTS = [
  { name: 'Майя',      teams: ['Франция', 'Аргентина', 'Бразилия'] },
  { name: 'Алина',     teams: ['Испания', 'Франция', 'Бразилия'] },
  { name: 'Михаил',    teams: ['Аргентина', 'Норвегия', 'Англия'] },
  { name: 'Геннадий',  teams: ['Испания', 'Португалия', 'Аргентина'] },
  { name: 'Галина',    teams: ['Франция', 'Англия', 'Аргентина'] },
  { name: 'Марина',    teams: ['Франция', 'Аргентина', 'Испания'] },
  { name: 'Павел',     teams: ['Франция', 'Германия', 'Испания'] },
  { name: 'Виктория',  teams: ['Франция', 'Бразилия', 'Германия'] },
  { name: 'Олег',      teams: ['Франция', 'Испания', 'Португалия'] },
  { name: 'Katherine', teams: ['Франция', 'Англия', 'Бразилия'] },
  { name: 'Роман',     teams: ['Норвегия', 'Шотландия', 'Узбекистан'] },
];

const RU_TO_EN = {
  'Франция':    'France',
  'Аргентина':  'Argentina',
  'Бразилия':   'Brazil',
  'Испания':    'Spain',
  'Норвегия':   'Norway',
  'Англия':     'England',
  'Португалия': 'Portugal',
  'Германия':   'Germany',
  'Шотландия':  'Scotland',
  'Узбекистан': 'Uzbekistan',
};

const TEAM_FLAGS = {
  'Франция':    '🇫🇷',
  'Аргентина':  '🇦🇷',
  'Бразилия':   '🇧🇷',
  'Испания':    '🇪🇸',
  'Норвегия':   '🇳🇴',
  'Англия':     '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
  'Португалия': '🇵🇹',
  'Германия':   '🇩🇪',
  'Шотландия':  '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  'Узбекистан': '🇺🇿',
};

// ─── CACHE ────────────────────────────────────────────────────────────────────
const cache    = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 min → ≤ 96 API calls/day on free plans

async function fetchJSON(url, headers = {}) {
  const now    = Date.now();
  const cached = cache.get(url);
  if (cached && now - cached.time < CACHE_TTL) return cached.data;

  console.log(`[Fetch →] ${url}`);
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  // football-data.org surfaces errors inside the body
  if (data.error || data.errorCode) {
    throw new Error(`API error: ${data.message || data.error}`);
  }

  console.log(`[Fetch ✓] ${url}`);
  cache.set(url, { data, time: now });
  return data;
}

// ─── NORMALISED MATCH FORMAT ──────────────────────────────────────────────────
// Every adapter converts raw API data to this shape:
// {
//   home: 'France',     away: 'Brazil',
//   homeGoals: 2,       awayGoals: 1,   // null → not played yet
//   ftGoals: [2, 1],                    // 90-min score (null if not played)
//   penHome: null,      penAway: null,  // penalty shootout (null if no penalties)
//   status: 'FT',       // 'FT' | 'AET' | 'PEN' | 'NS'
//   isGroup: true,
//   group: 'Group A',   // null for knockout
//   round: 'Group Stage' | 'Round of 32' | ...,
//   date: '2026-06-11',
// }

// ─── ADAPTER: openfootball ────────────────────────────────────────────────────
// Source: https://github.com/openfootball/worldcup.json
// Format: {name, matches:[{round,date,team1,team2,score:{ft,ht,et,p},group,...}]}
// Teams are plain strings. Score present only for finished matches.

const OPENFOOTBALL_URL =
  'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

function teamStr(t) {
  return typeof t === 'string' ? t : (t?.name || t?.code || '');
}

function normalizeOpenfootball(raw) {
  const matches = [];
  for (const m of (raw.matches || [])) {
    const s        = m.score || {};
    const hasFt    = Array.isArray(s.ft);
    const hasEt    = Array.isArray(s.et);
    const hasPen   = Array.isArray(s.p);

    let status = 'NS', homeGoals = null, awayGoals = null, penHome = null, penAway = null;
    let ftGoals = null;

    if (hasFt) {
      ftGoals = s.ft;
      if (hasPen) {
        status    = 'PEN';
        // homeGoals/awayGoals = cumulative score before penalties (ET or FT, still tied)
        homeGoals = hasEt ? s.et[0] : s.ft[0];
        awayGoals = hasEt ? s.et[1] : s.ft[1];
        penHome   = s.p[0];
        penAway   = s.p[1];
      } else if (hasEt) {
        status    = 'AET';
        homeGoals = s.et[0]; // cumulative 120-min score
        awayGoals = s.et[1];
      } else {
        status    = 'FT';
        homeGoals = s.ft[0];
        awayGoals = s.ft[1];
      }
    }

    const isGroup = !!m.group;
    // Normalise knockout round names to match our roundType() function
    const knockRound = isGroup ? null : (m.round || '');

    matches.push({
      home: teamStr(m.team1),
      away: teamStr(m.team2),
      homeGoals,
      awayGoals,
      ftGoals,
      penHome,
      penAway,
      status,
      isGroup,
      group:  m.group || null,
      round:  isGroup ? 'Group Stage' : knockRound,
      date:   m.date  || null,
    });
  }
  return matches;
}

async function fetchOpenfootball() {
  const raw = await fetchJSON(OPENFOOTBALL_URL);
  return normalizeOpenfootball(raw);
}

// ─── ADAPTER: football-data.org ───────────────────────────────────────────────
// Register free at https://www.football-data.org/client/register
// Set env FOOTBALL_DATA_KEY=your_token  DATA_SOURCE=football-data
// Competition code for FIFA World Cup = 'WC'

const FD_BASE = 'https://api.football-data.org/v4';

function fdStatus(s) {
  if (!s) return 'NS';
  // football-data uses: SCHEDULED, LIVE, IN_PLAY, PAUSED, FINISHED, POSTPONED, SUSPENDED, CANCELLED
  if (s === 'FINISHED') return 'FT'; // Note: won't know AET/PEN without extra fields
  return 'NS';
}

function normalizeFD(matchesData, standingsData) {
  const matches = [];
  for (const m of (matchesData.matches || [])) {
    const home = m.homeTeam?.shortName || m.homeTeam?.name || '';
    const away = m.awayTeam?.shortName || m.awayTeam?.name || '';
    const ft   = m.score?.fullTime;
    const hasFt = ft && ft.home !== null;

    // football-data.org doesn't expose AET/PEN detail on free tier
    // Use winner field to detect penalty/AET approximation
    const status = hasFt ? 'FT' : 'NS';

    const stage = m.stage || '';
    const isGroup = stage.includes('GROUP') || stage === 'GROUP_STAGE';

    matches.push({
      home, away,
      homeGoals: hasFt ? ft.home : null,
      awayGoals: hasFt ? ft.away : null,
      ftGoals:   hasFt ? [ft.home, ft.away] : null,
      penHome: null, penAway: null,
      status,
      isGroup,
      group: m.group || null,
      round: isGroup ? 'Group Stage' : (m.stage || ''),
      date:  m.utcDate?.slice(0, 10) || null,
    });
  }
  return matches;
}

function parseFDStandings(standingsData) {
  // Returns teamName → standing object (same shape as computeGroupStandings)
  const result = {};
  for (const group of (standingsData.standings || [])) {
    const groupName = group.group || 'Unknown';
    const sorted = [...(group.table || [])].sort((a, b) => a.position - b.position);
    sorted.forEach((entry, i) => {
      const name = entry.team?.shortName || entry.team?.name || '';
      result[name] = {
        name,
        group:   groupName,
        rank:    i + 1,
        played:  entry.playedGames,
        won:     entry.won,
        drawn:   entry.draw,
        lost:    entry.lost,
        gf:      entry.goalsFor,
        ga:      entry.goalsAgainst,
        gd:      entry.goalDifference,
        pts:     entry.points,
      };
    });
  }
  return result;
}

async function fetchFootballData() {
  if (!FOOTBALL_DATA_KEY) throw new Error('FOOTBALL_DATA_KEY env var not set');
  const headers = { 'X-Auth-Token': FOOTBALL_DATA_KEY };
  const [matchesRaw, standingsRaw] = await Promise.all([
    fetchJSON(`${FD_BASE}/competitions/WC/matches`, headers),
    fetchJSON(`${FD_BASE}/competitions/WC/standings`, headers),
  ]);
  const matches   = normalizeFD(matchesRaw, standingsRaw);
  const standings = parseFDStandings(standingsRaw);
  return { matches, standings };
}

// ─── GROUP STANDINGS (computed from match data — used by openfootball adapter) ─
function computeGroupStandings(matches) {
  const groupData = {}; // groupName → {teamName → stats}

  for (const m of matches) {
    if (!m.isGroup || !m.group) continue;
    if (!groupData[m.group]) groupData[m.group] = {};
    for (const name of [m.home, m.away]) {
      if (!groupData[m.group][name])
        groupData[m.group][name] = { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pts: 0 };
    }
    if (m.status === 'NS' || !m.ftGoals) continue;

    // Always use 90-min FT score for group table (no AET/PEN in group stage)
    const [g1, g2] = m.ftGoals;
    const s1 = groupData[m.group][m.home];
    const s2 = groupData[m.group][m.away];

    s1.played++; s1.gf += g1; s1.ga += g2;
    s2.played++; s2.gf += g2; s2.ga += g1;

    if (g1 > g2)      { s1.won++;   s1.pts += 3; s2.lost++; }
    else if (g1 < g2) { s2.won++;   s2.pts += 3; s1.lost++; }
    else              { s1.drawn++; s1.pts += 1; s2.drawn++; s2.pts += 1; }
  }

  const standings = {};
  for (const [groupName, teams] of Object.entries(groupData)) {
    const sorted = Object.entries(teams)
      .map(([name, s]) => ({ name, group: groupName, gd: s.gf - s.ga, ...s }))
      .sort((a, b) =>
        b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name)
      );
    sorted.forEach((t, i) => { t.rank = i + 1; standings[t.name] = t; });
  }
  return standings;
}

// ─── SCORE CALCULATION ────────────────────────────────────────────────────────
function groupPositionBonus(rank, gd) {
  if (rank === 1) { if (gd <= 3) return 9; if (gd <= 8) return 10; return 11; }
  if (rank === 2) { if (gd <= 2) return 6; if (gd <= 7) return 7;  return 8;  }
  if (rank === 3) { if (gd < 0)  return 3; if (gd <= 3) return 4;  return 5;  }
  // rank 4
  if (gd <= -8) return 0; if (gd < 0) return 1; return 2;
}

function roundType(round) {
  if (!round) return 'regular';
  const r = round.toLowerCase();
  if (r.includes('third') || r.includes('3rd') || r.includes('place')) return 'third';
  if (r === 'final') return 'final';
  if (r.includes('semi')) return 'semi';
  return 'regular';
}

function knockoutMatchPoints(m, enName) {
  const isHome = m.home === enName;
  const tg = isHome ? m.homeGoals : m.awayGoals;
  const og = isHome ? m.awayGoals : m.homeGoals;
  if (tg === null || og === null) return 0;

  const margin = Math.abs(tg - og);
  const rt     = roundType(m.round);

  let mod = 0, winBonus = 0;
  if (rt === 'semi')  mod = 1;
  if (rt === 'final') { mod = 2; winBonus = 3; }

  if (m.status === 'PEN') {
    const won = isHome ? m.penHome > m.penAway : m.penAway > m.penHome;
    return won ? 4 + mod + winBonus : 3 + mod;
  }
  if (m.status === 'AET') {
    const won = tg > og;
    if (won) return (margin >= 2 ? 6 : 5) + mod + winBonus;
    return 2 + mod;
  }
  // FT
  const won = tg > og;
  if (won) return (margin >= 3 ? 8 : 7) + mod + winBonus;
  if (margin >= 3) return 0;
  return 1 + mod;
}

function calcTeamScore(ruName, matches, standings) {
  const enName = RU_TO_EN[ruName];
  if (!enName) return emptyTeamResult(ruName);

  const myMatches  = matches.filter(m => m.home === enName || m.away === enName);
  const done       = myMatches.filter(m => m.status !== 'NS');

  // ── Group stage match points ───────────────────────────────────────────────
  const groupDone = done.filter(m => m.isGroup);
  let groupMatchPts = 0;
  for (const m of groupDone) {
    const isHome = m.home === enName;
    const [g1, g2] = m.ftGoals || [m.homeGoals, m.awayGoals];
    if (g1 === null) continue;
    const tg = isHome ? g1 : g2;
    const og = isHome ? g2 : g1;
    if (tg > og)     groupMatchPts += 3;
    else if (tg === og) groupMatchPts += 1;
  }

  // ── Group position bonus ──────────────────────────────────────────────────
  const standing     = standings[enName] || null;
  let groupPosPts    = 0;
  let groupComplete  = false;
  if (standing && standing.played >= 3) {
    groupComplete = true;
    groupPosPts   = groupPositionBonus(standing.rank, standing.gd);
  }

  // ── Knockout stage ────────────────────────────────────────────────────────
  const knockDone = done.filter(m => !m.isGroup);
  const qualPts   = knockDone.length > 0 ? 1 : 0;
  let knockPts    = 0;
  for (const m of knockDone) knockPts += knockoutMatchPoints(m, enName);

  const total = groupMatchPts + groupPosPts + qualPts + knockPts;

  return {
    name: ruName,
    flag: TEAM_FLAGS[ruName] || '🏳️',
    total,
    breakdown: {
      groupMatches:    groupMatchPts,
      groupPosition:   groupPosPts,
      groupComplete,
      playoffQual:     qualPts,
      knockoutMatches: knockPts,
    },
    standing: standing ? {
      rank:         standing.rank,
      group:        standing.group,
      played:       standing.played,
      won:          standing.won,
      drawn:        standing.drawn,
      lost:         standing.lost,
      goalsFor:     standing.gf,
      goalsAgainst: standing.ga,
      goalsDiff:    standing.gd,
      tablePoints:  standing.pts,
      form:  null, // not available from openfootball
      logo:  null, // not available from openfootball
    } : null,
    recentFixtures: done.map(m => ({
      date:      m.date,
      round:     m.round,
      home:      m.home,
      away:      m.away,
      homeGoals: m.homeGoals,
      awayGoals: m.awayGoals,
      status:    m.status,
      penHome:   m.penHome,
      penAway:   m.penAway,
    })).sort((a, b) => new Date(b.date) - new Date(a.date)),
    upcomingFixtures: myMatches
      .filter(m => m.status === 'NS')
      .map(m => ({ date: m.date, round: m.round, home: m.home, away: m.away }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 3),
  };
}

function emptyTeamResult(ruName) {
  return {
    name: ruName, flag: TEAM_FLAGS[ruName] || '🏳️', total: 0,
    breakdown: { groupMatches: 0, groupPosition: 0, groupComplete: false, playoffQual: 0, knockoutMatches: 0 },
    standing: null, recentFixtures: [], upcomingFixtures: [],
  };
}

// ─── MAIN DATA PIPELINE ───────────────────────────────────────────────────────
async function fetchTournamentData() {
  if (DATA_SOURCE === 'football-data') {
    const { matches, standings } = await fetchFootballData();
    return { matches, standings, source: 'football-data.org' };
  }
  // Default: openfootball (no API key, no rate limits)
  const matches   = await fetchOpenfootball();
  const standings = computeGroupStandings(matches);
  return { matches, standings, source: 'openfootball' };
}

// ─── EXPRESS ROUTES ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const { matches, standings, source } = await fetchTournamentData();

    const allRuTeams = Object.keys(RU_TO_EN);
    const teamScores = {};
    for (const t of allRuTeams) {
      teamScores[t] = calcTeamScore(t, matches, standings);
    }

    const leaderboard = PARTICIPANTS.map(p => {
      let total = 0;
      const details = {};
      for (const t of p.teams) {
        const ts = teamScores[t] || emptyTeamResult(t);
        total += ts.total;
        details[t] = ts;
      }
      return { name: p.name, teams: p.teams, total, details };
    });

    leaderboard.sort((a, b) => b.total - a.total);
    let rank = 1;
    for (let i = 0; i < leaderboard.length; i++) {
      if (i > 0 && leaderboard[i].total < leaderboard[i - 1].total) rank = i + 1;
      leaderboard[i].rank = rank;
    }

    const totalFixtures    = matches.length;
    const finishedFixtures = matches.filter(m => m.status !== 'NS').length;
    const tournamentStarted = totalFixtures > 0;

    res.json({
      ok: true,
      updatedAt: new Date().toISOString(),
      dataSource: source,
      leaderboard,
      teamScores,
      totalFixtures,
      finishedFixtures,
      tournamentStarted,
    });
  } catch (err) {
    console.error('[/api/data]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Сервер: http://localhost:${PORT}  [источник: ${DATA_SOURCE}]`));
