'use strict';

const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const API_KEY      = process.env.API_KEY      || 'a5037427d9769ab2ff789fa24211c90b';
const API_BASE     = process.env.API_BASE     || 'https://v3.football.api-sports.io';
const WC_SEASON    = parseInt(process.env.WC_SEASON    || '2026', 10);
const WC_LEAGUE_ID = parseInt(process.env.WC_LEAGUE_ID || '1',    10); // FIFA WC is always ID=1

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

const EN_TO_RU = Object.fromEntries(Object.entries(RU_TO_EN).map(([r, e]) => [e, r]));

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
const cache = new Map();
// 30 min TTL → 2 API calls per refresh × 48 refreshes/day = 96 calls/day (≤ 100 free plan limit)
const CACHE_TTL = 30 * 60 * 1000;

async function apiCall(endpoint) {
  const url = `${API_BASE}${endpoint}`;
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && now - cached.time < CACHE_TTL) return cached.data;

  console.log(`[API →] ${endpoint}`);
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });

  // Some proxies/CDNs return plain text errors with HTTP 200 (e.g. "Host not in allowlist")
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  // API-Football signals errors inside the body with HTTP 200
  // e.g. {"errors":{"token":"Error/Missing application token"},"response":[]}
  if (data.errors && Object.keys(data.errors).length > 0) {
    const msg = Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
    throw new Error(`API-Football: ${msg}`);
  }

  console.log(`[API ✓] ${endpoint} — ${(data.response || []).length} items`);
  cache.set(url, { data, time: now });
  return data;
}

// ─── SCORE CALCULATION ────────────────────────────────────────────────────────
function isGroupRound(round) {
  if (!round) return false;
  const r = round.toLowerCase();
  return r.includes('group') || r.startsWith('group');
}

function isFinished(fixture) {
  const s = fixture.fixture.status.short;
  return s === 'FT' || s === 'AET' || s === 'PEN';
}

function teamInFixture(fixture, englishName) {
  return fixture.teams.home.name === englishName ||
         fixture.teams.away.name === englishName;
}

function groupMatchPoints(fixture, englishName) {
  const isHome = fixture.teams.home.name === englishName;
  const hg = fixture.goals.home;
  const ag = fixture.goals.away;
  if (hg === null || ag === null) return 0;
  if (hg === ag) return 1;
  return (isHome ? hg > ag : ag > hg) ? 3 : 0;
}

function groupPositionBonus(rank, gd) {
  if (rank === 1) {
    if (gd <= 3)  return 9;
    if (gd <= 8)  return 10;
    return 11;
  }
  if (rank === 2) {
    if (gd <= 2)  return 6;
    if (gd <= 7)  return 7;
    return 8;
  }
  if (rank === 3) {
    if (gd < 0)   return 3;
    if (gd <= 3)  return 4;
    return 5;
  }
  // rank === 4
  if (gd <= -8)  return 0;
  if (gd < 0)   return 1;
  return 2;
}

function roundType(round) {
  if (!round) return 'regular';
  const r = round.toLowerCase();
  if (r.includes('final') && (r.includes('3rd') || r.includes('third') || r.includes('place'))) return 'third';
  if (r === 'final') return 'final';
  if (r.includes('semi')) return 'semi';
  return 'regular';
}

function knockoutMatchPoints(fixture, englishName) {
  const isHome = fixture.teams.home.name === englishName;
  const status = fixture.fixture.status.short;
  const hg = fixture.goals.home;
  const ag = fixture.goals.away;
  if (hg === null || ag === null) return 0;

  const teamGoals = isHome ? hg : ag;
  const oppGoals  = isHome ? ag : hg;
  const margin    = Math.abs(hg - ag);
  const rt        = roundType(fixture.league.round);

  // modifiers
  let mod = 0;
  let winBonus = 0;
  if (rt === 'semi')  mod = 1;
  if (rt === 'final') { mod = 2; winBonus = 3; }

  if (status === 'PEN') {
    const ph = fixture.score?.penalty?.home ?? 0;
    const pa = fixture.score?.penalty?.away ?? 0;
    const won = isHome ? ph > pa : pa > ph;
    return won ? 4 + mod + winBonus : 3 + mod;
  }

  if (status === 'AET') {
    const won = teamGoals > oppGoals;
    if (won) return (margin >= 2 ? 6 : 5) + mod + winBonus;
    return 2 + mod;
  }

  // FT
  const won = teamGoals > oppGoals;
  if (won) return (margin >= 3 ? 8 : 7) + mod + winBonus;
  if (margin >= 3) return 0; // big loss — always 0
  return 1 + mod;
}

