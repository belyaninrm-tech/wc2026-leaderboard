'use strict';

// ─── STATE ────────────────────────────────────────────────────────────────────
let state = { data: null, loading: false, error: null };
let refreshTimer = null;
let countdownInterval = null;
const REFRESH_INTERVAL = 20 * 60 * 1000; // 20 min — keeps API calls ≤ 96/day on free plan
let nextRefreshAt = null;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) +
    ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatRound(round) {
  if (!round) return '';
  const map = {
    'Group Stage - 1': 'Группа — Тур 1',
    'Group Stage - 2': 'Группа — Тур 2',
    'Group Stage - 3': 'Группа — Тур 3',
    'Round of 32':     '1/16 финала',
    'Round of 16':     '1/8 финала',
    'Quarter-finals':  'Четверть финал',
    'Semi-finals':     'Полуфинал',
    '3rd Place Final': 'Матч за 3-е',
    'Final':           'Финал',
  };
  return map[round] || round;
}

function rankMedal(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return rank;
}

function rankClass(rank) {
  if (rank <= 3) return `rank-${rank}`;
  return '';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function gdColor(gd) {
  if (gd > 0) return 'pos';
  if (gd < 0) return 'neg';
  return 'neut';
}

function gdStr(gd) { return gd > 0 ? `+${gd}` : String(gd); }

// ─── FETCH DATA ───────────────────────────────────────────────────────────────
async function fetchData() {
  if (state.loading) return;
  state.loading = true;
  setLoading(true);

  try {
    const res = await fetch('/api/data');
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Ошибка сервера');
    state.data = json;
    state.error = null;
    $('errorBanner').classList.add('hidden');
    render();
    updateStatusBar(json.updatedAt, json.totalFixtures, json.finishedFixtures);
  } catch (e) {
    state.error = e.message;
    $('errorBanner').classList.remove('hidden');
    // Surface the exact API-Football error message so the user can diagnose
    $('errorText').textContent = '⚠️ Ошибка загрузки данных: ' + e.message +
      '. Проверьте логи сервера (node server.js) для деталей.';
    $('statusText').textContent = 'Ошибка подключения к API';
  } finally {
    state.loading = false;
    setLoading(false);
    scheduleRefresh();
  }
}

function setLoading(on) {
  const btn = $('refreshBtn');
  if (on) btn.classList.add('spinning');
  else btn.classList.remove('spinning');
}

function updateStatusBar(updatedAt, total, finished) {
  const d = updatedAt ? new Date(updatedAt) : new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('statusText').textContent = `Обновлено в ${time} · Матчей: ${finished}/${total} сыграно`;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  clearInterval(countdownInterval);
  nextRefreshAt = Date.now() + REFRESH_INTERVAL;

  countdownInterval = setInterval(() => {
    const diff = Math.max(0, nextRefreshAt - Date.now());
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    $('nextRefresh').textContent = `Следующее обновление через ${mins}:${String(secs).padStart(2, '0')}`;
  }, 1000);

  refreshTimer = setTimeout(() => {
    clearInterval(countdownInterval);
    fetchData();
  }, REFRESH_INTERVAL);
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function render() {
  renderLeaderboard();
  renderTeams();
  renderPreTournamentBanner();
}

const WC_START = new Date('2026-06-11T00:00:00Z');

function renderPreTournamentBanner() {
  const { tournamentStarted, finishedFixtures } = state.data;
  const existing = document.getElementById('tournamentBanner');

  // Show only when API returned no fixtures at all (data not yet loaded into API)
  if (!tournamentStarted) {
    if (!existing) {
      const banner = document.createElement('div');
      banner.id = 'tournamentBanner';
      banner.className = 'pretournament-banner';
      const now = Date.now();
      const started = now >= WC_START.getTime();

      let icon, title, sub;
      if (started) {
        // Tournament is running but API returned no fixture data — probably API plan issue
        icon  = '📡';
        title = 'Данные турнира недоступны';
        sub   = 'ЧМ 2026 уже идёт, но API не вернул данные по матчам. ' +
                'Проверьте логи сервера, доступ к API-Football и тарифный план.';
      } else {
        const diff  = WC_START - now;
        const days  = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        icon  = '⏳';
        title = 'Турнир ещё не начался';
        sub   = `ЧМ 2026 стартует <strong>11 июня 2026</strong> — через ${days} д. ${hours} ч.`;
      }
      banner.innerHTML = `
        <div class="ptb-icon">${icon}</div>
        <div>
          <div class="ptb-title">${title}</div>
          <div class="ptb-sub">${sub}</div>
        </div>`;
      $('leaderboard').insertAdjacentElement('beforebegin', banner);
    }
  } else if (existing) {
    existing.remove();
  }
}

// ── Leaderboard ────────────────────────────────────────────────────────────────
function renderLeaderboard() {
  const { leaderboard } = state.data;
  const container = $('leaderboard');
  container.innerHTML = leaderboard.map(p => `
    <div class="lb-card ${rankClass(p.rank)}" data-name="${escHtml(p.name)}" role="button" tabindex="0">
      <div class="lb-rank">${rankMedal(p.rank)}</div>
      <div>
        <div class="lb-name">${escHtml(p.name)}</div>
        <div class="lb-teams">
          ${p.teams.map(t => {
            const ts = p.details[t];
            return `<span class="team-chip">${ts ? ts.flag : ''} ${escHtml(t)}</span>`;
          }).join('')}
        </div>
      </div>
      <div class="lb-score-wrap">
        <div class="lb-score">${p.total}</div>
        <div class="lb-score-label">очков</div>
      </div>
      <div class="lb-arrow">›</div>
    </div>
  `).join('');

  container.querySelectorAll('.lb-card').forEach(card => {
    const handler = () => openParticipantModal(card.dataset.name);
    card.addEventListener('click', handler);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') handler(); });
  });
}

// ── Teams Grid ────────────────────────────────────────────────────────────────
function renderTeams() {
  const { teamScores, leaderboard } = state.data;

  // Build a map: teamName → [participants who picked this team]
  const teamOwners = {};
  for (const p of leaderboard) {
    for (const t of p.teams) {
      if (!teamOwners[t]) teamOwners[t] = [];
      teamOwners[t].push(p.name);
    }
  }

  const grid = $('teamsGrid');
  const teams = Object.values(teamScores).sort((a, b) => b.total - a.total);

  grid.innerHTML = teams.map(ts => {
    const s = ts.standing;
    const owners = (teamOwners[ts.name] || []).join(', ');

    const standingHtml = s ? `
      <div class="tc-standing">
        <div><div class="tc-stat-label">Место</div><div class="tc-stat-val ${s.rank === 1 ? 'pos' : s.rank <= 2 ? 'neut' : 'neg'}">${s.rank}</div></div>
        <div><div class="tc-stat-label">И</div><div class="tc-stat-val neut">${s.played}</div></div>
        <div><div class="tc-stat-label">О</div><div class="tc-stat-val neut">${s.tablePoints}</div></div>
        <div><div class="tc-stat-label">Г</div><div class="tc-stat-val neut">${s.goalsFor}:${s.goalsAgainst}</div></div>
        <div><div class="tc-stat-label">РМ</div><div class="tc-stat-val ${gdColor(s.goalsDiff)}">${gdStr(s.goalsDiff)}</div></div>
      </div>
      ${s.form ? `<div class="tc-form">${s.form.split('').slice(-5).map(c =>
        `<div class="form-dot ${c}">${c}</div>`).join('')}</div>` : ''}
      <div class="standing-bar">
        ${s.group ? `<span>📍 ${escHtml(s.group)}</span>` : ''}
      </div>` : '<div class="no-data">Данные групп пока недоступны</div>';

    const recentHtml = ts.recentFixtures.slice(0, 4).map(f => {
      const isHome = f.home === (Object.entries({
        'Франция':'France','Аргентина':'Argentina','Бразилия':'Brazil',
        'Испания':'Spain','Норвегия':'Norway','Англия':'England',
        'Португалия':'Portugal','Германия':'Germany','Шотландия':'Scotland',
        'Узбекистан':'Uzbekistan'
      }).find(([, v]) => v === f.home || v === f.away)?.[0] || '') ;
      const teamEn = Object.entries({
        'Франция':'France','Аргентина':'Argentina','Бразилия':'Brazil',
        'Испания':'Spain','Норвегия':'Norway','Англия':'England',
        'Португалия':'Portugal','Германия':'Germany','Шотландия':'Scotland',
        'Узбекистан':'Uzbekistan'
      }).find(([ruName]) => ruName === ts.name)?.[1] || ts.name;

      const won  = (f.home === teamEn && f.homeGoals > f.awayGoals) ||
                   (f.away === teamEn && f.awayGoals > f.homeGoals);
      const lost = (f.home === teamEn && f.homeGoals < f.awayGoals) ||
                   (f.away === teamEn && f.awayGoals < f.homeGoals);
      const scoreClass = won ? 'win' : lost ? 'loss' : 'draw';

      const penStr = f.status === 'PEN' && f.penHome !== null
        ? ` <span class="status-pen">(пен. ${f.penHome}:${f.penAway})</span>` : '';
      const aetStr = f.status === 'AET' ? ` <span class="status-aet">(доп.)</span>` : '';

      const homeRu = Object.entries({
        'France':'Франция','Argentina':'Аргентина','Brazil':'Бразилия',
        'Spain':'Испания','Norway':'Норвегия','England':'Англия',
        'Portugal':'Португалия','Germany':'Германия','Scotland':'Шотландия',
        'Uzbekistan':'Узбекистан'
      }).find(([en]) => en === f.home)?.[1] || f.home;
      const awayRu = Object.entries({
        'France':'Франция','Argentina':'Аргентина','Brazil':'Бразилия',
        'Spain':'Испания','Norway':'Норвегия','England':'Англия',
        'Portugal':'Португалия','Germany':'Германия','Scotland':'Шотландия',
        'Uzbekistan':'Узбекистан'
      }).find(([en]) => en === f.away)?.[1] || f.away;

      return `<div class="fixture-item">
        <div class="fixture-teams">
          <span>${escHtml(homeRu)}</span>
          <span style="color:var(--muted)">–</span>
          <span>${escHtml(awayRu)}</span>
        </div>
        <div class="fixture-score ${scoreClass}">${f.homeGoals}:${f.awayGoals}${aetStr}${penStr}</div>
        <div class="fixture-round">${escHtml(formatRound(f.round))}</div>
      </div>`;
    }).join('');

    const logoHtml = s?.logo ? `<img class="tc-logo" src="${escHtml(s.logo)}" alt="" loading="lazy">` : '';

    const upcomingHtml = ts.upcomingFixtures.length > 0 ? `
      <div class="tc-upcoming">
        <div style="font-size:.72rem;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Ближайшие матчи</div>
        ${ts.upcomingFixtures.map(f => {
          const homeRu = Object.entries({
            'France':'Франция','Argentina':'Аргентина','Brazil':'Бразилия',
            'Spain':'Испания','Norway':'Норвегия','England':'Англия',
            'Portugal':'Португалия','Germany':'Германия','Scotland':'Шотландия',
            'Uzbekistan':'Узбекистан'
          }).find(([en]) => en === f.home)?.[1] || f.home;
          const awayRu = Object.entries({
            'France':'Франция','Argentina':'Аргентина','Brazil':'Бразилия',
            'Spain':'Испания','Norway':'Норвегия','England':'Англия',
            'Portugal':'Португалия','Germany':'Германия','Scotland':'Шотландия',
            'Uzbekistan':'Узбекистан'
          }).find(([en]) => en === f.away)?.[1] || f.away;
          return `<div class="upcoming-item">
            <span>${escHtml(homeRu)} — ${escHtml(awayRu)}</span>
            <span>${formatDate(f.date)}</span>
          </div>`;
        }).join('')}
      </div>` : '';

    return `
    <div class="team-card">
      <div class="tc-header">
        <div class="tc-flag">${ts.flag}</div>
        ${logoHtml}
        <div class="tc-name">${escHtml(ts.name)}</div>
        <div class="tc-pts">${ts.total}</div>
      </div>
      ${standingHtml}
      ${recentHtml ? `<div class="fixture-list">${recentHtml}</div>` : ''}
      ${upcomingHtml}
      <div class="tc-participants">
        <strong>Участники:</strong> ${escHtml(owners || '—')}
      </div>
    </div>`;
  }).join('');
}

// ─── PARTICIPANT MODAL ────────────────────────────────────────────────────────
const EN_RU_MAP = {
  'France':'Франция','Argentina':'Аргентина','Brazil':'Бразилия',
  'Spain':'Испания','Norway':'Норвегия','England':'Англия',
  'Portugal':'Португалия','Germany':'Германия','Scotland':'Шотландия',
  'Uzbekistan':'Узбекистан'
};

function openParticipantModal(name) {
  if (!state.data) return;
  const p = state.data.leaderboard.find(x => x.name === name);
  if (!p) return;

  $('pModalTitle').textContent = p.name;

  const teamsHtml = p.teams.map(teamName => {
    const ts = p.details[teamName];
    if (!ts) return '';
    const s = ts.standing;
    const b = ts.breakdown;

    const recentHtml = ts.recentFixtures.slice(0, 5).map(f => {
      const teamEn = Object.entries({
        'Франция':'France','Аргентина':'Argentina','Бразилия':'Brazil',
        'Испания':'Spain','Норвегия':'Norway','Англия':'England',
        'Португалия':'Portugal','Германия':'Germany','Шотландия':'Scotland',
        'Узбекистан':'Uzbekistan'
      }).find(([ru]) => ru === teamName)?.[1] || teamName;

      const won  = (f.home === teamEn && f.homeGoals > f.awayGoals) ||
                   (f.away === teamEn && f.awayGoals > f.homeGoals);
      const lost = (f.home === teamEn && f.homeGoals < f.awayGoals) ||
                   (f.away === teamEn && f.awayGoals < f.homeGoals);
      const scoreClass = won ? 'win' : lost ? 'loss' : 'draw';
      const homeRu = EN_RU_MAP[f.home] || f.home;
      const awayRu = EN_RU_MAP[f.away] || f.away;
      const penStr = f.status === 'PEN' && f.penHome !== null
        ? ` <span class="status-pen">(пен. ${f.penHome}:${f.penAway})</span>` : '';
      const aetStr = f.status === 'AET' ? ` <span class="status-aet">(доп.)</span>` : '';

      return `<div class="fixture-item">
        <div class="fixture-teams">
          <span>${escHtml(homeRu)}</span>
          <span style="color:var(--muted)">–</span>
          <span>${escHtml(awayRu)}</span>
        </div>
        <div class="fixture-score ${scoreClass}">${f.homeGoals}:${f.awayGoals}${aetStr}${penStr}</div>
        <div class="fixture-round">${escHtml(formatRound(f.round))}</div>
      </div>`;
    }).join('');

    return `
    <div class="tb-row">
      <div class="tb-row-header">
        <div class="tb-flag">${ts.flag}</div>
        <div class="tb-team-name">${escHtml(teamName)}</div>
        <div class="tb-total">${ts.total} <span style="font-size:.8rem;color:var(--muted)">очков</span></div>
      </div>
      <div class="tb-scores">
        <div class="tb-score-item">
          <span class="label">Матчи (группа)</span>
          <span class="val">${b.groupMatches}</span>
        </div>
        <div class="tb-score-item">
          <span class="label">Место в группе${b.groupComplete ? '' : ' *'}</span>
          <span class="val">${b.groupPosition}</span>
        </div>
        <div class="tb-score-item">
          <span class="label">Выход в плей-офф</span>
          <span class="val">${b.playoffQual}</span>
        </div>
        <div class="tb-score-item">
          <span class="label">Матчи (плей-офф)</span>
          <span class="val">${b.knockoutMatches}</span>
        </div>
      </div>
      ${s ? `<div class="standing-bar">
        <span>📍 ${escHtml(s.group || '')}</span>
        <span>Место: <strong>${s.rank}</strong></span>
        <span>${s.played} матч.</span>
        <span>${s.won}П ${s.drawn}Н ${s.lost}П</span>
        <span>РМ: <strong class="${gdColor(s.goalsDiff)}">${gdStr(s.goalsDiff)}</strong></span>
      </div>` : ''}
      ${!b.groupComplete && s ? '<div style="font-size:.72rem;color:var(--muted);margin-top:4px">* Бонус за место в группе будет начислен после завершения группового этапа</div>' : ''}
      ${recentHtml ? `<div class="fixture-list" style="margin-top:8px">${recentHtml}</div>` : '<div class="no-data">Матчи ещё не сыграны</div>'}
    </div>`;
  }).join('');

  $('pModalBody').innerHTML = `
    <div class="pm-header">
      <div>
        <div class="pm-name">${escHtml(p.name)}</div>
        <div style="font-size:.8rem;color:var(--muted)">
          ${p.teams.map(t => (p.details[t]?.flag || '') + ' ' + t).join(' · ')}
        </div>
      </div>
      <div class="pm-total-wrap">
        <div class="pm-total-label">Итого очков</div>
        <div class="pm-total">${p.total}</div>
      </div>
    </div>
    <div class="team-breakdown">${teamsHtml}</div>
  `;

  $('participantModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeParticipantModal() {
  $('participantModal').classList.remove('open');
  document.body.style.overflow = '';
}

// ─── TABS ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ─── MODAL CONTROLS ──────────────────────────────────────────────────────────
$('rulesBtn').addEventListener('click', () => {
  $('rulesModal').classList.add('open');
  document.body.style.overflow = 'hidden';
});

function closeRules() {
  $('rulesModal').classList.remove('open');
  document.body.style.overflow = '';
}

$('closeRules').addEventListener('click', closeRules);
$('modalOverlay').addEventListener('click', closeRules);
$('closePModal').addEventListener('click', closeParticipantModal);
$('pModalOverlay').addEventListener('click', closeParticipantModal);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeRules(); closeParticipantModal(); }
});

$('refreshBtn').addEventListener('click', () => {
  clearTimeout(refreshTimer);
  clearInterval(countdownInterval);
  fetchData();
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
fetchData();
