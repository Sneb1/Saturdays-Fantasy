/* =============================================================
   Saturdays Fantasy - roster shape, lineups, and how CPU teams draft.

   Pure. Everything is passed in: the league's settings, who has been
   taken, whose roster is whose. No database, no DOM, no globals - so
   the draft room and the season view can share it, and so it can be
   tested without a browser.
   ============================================================= */
(function(){
  "use strict";
  var Pool = window.SFPool;
  var POSITIONS = Pool.POSITIONS, flexOk = Pool.flexOk, fits = Pool.fits;
  var projOf = Pool.projOf, rng = Pool.rng, P = Pool.P, r1 = Pool.r1;

  function nslots(cfg, pos){ return (cfg.slots && cfg.slots[pos]) || 0; }
  function starterTotal(cfg){
    return POSITIONS.reduce(function(s,p){ return s + nslots(cfg,p); }, 0) + (cfg.flex || 0);
  }
  function rosterSize(cfg){ return starterTotal(cfg) + (cfg.bench || 0); }
  function totalPicks(cfg, nteams){ return nteams * rosterSize(cfg); }

  /* FLEX sits after the dedicated slots on purpose. Filling each dedicated
     slot with the best of its own position first, then letting FLEX take the
     best of whatever is left, is optimal because FLEX is the permissive slot -
     nothing it could take would be worth more somewhere else. */
  function slotList(cfg){
    var out = [];
    ["QB","RB","WR","TE"].forEach(function(p){
      for (var i = 0; i < nslots(cfg,p); i++) out.push(p);
    });
    for (var i = 0; i < (cfg.flex || 0); i++) out.push("FLEX");
    for (var j = 0; j < nslots(cfg,"K");   j++) out.push("K");
    for (var k = 0; k < nslots(cfg,"DEF"); k++) out.push("DEF");
    return out;
  }

  /* Give every player on a roster the slot he would occupy, in draft order. */
  function slotWalk(cfg, keys){
    var used = {}, flexUsed = 0;
    POSITIONS.forEach(function(p){ used[p] = 0; });
    return keys.map(function(key){
      var pl = P(key);
      if (!pl) return {key:key, player:null, slot:"BN"};
      var pos = pl.pos, slot;
      if (used[pos] < nslots(cfg,pos)){ slot = pos; used[pos]++; }
      else if (flexOk(pos) && flexUsed < (cfg.flex||0)){ slot = "FLEX"; flexUsed++; }
      else slot = "BN";
      return {key:key, player:pl, slot:slot};
    });
  }
  function countsFor(cfg, keys){
    var c = {}; POSITIONS.forEach(function(p){ c[p] = 0; });
    keys.forEach(function(k){ var p = P(k); if (p) c[p.pos]++; });
    return c;
  }
  function fillFor(cfg, keys){
    var f = {flex:0, bench:0};
    slotWalk(cfg, keys).forEach(function(r){
      if (r.slot === "FLEX") f.flex++; else if (r.slot === "BN") f.bench++;
    });
    return f;
  }
  /* Can a player at this position ever enter a starting lineup in this
     league? With no slot at his position and no FLEX that accepts him, he
     cannot - not on the bench, not ever. Leagues that switch kickers or
     defences off are the case that matters. */
  function startable(cfg, pos){
    return nslots(cfg, pos) > 0 || (flexOk(pos) && (cfg.flex || 0) > 0);
  }
  function available(takenSet){
    return Pool.PLAYERS.filter(function(p){ return !takenSet[p.key]; });
  }

  /* ---- how CPU teams draft ------------------------------------------------
     Value is projected points over replacement, not raw rating, so positions
     are comparable: the gap from the best quarterback to the last startable
     one is worth more than the same gap among kickers, which is why kickers
     and defences fall to the end on their own.

     Need scales that value. A player who fills an empty starting slot is worth
     full price, a FLEX body nearly as much, anyone else about half. Half, not
     nothing - a CPU will still take a genuinely elite player it does not need
     over a mediocre one it does. Each team draws its own positional biases and
     its own appetite for reaching from the league seed, so a league does not
     play out the same way twice, and the last picks are forced onto unfilled
     starting slots so nobody finishes unable to field a lineup. */
  function profileFor(cfg, teamIndex){
    var r = rng((cfg.seed||1) * 31 + teamIndex * 977 + 13);
    var prof = {bias:{}, reach: 0.06 + r() * 0.16};
    POSITIONS.forEach(function(p){ prof.bias[p] = 0.90 + r() * 0.22; });
    return prof;
  }
  function replacementProj(cfg, pool, pos, nteams){
    var at = pool.filter(function(p){ return p.pos === pos; });
    if (!at.length) return 0;
    var demand = nteams * Math.max(1, nslots(cfg,pos));
    return projOf(at[Math.min(at.length - 1, demand - 1)]);
  }
  function cpuPickKey(cfg, o){
    var pool = available(o.taken);
    if (!pool.length) return null;
    var counts = countsFor(cfg, o.roster), fill = fillFor(cfg, o.roster);
    var left = rosterSize(cfg) - o.roster.length;
    var needByPos = {}, needTotal = 0;
    POSITIONS.forEach(function(p){
      needByPos[p] = Math.max(0, nslots(cfg,p) - counts[p]);
      needTotal += needByPos[p];
    });
    var flexNeed = Math.max(0, (cfg.flex||0) - fill.flex);
    needTotal += flexNeed;
    var mustFill = left <= needTotal;
    var prof = profileFor(cfg, o.teamIndex);
    var rnd = rng((cfg.seed||1) * 7 + o.teamIndex * 131 + o.pickNo * 17);
    var repl = {};
    POSITIONS.forEach(function(p){ repl[p] = replacementProj(cfg, pool, p, o.nteams); });

    /* The best you already hold at each position. For a slot you can only
       start one of, this - not league replacement - is what a new body would
       have to beat to be worth anything. */
    var ownBest = {};
    POSITIONS.forEach(function(p){ ownBest[p] = 0; });
    o.roster.forEach(function(k){
      var pl = P(k); if (pl) ownBest[pl.pos] = Math.max(ownBest[pl.pos], projOf(pl));
    });

    var best = null, bestV = -Infinity;
    for (var i = 0; i < pool.length; i++){
      var pl = pool[i], need;
      if (!startable(cfg, pl.pos)) continue;          /* unusable in this league */
      if (needByPos[pl.pos] > 0) need = 1;
      else if (flexOk(pl.pos) && flexNeed > 0) need = 0.92;
      else if (flexOk(pl.pos)) need = 0.5;
      /* A bench player is only worth having if he can ever be started. A
         spare running back covers a bye, an injury, or a hot week through
         FLEX. A second defence or a third quarterback in a one-of-each
         league can never enter a lineup at all, so it is close to dead
         weight however good it looks on the board. */
      else need = 0.12;
      if (mustFill && need < 0.9) continue;
      var jitter = 1 - prof.reach + rnd() * prof.reach * 2;
      var value  = need <= 0.12
        ? Math.max(0.2, projOf(pl) - ownBest[pl.pos])          /* upgrade over your own */
        : Math.max(0.4, projOf(pl) - repl[pl.pos] + 0.5);      /* value over replacement */
      var score  = value * need * prof.bias[pl.pos] * jitter;
      if (score > bestV){ bestV = score; best = pl.key; }
    }
    return best === null ? autoPickKey(cfg, o) : best;
  }

  /* A human's clock-expiry autopick stays on the simple stated rule: fill your
     own empty position first, then FLEX, then the best startable body. */
  function autoPickKey(cfg, o){
    var pool = available(o.taken);
    if (!pool.length) return null;
    var counts = countsFor(cfg, o.roster), flexUsed = fillFor(cfg, o.roster).flex;
    for (var i = 0; i < pool.length; i++){
      var pos = pool[i].pos;
      if (counts[pos] < nslots(cfg,pos)) return pool[i].key;
      if (flexOk(pos) && flexUsed < (cfg.flex||0)) return pool[i].key;
    }
    for (var j = 0; j < pool.length; j++) if (flexOk(pool[j].pos)) return pool[j].key;
    for (var m = 0; m < pool.length; m++) if (startable(cfg, pool[m].pos)) return pool[m].key;
    return pool[0].key;
  }

  /* ---- lineups ---------------------------------------------------------- */
  function bestLineup(cfg, keys, week, scoreBy){
    var used = {}, out = [];
    slotList(cfg).forEach(function(slot){
      var best = null, bestV = -Infinity;
      keys.forEach(function(k){
        var pl = P(k);
        if (!pl || used[k] || !fits(slot, pl.pos)) return;
        var v = scoreBy === "actual" ? Pool.weekPts(k, week, cfg.seed||1) : projOf(pl);
        if (v > bestV){ bestV = v; best = k; }
      });
      if (best !== null) used[best] = 1;
      out.push(best);
    });
    return out;
  }
  function lineupPts(cfg, line, week){
    return r1(line.reduce(function(s,k){
      return s + (k ? Pool.weekPts(k, week, cfg.seed||1) : 0); }, 0));
  }
  function lineupProj(line){
    return r1(line.reduce(function(s,k){
      var p = k && P(k); return s + (p ? projOf(p) : 0); }, 0));
  }

  window.SFRoster = {
    nslots:nslots, starterTotal:starterTotal, rosterSize:rosterSize, totalPicks:totalPicks,
    slotList:slotList, slotWalk:slotWalk, countsFor:countsFor, fillFor:fillFor,
    available:available, startable:startable, cpuPickKey:cpuPickKey, autoPickKey:autoPickKey,
    replacementProj:replacementProj, bestLineup:bestLineup,
    lineupPts:lineupPts, lineupProj:lineupProj
  };
})();
