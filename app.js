/* =============================================================
   Saturdays Fantasy - the league, the draft room and the season.

   The rendering here is the prototype's, unchanged. What changed is
   where the state lives: picks, rosters, lineups and results are rows
   in the database rather than variables in one browser, and every
   pick goes through make_pick so the server, not the page, decides
   whose turn it is.
   ============================================================= */
(function(){
  "use strict";
  var Pool = window.SFPool, R = window.SFRoster;

  /* ---- names the ported code expects ------------------------------------ */
  var PLAYERS = Pool.PLAYERS, P = Pool.P;
  var POSITIONS = Pool.POSITIONS, FLEX_POS = Pool.FLEX_POS;
  var flexOk = Pool.flexOk, fits = Pool.fits, points = Pool.points;
  var statText = Pool.statText, projOf = Pool.projOf;
  var esc = Pool.esc, r1 = Pool.r1, mmss = Pool.mmss, hash = Pool.hash, rng = Pool.rng;
  function el(id){ return document.getElementById(id); }
  var $ = el;                     /* the settings panel was written against $ */
  function statLine(p, w){ return Pool.statLine(p, w, cfg.seed || 1); }
  function weekPts(pid, w){ return Pool.weekPts(pid, w, cfg.seed || 1); }

  /* ---- league state, mirrored from the database ------------------------- */
  var sb = null, me = null, profile = null, LG = null, TEAMS = [], ME = 0, skew = 0;
  var chPicks = null, chLeague = null, chTeams = null, chResults = null;
  var inflight = false, lastSaved = "", booted = false;

  var BOARD_LENGTH = 6;           /* how many upcoming picks the board shows */

  var cfg = {teams:10, slots:{QB:1,RB:2,WR:2,TE:1,K:1,DEF:1}, flex:1, bench:4,
             secs:60, weeks:10, playoff:4, seed:1, order:[]};
  var SLOTS = [];

  function serverNow(){ return Date.now() + skew; }
  function slotList(){ return R.slotList(cfg); }
  function starterTotal(){ return R.starterTotal(cfg); }
  function rosterSize(){ return R.rosterSize(cfg); }
  function totalPicks(){ return cfg.teams * rosterSize(); }
  function team(i){
    var t = TEAMS[i];
    return t ? {name:t.name, abbr:t.abbr} : {name:"Team " + (i+1), abbr:"T" + (i+1)};
  }
  function isCpu(i){ return !!TEAMS[i] && !TEAMS[i].owner; }
  function playoffRounds(){ return Math.round(Math.log(cfg.playoff) / Math.log(2)); }
  function totalWeeks(){ return cfg.weeks + playoffRounds(); }
  function isPlayoffWeek(w){ return w > cfg.weeks; }
  function amCommish(){ return !!(LG && me && LG.commissioner === me.id); }

  /* ---- roster views the ported code expects ----------------------------- */
  function takenMap(){
    var t = {};
    picks.forEach(function(p){ t[p.pid] = 1; });
    rosters.forEach(function(r){ (r||[]).forEach(function(k){ t[k] = 1; }); });
    return t;
  }
  function available(){ return R.available(takenMap()); }
  function draftRosterOf(t){
    return picks.filter(function(p){ return p.team === t; })
                .map(function(p){ return {player:P(p.pid), auto:p.auto, key:p.pid}; });
  }
  function draftKeysOf(t){
    return picks.filter(function(p){ return p.team === t; }).map(function(p){ return p.pid; });
  }
  function rosterSlots(t){ return R.slotWalk(cfg, draftKeysOf(t)); }
  function fillFor(t){ return R.fillFor(cfg, draftKeysOf(t)); }
  function countsFor(t){ return R.countsFor(cfg, draftKeysOf(t)); }
  function cpuPickId(t, pickNo){
    return R.cpuPickKey(cfg, {teamIndex:t, pickNo:pickNo, nteams:cfg.teams,
                              taken:takenMap(), roster:draftKeysOf(t)});
  }
  function autoPickId(t){
    return R.autoPickKey(cfg, {teamIndex:t, pickNo:picks.length + 1, nteams:cfg.teams,
                               taken:takenMap(), roster:draftKeysOf(t)});
  }
  function bestLineup(t, w, by){ return R.bestLineup(cfg, rosters[t] || [], w, by); }
  function lineupPts(line, w){ return R.lineupPts(cfg, line, w); }
  function lineupProj(line){ return R.lineupProj(line); }
  function buildProfiles(){ /* profiles are derived from the seed on demand */ }

  function say(text, bad){
    var box = el("msg");
    if (!box) return;
    box.innerHTML = text ? '<div class="msg ' + (bad ? "bad" : "ok") + '"></div>' : "";
    if (text) box.firstChild.textContent = text;
  }

  /* =========================================================
     Database <-> the state the rendering expects
     ========================================================= */
  function applyLeague(row){
    LG = row;
    var s = row.settings || {};
    ["teams","flex","bench","secs","weeks","playoff","seed"].forEach(function(k){
      if (s[k] !== undefined && s[k] !== null) cfg[k] = parseInt(s[k], 10);
    });
    cfg.slots = {};
    POSITIONS.forEach(function(p){
      cfg.slots[p] = parseInt((s.slots || {})[p], 10) || 0;
    });
    SLOTS = slotList();
    week = row.current_week || 1;
    if (viewWeek < 1 || viewWeek > totalWeeks()) viewWeek = week;
  }
  function applyTeams(rows){
    TEAMS = (rows || []).slice().sort(function(a,b){
      return (a.draft_slot || 99) - (b.draft_slot || 99) ||
             String(a.created_at).localeCompare(String(b.created_at));
    });
    cfg.teams = TEAMS.length || cfg.teams;
    cfg.order = TEAMS.map(function(_, i){ return i; });
    ME = Math.max(0, TEAMS.findIndex(function(t){ return me && t.owner === me.id; }));
    rosters = TEAMS.map(function(t){ return (t.roster || []).slice(); });
  }
  function applyPicks(rows){
    var idx = {};
    TEAMS.forEach(function(t, i){ idx[t.id] = i; });
    picks = (rows || []).slice()
      .sort(function(a,b){ return a.pick_no - b.pick_no; })
      .map(function(p){ return {pid:p.player_id, team:idx[p.team_id], auto:p.auto, at:p.created_at}; });
    /* The clock runs from the server's record of the last pick, never from
       this browser's idea of when it happened. */
    var lastAt = rows && rows.length
      ? rows.reduce(function(m,p){ return p.pick_no > m.pick_no ? p : m; }).created_at
      : null;
    var base = lastAt ? Date.parse(lastAt) : (LG.draft_started_at ? Date.parse(LG.draft_started_at) : serverNow());
    deadline = picks.length >= totalPicks() ? 0 : base + cfg.secs * 1000;
    resolving = false;
  }
  function applyResults(rows){
    results = {};
    (rows || []).forEach(function(r){ results[r.week] = r.data; });
    seeds = null;
    if (results[cfg.weeks]){
      seeds = standings().slice(0, cfg.playoff).map(function(r){ return r.i; });
    }
  }

  async function loadAll(){
    var lr = await sb.from("leagues").select("*").limit(1);
    if (lr.error) return say(lr.error.message, true);
    if (!lr.data || !lr.data.length){ LG = null; return; }
    applyLeague(lr.data[0]);
    var tr = await sb.from("teams").select("*").eq("league_id", LG.id);
    if (tr.error) return say(tr.error.message, true);
    applyTeams(tr.data);
    var pr = await sb.from("picks").select("*").eq("league_id", LG.id);
    if (pr.error) return say(pr.error.message, true);
    applyPicks(pr.data);
    var rr = await sb.from("results").select("*").eq("league_id", LG.id);
    if (!rr.error) applyResults(rr.data);
    var lu = await sb.from("lineups").select("*")
                     .eq("team_id", TEAMS[ME] ? TEAMS[ME].id : "00000000-0000-0000-0000-000000000000")
                     .eq("week", week);
    myLineup = (!lu.error && lu.data && lu.data.length && Array.isArray(lu.data[0].slots))
      ? lu.data[0].slots.slice()
      : (rosters[ME] && rosters[ME].length ? bestLineup(ME, week, "proj") : []);
    normaliseLineup();
    lastSaved = JSON.stringify(myLineup);
  }
  async function refreshPicks(){
    var pr = await sb.from("picks").select("*").eq("league_id", LG.id);
    if (pr.error) return;
    applyPicks(pr.data);
    if (picks.length >= totalPicks()){
      var lr = await sb.from("leagues").select("*").eq("id", LG.id).limit(1);
      if (!lr.error && lr.data && lr.data.length) applyLeague(lr.data[0]);
      var tr = await sb.from("teams").select("*").eq("league_id", LG.id);
      if (!tr.error) applyTeams(tr.data);
    }
    route();
  }

  /* A lineup has one entry per starting slot, and only players you own. */
  function normaliseLineup(){
    var own = {}; (rosters[ME] || []).forEach(function(k){ own[k] = 1; });
    var out = [], used = {};
    SLOTS.forEach(function(slot, i){
      var k = myLineup[i];
      var pl = k && P(k);
      if (k && own[k] && !used[k] && pl && fits(slot, pl.pos)){ used[k] = 1; out.push(k); }
      else out.push(null);
    });
    myLineup = out;
    fillEmptySlots();
  }
  async function saveLineup(){
    if (!TEAMS[ME] || !TEAMS[ME].owner || results[week]) return;
    var now = JSON.stringify(myLineup);
    if (now === lastSaved) return;
    lastSaved = now;
    await sb.from("lineups").upsert({
      league_id: LG.id, team_id: TEAMS[ME].id, week: week, slots: myLineup
    }, {onConflict: "team_id,week"});
  }
  async function saveRoster(){
    if (!TEAMS[ME] || !TEAMS[ME].owner) return;
    await sb.from("teams").update({roster: rosters[ME]}).eq("id", TEAMS[ME].id);
  }

  /* =========================================================
     Realtime - a pick, a result or a join redraws every page
     ========================================================= */
  function watch(){
    [chPicks, chLeague, chTeams, chResults].forEach(function(c){ if (c) sb.removeChannel(c); });
    chPicks = sb.channel("p-" + LG.id)
      .on("postgres_changes", {event:"INSERT", schema:"public", table:"picks",
                               filter:"league_id=eq." + LG.id}, function(){ refreshPicks(); })
      .subscribe();
    chLeague = sb.channel("l-" + LG.id)
      .on("postgres_changes", {event:"UPDATE", schema:"public", table:"leagues",
                               filter:"id=eq." + LG.id}, function(p){ applyLeague(p.new); route(); })
      .subscribe();
    chTeams = sb.channel("t-" + LG.id)
      .on("postgres_changes", {event:"*", schema:"public", table:"teams",
                               filter:"league_id=eq." + LG.id}, async function(){
        var tr = await sb.from("teams").select("*").eq("league_id", LG.id);
        if (!tr.error){ applyTeams(tr.data); route(); }
      }).subscribe();
    chResults = sb.channel("r-" + LG.id)
      .on("postgres_changes", {event:"*", schema:"public", table:"results",
                               filter:"league_id=eq." + LG.id}, async function(){
        var rr = await sb.from("results").select("*").eq("league_id", LG.id);
        if (!rr.error){ applyResults(rr.data); route(); }
      }).subscribe();
  }

  /* ---- league settings panel (from the lobby) ---- */
  var dirty = false;
  var DEFAULTS = {
    teams: 10,
    slots: {QB:1, RB:2, WR:2, TE:1, K:1, DEF:1},
    flex: 1,
    bench: 4,
    secs: 60,
    weeks: 10,
    playoff: 4
  };

  var GROUPS = [
    {title:"League", fields:[
      {key:"teams", label:"Teams", min:2, max:16, hint:"Managers, including you"}
    ]},
    {title:"Starting lineup", fields:[
      {key:"slots.QB",  label:"QB",   min:0, max:3},
      {key:"slots.RB",  label:"RB",   min:0, max:6},
      {key:"slots.WR",  label:"WR",   min:0, max:6},
      {key:"slots.TE",  label:"TE",   min:0, max:3},
      {key:"flex",      label:"FLEX", min:0, max:4, hint:"RB, WR or TE"},
      {key:"slots.K",   label:"K",    min:0, max:2},
      {key:"slots.DEF", label:"DEF",  min:0, max:2, hint:"A whole team's defense"}
    ]},
    {title:"Bench", fields:[
      {key:"bench", label:"Bench spots", min:0, max:10, hint:"Any position"}
    ]},
    {title:"Draft", fields:[
      {key:"secs", label:"Pick clock", min:15, max:600, step:15, hint:"Seconds per pick"}
    ]},
    {title:"Season", fields:[
      {key:"weeks",   label:"Weeks",        min:4, max:15, hint:"Regular season"},
      {key:"playoff", label:"Playoff teams", min:2, max:8, hint:"2, 4 or 8"}
    ]}
  ];

  function getPath(obj, path){
    return path.split(".").reduce(function(o, k){ return o == null ? o : o[k]; }, obj);
  }
  function setPath(obj, path, val){
    var parts = path.split("."), last = parts.pop();
    var t = parts.reduce(function(o, k){ if (o[k] == null) o[k] = {}; return o[k]; }, obj);
    t[last] = val;
  }
  function fieldId(key){ return "f-" + key.replace(/\./g, "-"); }

  /* Whatever is stored, filled in with defaults for anything missing. */
  function currentCfg(){
    var s = (LG && LG.settings) || {};
    var out = {
      teams:   num(s.teams,   DEFAULTS.teams),
      flex:    num(s.flex,    DEFAULTS.flex),
      bench:   num(s.bench,   DEFAULTS.bench),
      secs:    num(s.secs,    DEFAULTS.secs),
      weeks:   num(s.weeks,   DEFAULTS.weeks),
      playoff: num(s.playoff, DEFAULTS.playoff),
      slots:   {}
    };
    var src = s.slots || {};
    Object.keys(DEFAULTS.slots).forEach(function(p){
      out.slots[p] = num(src[p], DEFAULTS.slots[p]);
    });
    return out;
  }
  function num(v, fallback){
    var n = parseInt(v, 10);
    return isNaN(n) ? fallback : n;
  }

  function panelStarters(cfg){
    return Object.keys(cfg.slots).reduce(function(s, p){ return s + cfg.slots[p]; }, 0) + cfg.flex;
  }
  function panelRosterSize(cfg){ return panelStarters(cfg) + cfg.bench; }

  var built = false;
  function buildSettings(){
    if (built) return;
    var host = $("setgrid");
    host.innerHTML = "";
    GROUPS.forEach(function(g){
      var box = document.createElement("div");
      box.className = "grp";
      var h = document.createElement("h3");
      h.textContent = g.title;
      box.appendChild(h);
      var flds = document.createElement("div");
      flds.className = "flds";
      g.fields.forEach(function(f){
        var d = document.createElement("div");
        d.className = "fld";
        var lab = document.createElement("label");
        lab.setAttribute("for", fieldId(f.key));
        lab.textContent = f.label;
        var inp = document.createElement("input");
        inp.type = "number";
        inp.id = fieldId(f.key);
        inp.min = f.min; inp.max = f.max;
        inp.step = f.step || 1;
        inp.addEventListener("input", function(){ dirty = true; renderDerived(readForm()); });
        d.appendChild(lab); d.appendChild(inp);
        if (f.hint){
          var hint = document.createElement("span");
          hint.className = "hint";
          hint.textContent = f.hint;
          d.appendChild(hint);
        }
        flds.appendChild(d);
      });
      box.appendChild(flds);
      host.appendChild(box);
    });
    built = true;
  }

  /* Read the form back out, clamped to something the draft can actually run. */
  function readForm(){
    var cfg = currentCfg();
    GROUPS.forEach(function(g){
      g.fields.forEach(function(f){
        var inp = $(fieldId(f.key));
        var v = num(inp.value, getPath(cfg, f.key));
        v = Math.max(f.min, Math.min(f.max, v));
        setPath(cfg, f.key, v);
      });
    });
    /* A bracket has to be a power of two, and can't invite more teams than exist. */
    var choices = [2, 4, 8].filter(function(n){ return n <= cfg.teams; });
    if (!choices.length) choices = [2];
    var want = cfg.playoff;
    cfg.playoff = choices.reduce(function(best, n){
      return Math.abs(n - want) < Math.abs(best - want) ? n : best;
    }, choices[0]);
    return cfg;
  }

  function writeForm(cfg){
    GROUPS.forEach(function(g){
      g.fields.forEach(function(f){
        $(fieldId(f.key)).value = getPath(cfg, f.key);
      });
    });
  }

  function renderDerived(cfg){
    var st = panelStarters(cfg), size = panelRosterSize(cfg);
    $("derived").innerHTML =
      "Each team starts <b>" + st + "</b> and carries <b>" + cfg.bench + "</b> on the bench, " +
      "so every roster is <b>" + size + "</b> players and the draft runs <b>" +
      (size * cfg.teams) + "</b> picks over <b>" + size + "</b> rounds. " +
      "Regular season <b>" + cfg.weeks + "</b> weeks, then <b>" + cfg.playoff +
      "</b> teams in the playoff.";
  }

  function renderSettings(){
    if (!LG) return;
    buildSettings();
    var cfg = currentCfg();
    writeForm(cfg);
    renderDerived(cfg);

    var commish = amCommish();
    var openStill = LG.phase === "setup";
    var editable = commish && openStill;

    GROUPS.forEach(function(g){
      g.fields.forEach(function(f){ $(fieldId(f.key)).disabled = !editable; });
    });
    show("set-actions", editable);
    show("set-locked", !editable);

    $("set-note").textContent = commish
      ? (openStill
          ? "You're the commissioner. Change anything you like while you're waiting on friends — " +
            "everyone's page updates as you save. These lock when the draft starts."
          : "The draft has started, so the rules are locked in.")
      : "Set by the commissioner. You'll see changes here as they're made.";

    $("set-locked").textContent = commish
      ? "" : "Only the commissioner can change these.";
  }

  function flashSaved(){
    show("saved-note", true);
    setTimeout(function(){ show("saved-note", false); }, 1800);
  }

  /* ---- schedule ---- */
  /* ==========================================================
     SCHEDULE — circle-method round robin, any team count.
     With an odd number of teams one team sits out each week.
     ========================================================== */
  function weekPairs(w){
    var T = cfg.teams, arr = [];
    for (var i = 0; i < T; i++) arr.push(i);
    if (T % 2 === 1) arr.push(-1);
    var m = arr.length, fixed = arr[0], rest = arr.slice(1);
    var rot = (w - 1) % (m - 1);
    rest = rest.slice(rot).concat(rest.slice(0, rot));
    var order = [fixed].concat(rest), out = [];
    for (var k = 0; k < m / 2; k++){
      var a = order[k], b = order[m - 1 - k];
      if (a === -1 || b === -1) continue;
      out.push(w % 2 === 0 ? [b, a] : [a, b]);
    }
    return out;
  }
  function byeTeam(w){
    if (cfg.teams % 2 === 0) return -1;
    var seen = {};
    weekPairs(w).forEach(function(m){ seen[m[0]] = 1; seen[m[1]] = 1; });
    for (var i = 0; i < cfg.teams; i++) if (!seen[i]) return i;
    return -1;
  }
  /* ---- shared state ---- */
  /* ==========================================================
     SHARED STATE
     ========================================================== */
  var screen = "setup";
  var picks = [];                 // draft: {pid, team, auto}
  var rosters = [];               // season: rosters[t] = [pid,...]
  var myLineup = [];              // current-week starters, aligned to SLOTS
  var results = {};               // results[week] = {pts:{t:n}, lines:{t:[pid]}, pairs:[[a,b]], bye:t}
  var seeds = null;               // playoff seeding, set when the regular season ends
  var week = 1, viewWeek = 1;
  var filter = "ALL", faFilter = "ALL", tab = "pool", stab = "matchup";
  var focus = 0, pendingAdd = null, message = null, arm = null;
  var deadline = 0, cpuTimer = null, ticker = null, resolving = false;

  function teamOnClock(n){
    var T = cfg.teams, round = Math.floor(n / T), slot = n % T;
    return cfg.order[round % 2 === 0 ? slot : T - 1 - slot];
  }
  function roundOf(n){ return Math.floor(n / cfg.teams) + 1; }
  function pickLabel(n){
    var s = String(n % cfg.teams + 1);
    return roundOf(n) + "." + (s.length < 2 ? "0" + s : s);
  }
  /* ---- season helpers ---- */
  function benchIds(){
    return rosters[ME].filter(function(pid){ return myLineup.indexOf(pid) < 0; });
  }
  function played(w){ return !!results[w]; }

  /* Matchups for a week: regular season from the round robin, playoffs from the bracket. */
  function matchupsFor(w){
    if (!isPlayoffWeek(w)) return weekPairs(w);
    if (!seeds) return [];
    var rnd = w - cfg.weeks;                      // 1-based playoff round
    var alive = seeds.slice();
    for (var r = 1; r < rnd; r++){
      var next = [];
      for (var i = 0; i < alive.length; i += 2){
        var res = results[cfg.weeks + r];
        if (!res) return [];
        next.push(res.pts[alive[i]] >= res.pts[alive[i + 1]] ? alive[i] : alive[i + 1]);
      }
      alive = next;
    }
    var out = [];
    if (rnd === 1){
      for (var k = 0; k < alive.length / 2; k++) out.push([alive[k], alive[alive.length - 1 - k]]);
    } else {
      for (var j = 0; j < alive.length; j += 2) out.push([alive[j], alive[j + 1]]);
    }
    return out;
  }
  function inPlayoffs(t){ return !seeds || seeds.indexOf(t) >= 0; }

  function standings(){
    var rows = [];
    for (var i = 0; i < cfg.teams; i++) rows.push({i:i, w:0, l:0, t:0, pf:0, pa:0, res:[]});
    for (var w = 1; w <= cfg.weeks; w++){
      if (!results[w]) continue;
      results[w].pairs.forEach(function(m){
        var a = results[w].pts[m[0]], b = results[w].pts[m[1]];
        rows[m[0]].pf += a; rows[m[0]].pa += b;
        rows[m[1]].pf += b; rows[m[1]].pa += a;
        if (a > b){ rows[m[0]].w++; rows[m[1]].l++; rows[m[0]].res.push("W"); rows[m[1]].res.push("L"); }
        else if (b > a){ rows[m[1]].w++; rows[m[0]].l++; rows[m[1]].res.push("W"); rows[m[0]].res.push("L"); }
        else { rows[m[0]].t++; rows[m[1]].t++; rows[m[0]].res.push("T"); rows[m[1]].res.push("T"); }
      });
    }
    rows.forEach(function(r){ r.pf = r1(r.pf); r.pa = r1(r.pa); });
    return rows.sort(function(a,b){ return ((b.w + b.t / 2) - (a.w + a.t / 2)) || (b.pf - a.pf); });
  }
  function recText(r){ return r.w + "-" + r.l + (r.t ? "-" + r.t : ""); }
  function recOf(i){
    var s = standings().filter(function(x){ return x.i === i; })[0];
    return s ? recText(s) : "0-0";
  }
  function myMatchupIndex(w){
    var ms = matchupsFor(w);
    for (var i = 0; i < ms.length; i++) if (ms[i].indexOf(ME) >= 0) return i;
    return 0;
  }
  function lineupOf(t, w){
    if (results[w]) return results[w].lines[t] || [];
    if (t === ME) return myLineup;
    return bestLineup(t, w, "proj");
  }
  function benchOf(t, w){
    var line = lineupOf(t, w);
    return rosters[t].filter(function(pid){ return line.indexOf(pid) < 0; });
  }

  /* Play the current week: every team's lineup is locked in and scored. */
  async function simulateWeek(){
    var w = week;
    if (results[w]) return;
    if (!amCommish()) return say("Only the commissioner can play a week.", true);
    await saveLineup();
    /* Read every manager's saved lineup. Anyone who never set one starts
       their best projected eleven rather than forfeiting. */
    var saved = {};
    var lu = await sb.from("lineups").select("team_id, slots").eq("league_id", LG.id).eq("week", w);
    if (!lu.error) (lu.data || []).forEach(function(r){
      var i = TEAMS.findIndex(function(t){ return t.id === r.team_id; });
      if (i >= 0 && Array.isArray(r.slots)) saved[i] = r.slots;
    });
    var ms = matchupsFor(w), lines = {}, pts = {};
    var involved = {};
    ms.forEach(function(m){ involved[m[0]] = 1; involved[m[1]] = 1; });
    for (var t = 0; t < cfg.teams; t++){
      if (isPlayoffWeek(w) && !involved[t]) continue;
      var line = saved[t] ? saved[t].slice() : bestLineup(t, w, "proj");
      if (line.length !== SLOTS.length) line = bestLineup(t, w, "proj");
      lines[t] = line;
      pts[t] = lineupPts(line, w);
    }
    results[w] = {pts:pts, lines:lines, pairs:ms, bye:isPlayoffWeek(w) ? -1 : byeTeam(w)};
    var ins = await sb.from("results").insert({league_id:LG.id, week:w, data:results[w]});
    if (ins.error && !/duplicate|conflict/i.test(ins.error.message)) say(ins.error.message, true);
    if (w === cfg.weeks && !seeds){
      seeds = standings().slice(0, cfg.playoff).map(function(r){ return r.i; });
    }
    viewWeek = w;
    message = null; arm = null;
  }
  async function advanceWeek(){
    if (week >= totalWeeks()) return;
    if (!amCommish()) return say("Only the commissioner can advance the week.", true);
    week++;
    await sb.from("leagues").update({current_week: week}).eq("id", LG.id);
    var lu = await sb.from("lineups").select("slots")
                     .eq("team_id", TEAMS[ME] ? TEAMS[ME].id : "x").eq("week", week);
    if (!lu.error && lu.data && lu.data.length && Array.isArray(lu.data[0].slots)){
      myLineup = lu.data[0].slots.slice();
    }
    lastSaved = "";
    viewWeek = week;
    myLineup = myLineup.map(function(pid){
      return pid !== null && rosters[ME].indexOf(pid) >= 0 ? pid : null;
    });
    fillEmptySlots();
    focus = myMatchupIndex(week);
    message = null; arm = null;
  }
  function fillEmptySlots(){
    var used = {};
    myLineup.forEach(function(pid){ if (pid !== null) used[pid] = 1; });
    SLOTS.forEach(function(slot, i){
      if (myLineup[i] !== null) return;
      var best = null, bestV = -1;
      rosters[ME].forEach(function(pid){
        if (used[pid] || !fits(slot, P(pid).pos)) return;
        var v = projOf(P(pid));
        if (v > bestV){ bestV = v; best = pid; }
      });
      if (best !== null){ used[best] = 1; myLineup[i] = best; }
    });
  }
  function champion(){
    var last = totalWeeks();
    if (!results[last] || !results[last].pairs.length) return -1;
    var m = results[last].pairs[0];
    return results[last].pts[m[0]] >= results[last].pts[m[1]] ? m[0] : m[1];
  }
  function roundName(w){
    var rnd = w - cfg.weeks, left = playoffRounds() - rnd;
    if (left === 0) return "Championship";
    if (left === 1) return "Semifinal";
    if (left === 2) return "Quarterfinal";
    return "Round " + rnd;
  }

  /* ---- draft room ---- */
  /* ==========================================================
     DRAFT
     ========================================================== */
  async function startDraft(){
    if (!amCommish()) return say("Only the commissioner can start the draft.", true);
    var names = Pool.TEAM_POOL.map(function(t){ return t.name; });
    var res = await sb.rpc("start_draft", {lid: LG.id, cpu_names: names});
    if (res.error) return say(res.error.message, true);
    await loadAll();
    route();
  }
  /* Every pick goes through make_pick. The server recomputes whose turn it
     is, so a browser cannot pick out of turn even if this code is wrong, and
     two clients racing to drive the same CPU seat is harmless - the loser
     gets a duplicate error nobody needs to see. */
  async function draft(pid, auto){
    if (inflight || !pid) return;
    inflight = true;
    var res = await sb.rpc("make_pick", {lid: LG.id, p_key: pid});
    inflight = false;
    if (res.error && !/not your pick|already drafted|complete/i.test(res.error.message)){
      say(res.error.message, true);
    }
    await refreshPicks();
  }
  function scheduleCpu(){
    clearTimeout(cpuTimer);
    if (!LG || LG.phase !== "draft") return;
    if (picks.length >= totalPicks()) return;
    var t = teamOnClock(picks.length), n = picks.length;
    if (!isCpu(t)) return;                    /* a person is on the clock */
    cpuTimer = setTimeout(function(){
      if (picks.length !== n) return;         /* somebody else drove it first */
      draft(cpuPickId(t, n), false);
    }, 700 + Math.random() * 600);
  }
  /* Deliberately empty: the deadline is derived from the server's record of
     the last pick in applyPicks, so every browser counts down to the same
     instant no matter what its own clock says. */
  function startClock(){}
  function tick(){
    if (screen !== "draft") return;
    var cell = el("timercell"), out = el("timer"), bar = el("bar");
    if (picks.length >= totalPicks()){
      cell.className = "cell timer off"; out.textContent = "—";
      bar.style.width = "0%"; bar.className = "bar";
      return;
    }
    var left = (deadline - serverNow()) / 1000;
    out.textContent = mmss(left);
    bar.style.width = Math.max(0, Math.min(1, left / cfg.secs)) * 100 + "%";
    var state = left <= 5 ? "crit" : (left <= 10 ? "warn" : "");
    cell.className = "cell timer " + state;
    bar.className = "bar " + state;
    if (left <= 0 && !resolving){
      resolving = true;
      clearTimeout(cpuTimer);
      var t = teamOnClock(picks.length);
      /* The server allows anyone to autopick once the clock is out, so a
         draft never stalls on someone who has closed their laptop. Give that
         person's own browser a moment first. */
      setTimeout(function(){ draft(autoPickId(t), true); }, t === ME ? 0 : 1800);
    }
  }

  function renderDraftClock(){
    var tot = totalPicks(), done = picks.length >= tot;
    var n = done ? tot - 1 : picks.length;
    var yours = !done && teamOnClock(n) === ME;
    el("roundno").textContent = roundOf(n) + " of " + rosterSize();
    el("pickno").textContent = done ? "Final" : pickLabel(n);
    el("clockteam").textContent = done ? "Draft complete" : team(teamOnClock(n)).name;
    el("whocell").className = "cell who" + (yours ? " yours" : "");
    var poolTag = el("poolcount");
    poolTag.textContent = yours ? "Your pick" : available().length;
    poolTag.className = yours ? "n turn" : "n";
    el("rostercount").textContent = picks.length + "/" + tot;
    el("logcount").textContent = picks.length;
    el("dfoot").textContent =
      "Roster: " + POSITIONS.filter(function(p){ return cfg.slots[p] > 0; })
        .map(function(p){ return cfg.slots[p] + " " + p; }).join(" · ") +
      (cfg.flex ? " · " + cfg.flex + " FLEX" : "") + (cfg.bench ? " · " + cfg.bench + " BN" : "") +
      " (" + rosterSize() + " per team). A FLEX spot starts any RB, WR or TE; a DEF spot is a whole school's " +
      "defense, scored as one line. CPU teams draft on projected points over replacement at each position, scaled " +
      "by what they still need — so they take the best player available when nobody is pressing, chase need late, " +
      "and never leave a starting slot they cannot fill. Each has its own leanings, so no two drafts run the same. " +
      "If your clock hits zero your pick fills your own next open slot. Drafting by hand is unrestricted. " +
      "Players and defenses are invented placeholders.";
  }
  function renderBoard(){
    var tot = totalPicks(), host = el("board");
    host.innerHTML = "";
    if (picks.length >= tot){
      var d = document.createElement("div");
      d.className = "bd-done";
      d.innerHTML = "<strong>Draft complete</strong><span>" + tot + " picks over " + rosterSize() + " rounds.</span>";
      var go = document.createElement("button");
      go.type = "button"; go.className = "btn gold"; go.textContent = "Start the season";
      go.addEventListener("click", function(){ startSeason(); });
      d.appendChild(go);
      host.appendChild(d);
      return;
    }
    var start = picks.length, end = Math.min(start + BOARD_LENGTH, tot);
    for (var i = start; i < end; i++){
      var ti = teamOnClock(i), t = team(ti), mine = ti === ME;
      var cell = document.createElement("div");
      cell.className = "bd-cell" + (i === start ? " live" : "") + (mine ? " mine" : "") +
        (i > start && roundOf(i) !== roundOf(i - 1) ? " turn" : "");
      cell.innerHTML =
        '<span class="bd-no">' + pickLabel(i) + '</span>' +
        '<span class="bd-tm">' + esc(t.name) + '</span>' +
        (mine ? '<span class="tag you-tag">You</span>' : (i === start ? '<span class="tag clock-tag">Now</span>' : ''));
      host.appendChild(cell);
    }
  }
  function renderFilters(force){
    var box = el("filters");
    if (box.querySelector(".chip") && !force) return;
    box.innerHTML = '<span class="lab">View</span>';
    ["ALL"].concat(POSITIONS).forEach(function(p){
      var b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = p === "ALL" ? "All" : p;
      b.setAttribute("aria-pressed", String(p === filter));
      b.addEventListener("click", function(){
        filter = p;
        box.querySelectorAll(".chip").forEach(function(c){ c.setAttribute("aria-pressed", String(c === b)); });
        renderPool();
      });
      box.appendChild(b);
    });
  }
  function renderPool(){
    var pool = available();
    var shown = filter === "ALL" ? pool : pool.filter(function(p){ return p.pos === filter; });
    var yourTurn = picks.length < totalPicks() && teamOnClock(picks.length) === ME;
    var host = el("pool");
    host.innerHTML = "";
    if (!shown.length){ host.innerHTML = '<p class="empty" style="padding:14px">No players left at this filter.</p>'; return; }
    var rank = {};
    pool.forEach(function(p, i){ rank[p.key] = i + 1; });
    shown.slice(0, 60).forEach(function(p){
      var row = document.createElement("div");
      row.className = "prow";
      row.innerHTML =
        '<span class="rk">' + rank[p.key] + '</span>' +
        '<span class="nm">' + esc(p.name) + '</span>' +
        '<span class="pos">' + p.pos + '</span>' +
        '<span class="sch">' + esc(p.school) + '</span>' +
        '<span class="rt">' + p.rating + '</span>';
      var btn = document.createElement("button");
      btn.type = "button"; btn.className = "pick";
      btn.textContent = yourTurn ? "Draft" : "—";
      btn.disabled = !yourTurn;
      btn.setAttribute("aria-label", "Draft " + p.name + ", " + p.pos + ", " + p.school);
      btn.addEventListener("click", function(){ draft(p.key, false); });
      row.appendChild(btn);
      host.appendChild(row);
    });
  }
  function renderDraftTeams(){
    var onClock = picks.length < totalPicks() ? teamOnClock(picks.length) : -1;
    var size = rosterSize(), host = el("teams");
    host.innerHTML = "";
    for (var ti = 0; ti < cfg.teams; ti++){
      (function(ti){
        var t = team(ti), slots = rosterSlots(ti), counts = countsFor(ti);
        var fill = fillFor(ti), benchUsed = fill.bench;
        var extra = POSITIONS.filter(function(p){ return counts[p] > cfg.slots[p]; });
        var mine = ti === ME;
        var card = document.createElement("section");
        card.className = "team" + (mine ? " you" : "") + (ti === onClock ? " onclock" : "");
        var head = document.createElement("div");
        head.className = "thead";
        head.innerHTML = '<span class="tname">' + esc(t.name) + '</span>' +
          (mine ? '<span class="tag you-tag">You</span>' : '') +
          (ti === onClock ? '<span class="tag clock-tag">Now</span>' : '');
        var counter = document.createElement("div");
        counter.className = "counter";
        var btn = document.createElement("button");
        btn.type = "button"; btn.className = "count";
        btn.textContent = slots.length + "/" + size;
        btn.setAttribute("aria-label", t.name + " roster: " + slots.length + " of " + size + " filled. Show position breakdown.");
        btn.addEventListener("click", function(){ counter.classList.toggle("open"); });
        counter.appendChild(btn);
        var bubble = document.createElement("div");
        bubble.className = "bubble"; bubble.setAttribute("role", "note");
        var html = '<h3>' + t.abbr + ' by position</h3>';
        POSITIONS.forEach(function(p){
          var c = counts[p], target = cfg.slots[p];
          var cls = c > target ? (cfg.flex || cfg.bench ? "extra" : "over") : (c === target && target > 0 ? "full" : "");
          html += '<div class="brow ' + cls + '"><span class="p">' + p + '</span><span class="v">' + c + "/" + target + '</span></div>';
        });
        if (cfg.flex)
          html += '<div class="brow bench ' + (fill.flex === cfg.flex ? "full" : "") +
                  '"><span class="p">FLEX</span><span class="v">' + fill.flex + "/" + cfg.flex + '</span></div>';
        var spill = benchUsed - cfg.bench;
        html += '<div class="brow bench ' + (spill > 0 ? "over" : (benchUsed === cfg.bench && cfg.bench > 0 ? "full" : "")) +
                '"><span class="p">BN</span><span class="v">' + benchUsed + "/" + cfg.bench + '</span></div>';
        if (spill > 0)
          html += '<p class="bnote bad">' + spill + ' player' + (spill > 1 ? "s" : "") + ' past the roster — no slot to start or bench.</p>';
        else if (extra.length)
          html += '<p class="bnote">Extra ' + extra.join(", ") + ' in the flex and bench spots.</p>';
        bubble.innerHTML = html;
        counter.appendChild(bubble);
        head.appendChild(counter);
        card.appendChild(head);
        if (slots.length){
          var ul = document.createElement("ul");
          ul.className = "roster";
          slots.forEach(function(s){
            var li = document.createElement("li");
            li.className = (s.auto ? "auto " : "") + (s.slot === "BN" ? "bn" : "");
            li.innerHTML = '<span class="p">' + s.slot + '</span>' +
                           '<span class="n">' + esc(s.player.name) + '<small>' + esc(s.player.school) + '</small></span>' +
                           '<span class="r">' + s.player.rating + '</span>';
            ul.appendChild(li);
          });
          card.appendChild(ul);
        } else {
          var e = document.createElement("p");
          e.className = "empty"; e.textContent = "No picks yet.";
          card.appendChild(e);
        }
        host.appendChild(card);
      })(ti);
    }
  }
  function renderDraftLog(){
    var host = el("log");
    host.innerHTML = "";
    if (!picks.length){ host.innerHTML = '<li style="grid-template-columns:1fr"><span class="empty">No picks yet.</span></li>'; return; }
    picks.slice().reverse().forEach(function(p, idx){
      var n = picks.length - 1 - idx, pl = P(p.pid);
      var li = document.createElement("li");
      if (p.team === ME) li.className = "mine";
      li.innerHTML =
        '<span class="l-no">' + pickLabel(n) + '</span>' +
        '<span class="l-tm">' + esc(team(p.team).abbr) + '</span>' +
        '<span class="l-nm">' + esc(pl.name) + (p.auto ? '<span class="l-auto">Auto</span>' : '') + '</span>' +
        '<span class="pos">' + pl.pos + '</span>' +
        '<span class="l-sch">' + esc(pl.school) + '</span>' +
        '<span class="l-rt">' + pl.rating + '</span>';
      host.appendChild(li);
    });
  }
  function setTab(next){
    tab = next;
    ["pool","rosters","log"].forEach(function(k){
      el("tab-" + k).setAttribute("aria-selected", String(k === tab));
      el("panel-" + k).hidden = k !== tab;
    });
  }
  ["pool","rosters","log"].forEach(function(k){
    el("tab-" + k).addEventListener("click", function(){ setTab(k); });
  });
  function renderDraft(){
    renderDraftClock(); renderBoard(); renderPool(); renderDraftTeams(); renderDraftLog(); tick();
  }

  /* ---- season view ---- */
  /* ==========================================================
     SEASON
     ========================================================== */
  function weekName(w){ return isPlayoffWeek(w) ? roundName(w) : "week " + w; }
  function weekTitle(w){ return isPlayoffWeek(w) ? roundName(w) : "Week " + w; }

  /* Rosters were written to the teams table by make_pick when the last pick
     landed, so the season starts from the database, not from this page. */
  function startSeason(){
    clearTimeout(cpuTimer); clearInterval(ticker);
    viewWeek = week;
    stab = "matchup"; faFilter = "ALL"; pendingAdd = null; message = null; arm = null;
    normaliseLineup();
    focus = myMatchupIndex(week);
    showScreen("season");
    setStab("matchup");
    renderFAFilters(true);
    renderSeason();
  }

  function renderTop(){
    el("wlabel").textContent = weekTitle(viewWeek);
    el("wprev").disabled = viewWeek <= 1;
    el("wnext").disabled = viewWeek >= totalWeeks();
    var st = el("wstate");
    st.textContent = played(viewWeek) ? "Final" : (viewWeek === week ? "Not played" : "Upcoming");
    st.className = "wstate " + (played(viewWeek) ? "done" : (isPlayoffWeek(viewWeek) ? "post" : ""));

    var btn = el("simbtn"), note = el("simnote");
    var champ = champion();
    if (champ >= 0){
      btn.textContent = "Season complete"; btn.disabled = true;
      note.textContent = team(champ).name + " won the title.";
    } else if (!played(week)){
      btn.textContent = "Simulate " + weekName(week); btn.disabled = false;
      note.textContent = viewWeek !== week ? "Viewing " + weekName(viewWeek) + " — current is " + weekName(week) + "." : "";
    } else {
      btn.textContent = "Advance to " + weekName(week + 1); btn.disabled = false;
      note.textContent = weekTitle(week) + " is final.";
    }

    var host = el("scores");
    host.innerHTML = "";
    var ms = matchupsFor(viewWeek);
    if (!ms.length){
      host.innerHTML = '<p class="empty">The playoff field is set once the regular season ends.</p>';
      return;
    }
    ms.forEach(function(m, idx){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "sc" + (m.indexOf(ME) >= 0 ? " mine" : "");
      b.setAttribute("aria-pressed", String(idx === focus));
      var html = "";
      m.forEach(function(ti){
        var pts = played(viewWeek) ? results[viewWeek].pts[ti] : null;
        var other = m[0] === ti ? m[1] : m[0];
        var lead = pts !== null && pts > results[viewWeek].pts[other];
        var sub = pts === null ? "proj " + lineupProj(lineupOf(ti, viewWeek)).toFixed(1) : "";
        html += '<span class="row"><span class="tm' + (lead ? " lead" : "") + '">' + esc(team(ti).name) +
                (sub ? '<small>' + sub + '</small>' : '') + '</span>' +
                '<span class="pts' + (lead ? " lead" : "") + '">' + (pts === null ? "—" : pts.toFixed(1)) + '</span></span>';
      });
      b.innerHTML = html;
      b.addEventListener("click", function(){ focus = idx; setStab("matchup"); renderSeason(); });
      host.appendChild(b);
    });
    var bye = isPlayoffWeek(viewWeek) ? -1 : byeTeam(viewWeek);
    if (bye >= 0){
      var d = document.createElement("div");
      d.className = "sc bye";
      d.innerHTML = '<span class="row"><span class="tm">' + esc(team(bye).name) + '<small>bye week</small></span><span class="pts">—</span></span>';
      host.appendChild(d);
    }
  }

  function renderMatchup(){
    var ms = matchupsFor(viewWeek);
    if (!ms.length){
      el("mrule").textContent = "";
      el("mhead").innerHTML = "";
      el("box").innerHTML = '<p class="empty" style="padding:16px">Play out the regular season to set the bracket.</p>';
      return;
    }
    if (focus >= ms.length) focus = 0;
    var m = ms[focus], A = m[0], B = m[1], final = played(viewWeek);
    el("mrule").textContent = final
      ? "Final score, slot by slot. Bench points don't count."
      : "Projections until the week is simulated. Bench points never count.";

    var aPts = final ? results[viewWeek].pts[A] : lineupProj(lineupOf(A, viewWeek));
    var bPts = final ? results[viewWeek].pts[B] : lineupProj(lineupOf(B, viewWeek));
    el("mhead").innerHTML =
      '<div class="mhead">' +
        '<div class="side' + (final && aPts > bPts ? " win" : "") + '">' +
          (A === ME ? '<span class="you-tag">Your team</span>' : '') +
          '<span class="tm">' + esc(team(A).name) + '</span>' +
          '<span class="rc">' + recOf(A) + '</span>' +
          '<span class="sc-big">' + aPts.toFixed(1) + '</span>' +
          (final ? '' : '<span class="proj">projected</span>') +
        '</div>' +
        '<div class="vs">' + (final ? "Final" : weekTitle(viewWeek)) + '</div>' +
        '<div class="side right' + (final && bPts > aPts ? " win" : "") + '">' +
          (B === ME ? '<span class="you-tag">Your team</span>' : '') +
          '<span class="tm">' + esc(team(B).name) + '</span>' +
          '<span class="rc">' + recOf(B) + '</span>' +
          '<span class="sc-big">' + bPts.toFixed(1) + '</span>' +
          (final ? '' : '<span class="proj">projected</span>') +
        '</div>' +
      '</div>';

    var la = lineupOf(A, viewWeek), lb = lineupOf(B, viewWeek);
    var box = el("box");
    box.innerHTML = '<div class="brow2 hdr"><span>' + esc(team(A).abbr) + '</span>' +
                    '<span style="text-align:center">Slot</span>' +
                    '<span style="text-align:right">' + esc(team(B).abbr) + '</span></div>';
    SLOTS.forEach(function(slot, i){
      box.appendChild(boxRow(slot, la[i], lb[i], false, final));
    });
    var ba = benchOf(A, viewWeek), bb = benchOf(B, viewWeek);
    var maxB = Math.max(ba.length, bb.length);
    for (var k = 0; k < maxB; k++){
      box.appendChild(boxRow("BN", ba[k], bb[k], true, final));
    }
  }
  function boxRow(slot, pidA, pidB, bench, final){
    var row = document.createElement("div");
    row.className = "brow2" + (bench ? " bnch" : "");
    row.innerHTML = boxSide(pidA, false, final) + '<span class="slot">' + slot + '</span>' + boxSide(pidB, true, final);
    return row;
  }
  function boxSide(pid, right, final){
    if (pid === null || pid === undefined)
      return '<span class="ply' + (right ? " r" : "") + '"><span class="who"><span class="nm">—</span></span><span class="pt pend">—</span></span>';
    var p = P(pid);
    var meta = p.pos + " · " + esc(p.school);
    var val, cls = "";
    if (final){
      var st = statLine(p, viewWeek);
      val = points(st).toFixed(1);
      meta += " · " + statText(p, st);
    } else {
      val = projOf(p).toFixed(1); cls = " pend";
    }
    return '<span class="ply' + (right ? " r" : "") + '">' +
      '<span class="who"><span class="nm">' + esc(p.name) + '</span><span class="meta">' + meta + '</span></span>' +
      '<span class="pt' + cls + '">' + val + '</span></span>';
  }

  /* ---------- lineup ---------- */
  function nameOf(ref){
    return ref.type === "slot"
      ? (myLineup[ref.i] === null ? "the open " + SLOTS[ref.i] + " slot" : P(myLineup[ref.i]).name)
      : P(ref.pid).name;
  }
  function sameRef(a, b){
    return a && b && a.type === b.type && (a.type === "slot" ? a.i === b.i : a.pid === b.pid);
  }
  function moveInfo(from, to){
    if (!from || !to || sameRef(from, to)) return null;
    if (from.type === "bench" && to.type === "bench") return null;
    if (from.type === "slot" && to.type === "slot"){
      var mover = myLineup[from.i];
      if (mover === null) return null;
      if (!fits(SLOTS[to.i], P(mover).pos)) return null;
      return {kind:"shuffle", from:from.i, to:to.i};
    }
    var slot = from.type === "slot" ? from : to;
    var bench = from.type === "slot" ? to : from;
    if (!fits(SLOTS[slot.i], P(bench.pid).pos)) return null;
    return {kind:"bench", slot:slot.i, pid:bench.pid};
  }
  function canPair(ref){ return !!arm && !!moveInfo(arm, ref); }
  function eligibleCount(ref){
    var n = 0;
    SLOTS.forEach(function(sl, i){ if (moveInfo(ref, {type:"slot", i:i})) n++; });
    benchIds().forEach(function(pid){ if (moveInfo(ref, {type:"bench", pid:pid})) n++; });
    return n;
  }
  function chipFor(ref, label, armed, can, locked){
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot slotbtn" + (armed ? " armed" : (can ? " can" : ""));
    btn.textContent = label;
    btn.disabled = !!locked;
    var name = nameOf(ref);
    var intoGap = arm && arm.type === "slot" && myLineup[arm.i] === null;
    btn.setAttribute("aria-label", locked ? name + " — this week is final"
      : (armed ? "Leave " + name + " as it is"
      : (can ? (intoGap ? "Put " + name + " in the open " + SLOTS[arm.i] + " slot" : "Move here, swapping with " + name)
             : "Pick up " + name)));
    btn.setAttribute("aria-pressed", String(!!armed));
    if (!locked) btn.addEventListener("click", function(){ chipClick(ref); });
    return btn;
  }
  function pickUp(ref, lead){
    arm = ref;
    var n = eligibleCount(ref);
    var empty = ref.type === "slot" && myLineup[ref.i] === null;
    var head = lead || (empty ? "Your " + SLOTS[ref.i] + " slot is open —" : "Picked up " + nameOf(ref) + " —");
    message = head + " " + (n
      ? (empty ? "click a gold chip to fill it, or the green one to leave it open."
               : "click a gold chip to move him there, or the green one to put him back.")
      : (empty ? "nobody on your bench can fill it."
               : "there is nowhere else he can play."));
    renderSeason();
  }
  function chipClick(ref){
    if (sameRef(arm, ref)){ arm = null; message = null; renderSeason(); return; }
    var mv = moveInfo(arm, ref);
    if (mv && mv.kind === "bench"){
      var out = myLineup[mv.slot];
      myLineup[mv.slot] = mv.pid;
      arm = null;
      message = P(mv.pid).name + " starts at " + SLOTS[mv.slot] +
                (out !== null ? ", " + P(out).name + " to the bench." : ".");
      renderSeason(); return;
    }
    if (mv && mv.kind === "shuffle"){
      var mover = myLineup[mv.from], held = myLineup[mv.to];
      myLineup[mv.to] = mover;
      if (held !== null && fits(SLOTS[mv.from], P(held).pos)){
        myLineup[mv.from] = held;
        arm = null;
        message = P(mover).name + " moves to " + SLOTS[mv.to] + ", " + P(held).name + " to " + SLOTS[mv.from] + ".";
        renderSeason(); return;
      }
      myLineup[mv.from] = null;
      var lead = P(mover).name + " moves to " + SLOTS[mv.to] + ". " +
        (held !== null
          ? P(held).name + " can't play " + SLOTS[mv.from] + ", so he's on the bench and that slot is open —"
          : "Your " + SLOTS[mv.from] + " slot is open now —");
      pickUp({type:"slot", i:mv.from}, lead);
      return;
    }
    pickUp(ref, null);
  }
  function renderLineup(){
    var locked = played(week);
    el("lineuprule").innerHTML = locked
      ? weekTitle(week) + " is already final — advance to set your next lineup."
      : weekTitle(week) + " lineup. <b>Click a position chip</b> to pick a player up, then click a gold chip " +
        "to move him. That works between the bench and a slot, and between two slots, so an RB can slide into " +
        "FLEX. If the man he displaces can't play the vacated slot he goes to the bench and you fill the gap.";
    el("lineupmsg").innerHTML = message ? '<div class="toast">' + esc(message) + '</div>' : "";

    var host = el("starters");
    host.innerHTML = '<div class="lrow hdr"><span>Slot</span><span>Player</span><span class="pr">Proj</span><span></span></div>';
    var proj = 0;
    SLOTS.forEach(function(slot, i){
      var pid = myLineup[i], p = pid === null ? null : P(pid);
      var armed = arm && arm.type === "slot" && arm.i === i;
      var can = canPair({type:"slot", i:i});
      var row = document.createElement("div");
      row.className = "lrow" + (armed ? " armedrow" : (can ? " eligible" : ""));
      if (p) proj += projOf(p);
      row.innerHTML =
        '<span></span>' +
        '<span><span class="nm">' + (p ? esc(p.name) : "Empty") + '</span>' +
        '<span class="meta">' + (p ? p.pos + " · " + esc(p.school) : "nobody in this slot") + '</span></span>' +
        '<span class="pr">' + (p ? projOf(p).toFixed(1) : "—") + '</span>' +
        '<span class="lockchip">' + (locked ? "Final" : (armed ? "Picked up" : (can ? "Swap" : "Open"))) + '</span>';
      row.replaceChild(chipFor({type:"slot", i:i}, slot, armed, can, locked), row.firstChild);
      host.appendChild(row);
    });
    el("lproj").textContent = r1(proj).toFixed(1);

    var bhost = el("benchlist");
    bhost.innerHTML = '<div class="lrow hdr"><span>Pos</span><span>Player</span><span class="pr">Proj</span><span></span></div>';
    var bench = benchIds();
    var bc = el("bcount");
    bc.textContent = bench.length + "/" + cfg.bench;
    bc.className = "bcount" + (bench.length > cfg.bench ? " over" : "");
    if (!bench.length) bhost.innerHTML += '<p class="empty">Bench is empty.</p>';
    bench.forEach(function(pid){
      var p = P(pid);
      var armed = arm && arm.type === "bench" && arm.pid === pid;
      var can = canPair({type:"bench", pid:pid});
      var row = document.createElement("div");
      row.className = "lrow" + (armed ? " armedrow" : (can ? " eligible" : ""));
      row.innerHTML =
        '<span></span>' +
        '<span><span class="nm">' + esc(p.name) + '</span>' +
        '<span class="meta">' + p.pos + " · " + esc(p.school) + '</span></span>' +
        '<span class="pr">' + projOf(p).toFixed(1) + '</span>' +
        '<span class="lockchip">' + (locked ? "Final" : (armed ? "Picked up" : (can ? "Swap" : "Bench"))) + '</span>';
      row.replaceChild(chipFor({type:"bench", pid:pid}, p.pos, armed, can, locked), row.firstChild);
      bhost.appendChild(row);
    });
    var flag = el("lineupflag");
    var open = myLineup.filter(function(pid){ return pid === null; }).length;
    flag.textContent = open ? open + " open" : "Set";
    flag.className = "n" + (open ? " alert" : "");
    el("optimize").disabled = locked;
  }
  el("optimize").addEventListener("click", function(){
    if (played(week)) return;
    myLineup = bestLineup(ME, week, "proj");
    arm = null;
    message = "Lineup set to the highest projection available.";
    renderSeason();
  });

  /* ---------- standings, bracket, schedule ---------- */
  function renderStandings(){
    var playedWeeks = 0;
    for (var w = 1; w <= cfg.weeks; w++) if (results[w]) playedWeeks++;
    el("standrule").textContent = playedWeeks
      ? "Through " + playedWeeks + " of " + cfg.weeks + " regular-season weeks. Top " + cfg.playoff + " make the playoffs."
      : "Nothing played yet. Top " + cfg.playoff + " after " + cfg.weeks + " weeks make the playoffs.";

    var champ = champion();
    el("champbox").innerHTML = champ >= 0
      ? '<div class="champ"><strong>' + esc(team(champ).name) + ' win the title</strong>' +
        '<span>' + (champ === ME ? "That is your team." : "Your team did not.") + '</span></div>'
      : "";

    var rows = standings(), body = el("standbody");
    body.innerHTML = "";
    rows.forEach(function(r, i){
      var streak = "", res = r.res.slice().reverse();
      for (var k = 0; k < res.length && res[k] === res[0]; k++) streak = res[0] + (k + 1);
      var tr = document.createElement("tr");
      tr.className = (r.i === ME ? "mine " : "") + (i === cfg.playoff ? "cut" : "");
      var berth = seeds
        ? (seeds.indexOf(r.i) >= 0 ? '<span class="berth">Seed ' + (seeds.indexOf(r.i) + 1) + '</span>' : '')
        : (i < cfg.playoff && playedWeeks ? '<span class="berth">In</span>' : '');
      tr.innerHTML =
        '<td class="rk">' + (i + 1) + '</td>' +
        '<td class="tm">' + esc(team(r.i).name) + ' ' + berth + '</td>' +
        '<td class="num rec-cell">' + recText(r) + '</td>' +
        '<td class="num">' + (r.w + r.l + r.t ? ((r.w + r.t / 2) / (r.w + r.l + r.t)).toFixed(3).replace(/^0/, "") : "—") + '</td>' +
        '<td class="num">' + r.pf.toFixed(1) + '</td>' +
        '<td class="num">' + r.pa.toFixed(1) + '</td>' +
        '<td class="num">' + (streak || "—") + '</td>';
      body.appendChild(tr);
    });

    var bb = el("bracketbox");
    if (!seeds){ bb.innerHTML = ""; }
    else {
      var html = '<h2 style="margin-top:22px">Playoffs</h2><div class="bracket">';
      for (var r = 1; r <= playoffRounds(); r++){
        var w2 = cfg.weeks + r;
        html += '<div class="rnd"><h3>' + roundName(w2) + '</h3>';
        var ms = matchupsFor(w2);
        if (!ms.length) html += '<p class="empty">Waiting on the round before.</p>';
        ms.forEach(function(m){
          var done = played(w2);
          var pa = done ? results[w2].pts[m[0]] : null, pb = done ? results[w2].pts[m[1]] : null;
          html += '<div class="bmatch">' + m.map(function(ti, k){
            var mine = ti === ME, pts = k === 0 ? pa : pb, other = k === 0 ? pb : pa;
            var win = done && pts >= other;
            return '<div class="bteam' + (win ? " w" : "") + (mine ? " me" : "") + '">' +
              '<span class="sd">' + (seeds.indexOf(ti) >= 0 ? seeds.indexOf(ti) + 1 : "-") + '</span>' +
              '<span class="nm">' + esc(team(ti).name) + '</span>' +
              '<span class="pt">' + (pts === null ? "—" : pts.toFixed(1)) + '</span></div>';
          }).join("") + '</div>';
        });
        html += '</div>';
      }
      bb.innerHTML = html + '</div>';
    }

    var host = el("sched");
    host.innerHTML = "";
    for (var w3 = 1; w3 <= totalWeeks(); w3++){
      (function(w3){
        var card = document.createElement("div");
        card.className = "wk" + (w3 === week ? " now" : "") + (isPlayoffWeek(w3) ? " post" : "");
        var html = '<h3>' + weekTitle(w3) +
          (w3 === week ? ' <em>Current</em>' : (played(w3) ? '' : ' <span style="color:var(--ink-2)">Upcoming</span>')) + '</h3>';
        var ms = matchupsFor(w3);
        if (!ms.length) html += '<div class="mg"><span class="t">Bracket not set</span><span class="p">—</span></div>';
        ms.forEach(function(m){
          var done = played(w3);
          var pa = done ? results[w3].pts[m[0]] : null, pb = done ? results[w3].pts[m[1]] : null;
          html += '<div class="mg">' +
            '<span class="t' + (done && pa > pb ? " w" : "") + (m[0] === ME ? " me" : "") + '">' + esc(team(m[0]).name) + '</span>' +
            '<span class="p' + (done && pa > pb ? " w" : "") + '">' + (pa === null ? "—" : pa.toFixed(1)) + '</span>' +
            '<span class="t' + (done && pb > pa ? " w" : "") + (m[1] === ME ? " me" : "") + '">' + esc(team(m[1]).name) + '</span>' +
            '<span class="p' + (done && pb > pa ? " w" : "") + '">' + (pb === null ? "—" : pb.toFixed(1)) + '</span>' +
            '</div>';
        });
        card.innerHTML = html;
        card.addEventListener("click", function(){
          viewWeek = w3; focus = myMatchupIndex(w3); setStab("matchup"); renderSeason();
        });
        host.appendChild(card);
      })(w3);
    }
  }

  /* ---------- free agents ---------- */
  function seasonTotal(pid){
    var s = 0;
    for (var w = 1; w <= totalWeeks(); w++) if (results[w]) s += weekPts(pid, w);
    return r1(s);
  }
  function playedCount(){
    var n = 0;
    for (var w = 1; w <= totalWeeks(); w++) if (results[w]) n++;
    return n;
  }
  function renderFAFilters(force){
    var box = el("fafilters");
    if (box.querySelector(".chip") && !force) return;
    box.innerHTML = '<span class="lab">Position</span>';
    ["ALL"].concat(POSITIONS).forEach(function(p){
      var b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = p === "ALL" ? "All" : p;
      b.setAttribute("aria-pressed", String(p === faFilter));
      b.addEventListener("click", function(){
        faFilter = p; pendingAdd = null;
        box.querySelectorAll(".chip").forEach(function(c){ c.setAttribute("aria-pressed", String(c === b)); });
        renderFA();
      });
      box.appendChild(b);
    });
  }
  function renderFA(){
    var owned = {};
    rosters.forEach(function(r){ r.forEach(function(pid){ owned[pid] = 1; }); });
    var free = PLAYERS.filter(function(p){ return !owned[p.key]; });
    el("facount").textContent = free.length;
    el("rsize").textContent = rosterSize();
    el("famsg").innerHTML = message && stab === "fa" ? '<div class="toast">' + esc(message) + '</div>' : "";
    var n = Math.max(1, playedCount());
    var shown = (faFilter === "ALL" ? free : free.filter(function(p){ return p.pos === faFilter; }))
      .map(function(p){ return {p:p, szn:seasonTotal(p.key)}; })
      .sort(function(a,b){ return (b.szn - a.szn) || (b.p.rating - a.p.rating); });

    var host = el("falist");
    host.innerHTML = "";
    if (!shown.length){ host.innerHTML = '<p class="empty">Nobody available at this position.</p>'; return; }
    shown.slice(0, 40).forEach(function(row){
      var p = row.p;
      var div = document.createElement("div");
      div.className = "farow";
      div.innerHTML =
        '<span><span class="nm">' + esc(p.name) + '</span></span>' +
        '<span class="slot">' + p.pos + '</span>' +
        '<span class="sch">' + esc(p.school) + '</span>' +
        '<span class="num szn">' + row.szn.toFixed(1) + '</span>' +
        '<span class="num">' + (row.szn / n).toFixed(1) + '</span>';
      var btn = document.createElement("button");
      btn.type = "button"; btn.className = "act";
      btn.textContent = pendingAdd === p.key ? "Cancel" : "Add";
      btn.addEventListener("click", function(){
        pendingAdd = pendingAdd === p.key ? null : p.key;
        message = null;
        renderFA();
      });
      div.appendChild(btn);
      if (pendingAdd === p.key){
        var bar = document.createElement("div");
        bar.className = "drop";
        var label = document.createElement("span");
        label.textContent = "Drop to make room:";
        var sel = document.createElement("select");
        sel.setAttribute("aria-label", "Player to drop");
        rosters[ME].forEach(function(pid){
          var o = document.createElement("option");
          o.value = String(pid);
          o.textContent = P(pid).pos + "  " + P(pid).name + (myLineup.indexOf(pid) >= 0 ? "  (starting)" : "");
          sel.appendChild(o);
        });
        var go = document.createElement("button");
        go.type = "button"; go.className = "btn"; go.textContent = "Confirm";
        go.addEventListener("click", function(){
          var out = sel.value, at = rosters[ME].indexOf(out);
          rosters[ME][at] = p.key;
          var li = myLineup.indexOf(out);
          if (li >= 0) myLineup[li] = fits(SLOTS[li], P(p.key).pos) ? p.key : null;
          pendingAdd = null; arm = null;
          saveRoster();
          message = "Added " + p.name + ", dropped " + P(out).name + "." +
                    (li >= 0 && myLineup[li] === null ? " Your " + SLOTS[li] + " slot is open." : "");
          renderSeason();
        });
        bar.appendChild(label); bar.appendChild(sel); bar.appendChild(go);
        div.appendChild(bar);
      }
      host.appendChild(div);
    });
  }

  /* ---------- season wiring ---------- */
  function setStab(next){
    stab = next;
    ["matchup","lineup","standings","fa"].forEach(function(k){
      el("tab-" + k).setAttribute("aria-selected", String(k === stab));
      el("panel-" + k).hidden = k !== stab;
    });
  }
  ["matchup","lineup","standings","fa"].forEach(function(k){
    el("tab-" + k).addEventListener("click", function(){ message = null; arm = null; setStab(k); renderSeason(); });
  });
  el("wprev").addEventListener("click", function(){ viewWeek = Math.max(1, viewWeek - 1); focus = myMatchupIndex(viewWeek); renderSeason(); });
  el("wnext").addEventListener("click", function(){ viewWeek = Math.min(totalWeeks(), viewWeek + 1); focus = myMatchupIndex(viewWeek); renderSeason(); });
  el("simbtn").addEventListener("click", function(){
    if (champion() >= 0) return;
    if (!played(week)){
      simulateWeek();
      focus = myMatchupIndex(week);
      setStab("matchup");
    } else {
      advanceWeek();
      setStab("lineup");
    }
    renderSeason();
  });
  document.addEventListener("click", function(e){
    document.querySelectorAll(".counter.open").forEach(function(c){
      if (!c.contains(e.target)) c.classList.remove("open");
    });
  });

  function renderSeason(){
    saveLineup();
    showScreen("season");
    renderTop(); renderMatchup(); renderLineup(); renderStandings(); renderFA();
    el("sfoot").innerHTML =
      "<b>Scoring:</b> 1 pt per 25 passing yards, 4 per passing TD, −2 per interception · 1 pt per 10 rushing or " +
      "receiving yards, 6 per TD · 0.5 per reception · −2 per fumble lost · kickers 3 / 4 / 5 by field goal distance, " +
      "1 per extra point. <b>Each week:</b> set your lineup, simulate it, then advance — CPU teams start their best " +
      "projected lineup. Every stat line is generated from the player, the week and this league's seed, so a week " +
      "always plays out the same way once it has been simulated. Players and results are invented.";
  }

  /* =========================================================
     Which screen, and the lobby around it
     ========================================================= */
  function show(id, on){ var e = el(id); if (e) e.classList.toggle("hidden", !on); }
  function showScreen(which){
    screen = which;
    ["setup","draft","season"].forEach(function(k){
      var e = el("screen-" + k); if (e) e.hidden = (k !== which);
    });
    var sub = el("sub");
    if (sub) sub.textContent = which === "draft" ? "Draft room"
            : which === "season" ? "Season" : "League";
  }
  function needsUsername(){ return !!me && !(profile && profile.username); }

  function route(){
    var signedIn = !!me;
    show("view-auth", !signedIn);
    show("signout", signedIn);
    show("view-username", needsUsername());
    if (needsUsername()){
      /* Nothing else until they have a name - it is what the league sees. */
      ["view-new","view-join","view-league","view-settings"].forEach(function(k){ show(k, false); });
      ["setup","draft","season"].forEach(function(k){
        var e = el("screen-" + k); if (e) e.hidden = true;
      });
      return;
    }
    var inLeague = signedIn && !!LG;
    var phase = LG ? LG.phase : null;
    var lobby = inLeague && phase === "setup";

    show("view-new",      signedIn && !LG);
    show("view-join",     signedIn && !LG);
    show("view-league",   lobby);
    show("view-settings", lobby);
    ["setup","draft","season"].forEach(function(k){
      var e = el("screen-" + k); if (e) e.hidden = true;
    });

    if (!inLeague){ showScreen("setup"); el("screen-setup").hidden = true; return; }
    if (lobby){
      el("league-name").textContent = LG.name;
      el("code-val").textContent = LG.join_code;
      renderSettings();
      renderLobby();
      return;
    }
    if (phase === "draft"){
      SLOTS = slotList();
      showScreen("draft");
      renderFilters(true);
      setTab(tab || "pool");
      renderDraft();
      scheduleCpu();
      clearInterval(ticker);
      ticker = setInterval(tick, 200);
      return;
    }
    clearInterval(ticker); clearTimeout(cpuTimer);
    SLOTS = slotList();
    if (screen !== "season") startSeason(); else renderSeason();
  }

  function renderLobby(){
    var list = el("members");
    if (!list) return;
    list.innerHTML = "";
    TEAMS.forEach(function(t, i){
      var li = document.createElement("li");
      li.innerHTML = '<span class="slot">' + (i + 1) + '</span><span class="tname"></span>';
      li.querySelector(".tname").textContent = t.name;
      if (me && t.owner === me.id){
        var y = document.createElement("span"); y.className = "tag you"; y.textContent = "You";
        li.appendChild(y);
      }
      if (t.owner && LG && t.owner === LG.commissioner){
        var c = document.createElement("span"); c.className = "tag commish";
        c.textContent = "Commissioner"; li.appendChild(c);
      }
      if (!t.owner){
        var o = document.createElement("span"); o.className = "tag open"; o.textContent = "Open";
        li.appendChild(o);
      }
      list.appendChild(li);
    });
    var want = (LG.settings && parseInt(LG.settings.teams, 10)) || cfg.teams;
    var open = Math.max(0, want - TEAMS.length);
    el("league-note").textContent = amCommish()
      ? "You're the commissioner. Send the code to your friends. Any seat nobody takes drafts itself."
      : "You're in. The commissioner sets the rules and starts the draft.";
    el("league-foot").textContent =
      TEAMS.length + " of " + want + " claimed" +
      (open ? ", " + open + " will be filled by CPU teams when the draft starts." : " - the league is full.");
    show("startwrap", amCommish());
    var b = el("startdraft");
    if (b) b.textContent = open ? "Start draft with " + open + " CPU team" + (open === 1 ? "" : "s")
                                : "Start draft";
  }

  /* =========================================================
     Boot
     ========================================================= */
  async function boot(){
    var s = await sb.auth.getSession();
    me = s.data.session && s.data.session.user;
    el("boot").textContent = "";
    if (!me){ LG = null; profile = null; el("who").textContent = ""; route(); return; }

    var pr = await sb.from("profiles").select("*").eq("id", me.id).limit(1);
    profile = (!pr.error && pr.data && pr.data[0]) || null;
    el("who").textContent = (profile && profile.username) || me.email;
    if (needsUsername()){ LG = null; route(); return; }

    /* Measure this browser's clock against the server's once, so the draft
       countdown is the same everywhere. */
    var t0 = Date.now();
    var sn = await sb.rpc("server_now");
    if (!sn.error && sn.data) skew = Date.parse(sn.data) - (t0 + Date.now()) / 2;

    await loadAll();
    if (LG) watch();
    route();
  }

  function wire(){
    /* ---- accounts ---- */
    function authPane(which){
      show("pane-signup", which === "signup");
      show("pane-signin", which === "signin");
      el("tab-signup").classList.toggle("on", which === "signup");
      el("tab-signin").classList.toggle("on", which === "signin");
      say("");
    }
    el("tab-signup").addEventListener("click", function(){ authPane("signup"); });
    el("tab-signin").addEventListener("click", function(){ authPane("signin"); });

    function noteFor(id, text, kind){
      var e = el(id);
      e.textContent = text;
      e.className = "fieldnote" + (kind ? " " + kind : "");
    }
    function usernameShape(u){
      if (!u) return "Pick a username.";
      if (u.length < 3 || u.length > 20) return "3 to 20 characters.";
      if (!/^[A-Za-z]/.test(u)) return "Has to start with a letter.";
      if (!/^[A-Za-z0-9_]+$/.test(u)) return "Letters, numbers and underscores only.";
      return null;
    }
    /* Check availability as they type, but only after they stop. */
    function liveCheck(inputId, noteId){
      var t = null;
      el(inputId).addEventListener("input", function(){
        var u = this.value.trim();
        clearTimeout(t);
        var bad = usernameShape(u);
        if (bad) return noteFor(noteId, bad, u ? "bad" : "");
        noteFor(noteId, "Checking...", "");
        t = setTimeout(async function(){
          var res = await sb.rpc("username_available", {u: u});
          if (res.error) return noteFor(noteId, "", "");
          noteFor(noteId, res.data ? u + " is available" : u + " is taken",
                  res.data ? "good" : "bad");
        }, 400);
      });
    }
    liveCheck("su-user", "su-user-note");
    liveCheck("un-input", "un-note");

    el("su-pass").addEventListener("input", function(){
      var v = this.value;
      noteFor("su-pass-note", v.length === 0 ? "At least 8 characters."
              : v.length < 8 ? "Too short - " + (8 - v.length) + " more to go." : "Long enough.",
              v.length === 0 ? "" : (v.length < 8 ? "bad" : "good"));
    });

    el("signup").addEventListener("click", async function(){
      var user  = el("su-user").value.trim();
      var email = el("su-email").value.trim();
      var pass  = el("su-pass").value;
      var bad = usernameShape(user);
      if (bad) return say(bad, true);
      if (!email || email.indexOf("@") < 1) return say("That email doesn't look right.", true);
      if (pass.length < 8) return say("Your password needs at least 8 characters.", true);

      this.disabled = true; say("");
      var free = await sb.rpc("username_available", {u: user});
      if (!free.error && free.data === false){
        this.disabled = false;
        return say("Somebody already has the username " + user + ". Try another.", true);
      }
      var res = await sb.auth.signUp({
        email: email, password: pass,
        options: {data: {username: user}, emailRedirectTo: location.href.split("#")[0]}
      });
      this.disabled = false;
      if (res.error){
        var m = res.error.message || "";
        if (/already registered|already exists/i.test(m))
          return say("There's already an account on that email. Sign in instead.", true);
        return say(m, true);
      }
      if (res.data && res.data.session){ boot(); return; }   /* confirmation is off */
      /* Switch panes first - authPane clears the message box, so saying it
         before this would wipe the one instruction that matters. */
      authPane("signin");
      el("si-email").value = email;
      say("Account created. Check " + email + " for a confirmation link, then come back and sign in.");
    });

    el("signin").addEventListener("click", async function(){
      var email = el("si-email").value.trim(), pass = el("si-pass").value;
      if (!email || !pass) return say("Enter your email and password.", true);
      this.disabled = true; say("");
      var res = await sb.auth.signInWithPassword({email: email, password: pass});
      this.disabled = false;
      if (res.error){
        var m = res.error.message || "";
        if (/invalid login/i.test(m))
          return say("That email and password don't match an account.", true);
        if (/not confirmed/i.test(m))
          return say("Confirm your email first - check your inbox for the link we sent.", true);
        return say(m, true);
      }
      el("si-pass").value = "";
      boot();
    });

    el("sendlink").addEventListener("click", async function(){
      var email = el("si-email").value.trim();
      if (!email) return say("Put your email in the box above first, then click this.", true);
      this.disabled = true;
      var res = await sb.auth.signInWithOtp({email: email,
        options: {emailRedirectTo: location.href.split("#")[0]}});
      this.disabled = false;
      if (res.error) return say(res.error.message, true);
      say("Sent. The link in that email signs you straight in.");
    });

    el("un-save").addEventListener("click", async function(){
      var u = el("un-input").value.trim();
      var bad = usernameShape(u);
      if (bad) return say(bad, true);
      this.disabled = true; say("");
      var res = await sb.rpc("set_username", {u: u});
      this.disabled = false;
      if (res.error) return say(res.error.message, true);
      profile = profile || {};
      profile.username = res.data || u;
      say("");
      boot();
    });
    el("signout").addEventListener("click", async function(){
      await sb.auth.signOut(); location.reload();
    });
    el("create").addEventListener("click", async function(){
      this.disabled = true; say("");
      var res = await sb.rpc("create_league", {
        league_name: el("lname").value.trim() || "My League",
        team_name:   el("tname").value.trim() || "My Team",
        settings:    DEFAULTS});
      this.disabled = false;
      if (res.error) return say(res.error.message, true);
      await loadAll(); if (LG) watch(); route();
    });
    el("join").addEventListener("click", async function(){
      var code = el("code").value.trim().toUpperCase();
      if (code.length < 4) return say("That code looks too short.", true);
      this.disabled = true; say("");
      var res = await sb.rpc("join_league", {code: code,
        team_name: el("jtname").value.trim() || "New Team"});
      this.disabled = false;
      if (res.error) return say(res.error.message, true);
      await loadAll(); if (LG) watch(); route();
    });
    el("copy").addEventListener("click", async function(){
      try { await navigator.clipboard.writeText(LG.join_code); this.textContent = "Copied";
            var b = this; setTimeout(function(){ b.textContent = "Copy"; }, 1500); }
      catch (e){ say("Couldn't copy - the code is " + LG.join_code, true); }
    });
    el("startdraft").addEventListener("click", function(){ startDraft(); });
    el("revert-settings").addEventListener("click", function(){ dirty = false; renderSettings(); say(""); });
    el("save-settings").addEventListener("click", async function(){
      var next = readForm();
      this.disabled = true; say("");
      var res = await sb.from("leagues").update({settings: next}).eq("id", LG.id).select();
      this.disabled = false;
      if (res.error) return say(res.error.message, true);
      if (!res.data || !res.data.length)
        return say("That didn't save - only the commissioner can change league settings.", true);
      applyLeague(res.data[0]); dirty = false; renderSettings(); renderLobby(); flashSaved();
    });
  }

  /* ---- start ---- */
  if (typeof supabase === "undefined" || !supabase.createClient){
    el("boot").textContent = "";
    say("Couldn't load the Supabase library. Check your connection or an ad blocker, then reload.", true);
    return;
  }
  if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY){
    el("boot").textContent = "";
    say("config.js is missing its Supabase values.", true);
    return;
  }
  sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  wire();
  sb.auth.onAuthStateChange(function(){ if (booted) boot(); });
  booted = true;
  boot();
})();