function calcTeamScore(ruName, fixtures, standingsResponse) {
  const enName = RU_TO_EN[ruName];
  if (!enName) return emptyTeamResult(ruName);

  const done = fixtures.filter(isFinished);

  // ── Group stage ──────────────────────────────────────
  const groupFixtures = done.filter(f => isGroupRound(f.league.round) && teamInFixture(f, enName));
  let groupMatchPts = 0;
  for (const f of groupFixtures) groupMatchPts += groupMatchPoints(f, enName);

  // find standing
  let standing = null;
  for (const s of standingsResponse) {
    for (const group of (s.league.standings || [])) {
      const entry = group.find(e => e.team.name === enName);
      if (entry) { standing = entry; break; }
    }
    if (standing) break;
  }

  let groupPosPts = 0;
  let groupComplete = false;
  if (standing && standing.all.played >= 3) {
    groupComplete = true;
    groupPosPts = groupPositionBonus(standing.rank, standing.goalsDiff);
  }

  // ── Knockout stage ───────────────────────────────────
  const knockFixtures = done.filter(f => !isGroupRound(f.league.round) && teamInFixture(f, enName));
  let qualPts = knockFixtures.length > 0 ? 1 : 0;
  let knockPts = 0;
  for (const f of knockFixtures) knockPts += knockoutMatchPoints(f, enName);

  const total = groupMatchPts + groupPosPts + qualPts + knockPts;

  return {
    name: ruName,
    flag: TEAM_FLAGS[ruName] || '🏳️',
    total,
    breakdown: {
      groupMatches:   groupMatchPts,
      groupPosition:  groupPosPts,
      groupComplete,
      playoffQual:    qualPts,
      knockoutMatches: knockPts,
    },
    standing: standing ? {
      rank:         standing.rank,
      group:        standing.group,
      played:       standing.all.played,
      won:          standing.all.win,
      drawn:        standing.all.draw,
      lost:         standing.all.lose,
      goalsFor:     standing.all.goals.for,
      goalsAgainst: standing.all.goals.against,
      goalsDiff:    standing.goalsDiff,
      tablePoints:  standing.points,
      form:         standing.form,
      logo:         standing.team.logo,
    } : null,
    recentFixtures: groupFixtures.concat(knockFixtures).map(f => ({
      date:       f.fixture.date,
      round:      f.league.round,
      home:       f.teams.home.name,
      away:       f.teams.away.name,
      homeGoals:  f.goals.home,
      awayGoals:  f.goals.away,
      status:     f.fixture.status.short,
      penHome:    f.score?.penalty?.home ?? null,
      penAway:    f.score?.penalty?.away ?? null,
      homeLogo:   f.teams.home.logo,
      awayLogo:   f.teams.away.logo,
    })).sort((a, b) => new Date(b.date) - new Date(a.date)),
    upcomingFixtures: fixtures
      .filter(f => !isFinished(f) && teamInFixture(f, enName))
      .map(f => ({
        date:     f.fixture.date,
        round:    f.league.round,
        home:     f.teams.home.name,
        away:     f.teams.away.name,
        homeLogo: f.teams.home.logo,
        awayLogo: f.teams.away.logo,
        status:   f.fixture.status.short,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 3),
  };
}

function emptyTeamResult(ruName) {
  return {
    name: ruName,
    flag: TEAM_FLAGS[ruName] || '🏳️',
    total: 0,
    breakdown: { groupMatches: 0, groupPosition: 0, groupComplete: false, playoffQual: 0, knockoutMatches: 0 },
    standing: null,
    recentFixtures: [],
    upcomingFixtures: [],
  };
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const [fixturesRes, standingsRes] = await Promise.all([
      apiCall(`/fixtures?league=${WC_LEAGUE_ID}&season=${WC_SEASON}`),
      apiCall(`/standings?league=${WC_LEAGUE_ID}&season=${WC_SEASON}`),
    ]);

    const fixtures  = fixturesRes.response  || [];
    const standings = standingsRes.response || [];

    // calc all tracked team scores
    const allRuTeams = Object.keys(RU_TO_EN);
    const teamScores = {};
    for (const t of allRuTeams) {
      teamScores[t] = calcTeamScore(t, fixtures, standings);
    }

    // calc participant scores
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

    const totalFixtures    = fixtures.length;
    const finishedFixtures = fixtures.filter(isFinished).length;

    // Detect if tournament hasn't started yet
    const tournamentStarted = totalFixtures > 0;
    let tournamentStartDate = null;
    if (!tournamentStarted) {
      // Use known WC 2026 start date as fallback
      tournamentStartDate = '2026-06-11T00:00:00Z';
    } else {
      const sorted = fixtures.slice().sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
      tournamentStartDate = sorted[0]?.fixture?.date || null;
    }

    res.json({
      ok: true,
      updatedAt: new Date().toISOString(),
      leagueId: WC_LEAGUE_ID,
      leaderboard,
      teamScores,
      totalFixtures,
      finishedFixtures,
      tournamentStarted,
      tournamentStartDate,
    });
  } catch (err) {
    console.error('[/api/data]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Сервер запущен: http://localhost:${PORT}`));
