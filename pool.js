/* =============================================================
   Saturdays Fantasy - the player pool and the scoring rules.

   Pure: no database, no DOM, no league config. Every browser that
   loads this file builds a byte-identical pool, which is what lets
   a draft be shared without a players table. Weekly stat lines come
   from a seeded generator keyed on the player and the league's own
   seed, so a simulated week gives the same answer to everyone and
   never changes when you look at it again.
   ============================================================= */
(function(){
  "use strict";

  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function r1(n){ return Math.round(n * 10) / 10; }
  function mmss(sec){
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ":" + (sec % 60 < 10 ? "0" : "") + (sec % 60);
  }
  function hash(str){
    var h = 2166136261;
    for (var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed){
    return function(){
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var RAW = [
    "Deshawn Pryor|QB|Georgia|96","Cal Whitaker|QB|Ohio State|94","Trey Mendenhall|QB|Texas|91","Rowan Diaz|QB|Oregon|89",
    "Bo Hargrove|QB|LSU|87","Micah Sowell|QB|Penn State|85","Jaylen Rourke|QB|Miami|83","Easton Marsh|QB|Utah|81",
    "Kip Delacroix|QB|Ole Miss|79","Silas Brandt|QB|Iowa|77","Nate Kowalczyk|QB|Kansas State|75","Devontae Hurst|QB|Louisville|73",
    "Gus Farrow|QB|Boise State|71","Arlo Benitez|QB|Tulane|69","Dane Coffey|QB|Memphis|67","Rem Castellano|QB|Appalachian State|65",
    "Tyrell Banks|RB|Alabama|95","Quinton Mabry|RB|Michigan|93","Jomar Stitt|RB|Notre Dame|90","Kelvin Ashby|RB|Texas A&M|88",
    "Dorian Pell|RB|Oklahoma|86","Isaiah Crumb|RB|Wisconsin|84","Marquise Tolliver|RB|Florida State|82","Beau Rinehart|RB|Nebraska|80",
    "Zavier Nkemdi|RB|Clemson|78","Hollis Rainey|RB|Tennessee|76","Trace Winfield|RB|Baylor|74","Omar Sylla|RB|Pittsburgh|72",
    "Kobe Anyanwu|RB|Maryland|71","Rudy Vance|RB|Arizona State|70","Dillard Means|RB|Kentucky|69","Jaquan Poe|RB|NC State|68",
    "Nico Ferrante|RB|Washington State|67","Cormac Riggs|RB|Air Force|66","Pierce Gallo|RB|Syracuse|65","Elias Thorne|RB|Duke|64",
    "Malachi Doss|RB|Purdue|63","Sekou Barrow|RB|Rutgers|62","Wyatt Lindberg|RB|Iowa State|61","Tobias Frame|RB|UCF|60",
    "Amari Shields|WR|Ohio State|97","Jace Okonkwo|WR|Texas|94","Rashad Levine|WR|USC|92","Camden Pike|WR|Oregon|90",
    "Tevin Marchetti|WR|Georgia|89","Darius Fontenot|WR|LSU|87","Kobi Strand|WR|Washington|85","Jalen Beauchamp|WR|Florida|84",
    "Ezra Kalani|WR|Michigan|82","Sterling Dupree|WR|Auburn|81","Marcus Vieira|WR|Miami|79","Tarik Osei|WR|Illinois|78",
    "Brady Nordstrom|WR|BYU|76","Lamont Rives|WR|South Carolina|75","Cassius Wren|WR|TCU|73","Imani Blackwood|WR|Arkansas|72",
    "Dov Ackerman|WR|Northwestern|70","Rafe Mulhern|WR|Virginia Tech|69","Jamarion Teague|WR|Missouri|68","Solomon Vega|WR|Colorado|67",
    "Hayden Kirsch|WR|Minnesota|66","Zion Prather|WR|Houston|65","Ottis Lanier|WR|SMU|64","Finn Halloran|WR|Cincinnati|63",
    "Deacon Mbeki|WR|Texas Tech|62","Gio Passarelli|WR|Oklahoma State|61","Kwame Ellsworth|WR|Indiana|60","Ruben Alcaraz|WR|San Diego State|59",
    "Tripp Dunleavy|WR|Navy|58","Xavier Mott|WR|Toledo|57","Lucien Bray|WR|Liberty|56","Hutch Ivory|WR|Army|55",
    "Grady Holloway|TE|Iowa|88","Niko Vandermeer|TE|Penn State|85","Bryson Cade|TE|Georgia|83","Marcel Ito-Brown|TE|Oregon|80",
    "Cash Renfro|TE|Texas|78","Uriah Stedman|TE|Notre Dame|76","Levi Marchand|TE|Michigan State|74","Thaddeus Nkere|TE|Virginia|72",
    "Boone Tillery|TE|Mississippi State|70","Ander Solberg|TE|Utah State|68","Jericho Pang|TE|Cal|66","Ronin Dupre|TE|Tulsa|64",
    "Odell Fisk|TE|Wake Forest|62","Santino Lavoie|TE|Boston College|60","Kellan Ruiz|TE|Fresno State|58","Marek Vlasic|TE|Temple|56",
    "Diego Salcedo|K|Alabama|79","Finnian O'Rourke|K|Ohio State|76","Pavel Rusk|K|Texas|74","Auggie Bellini|K|Georgia|72",
    "Hiro Tanaka|K|Oregon|70","Wes Cudworth|K|Michigan|68","Kingsley Amos|K|LSU|66","Marek Zielinski|K|Nebraska|64",
    "Tate Holcomb|K|Auburn|62","Ivo Petrov|K|Kansas|60","Sandy McAllister|K|Oregon State|58","Bram Voss|K|Marshall|56",
    "Chip Landry|K|Louisiana|54","Yusuf Adebayo|K|Akron|52"
  ];
  var FIRST = ["Ashton","Brennan","Cordell","Darnell","Emmitt","Fletcher","Garrett","Holden","Ishmael","Jonas",
               "Keaton","Lachlan","Montrell","Nash","Orlando","Payton","Quade","Rylan","Shane","Tanner",
               "Ulises","Vance","Wilder","Xander","Yance","Zeke","Bodhi","Corbin","Dax","Ellis",
               "Foster","Grant","Hakeem","Idris","Jerome","Kwesi"];
  var LAST  = ["Amado","Bly","Cantrell","Dorsett","Eastwood","Fairbanks","Gentry","Hollins","Ingram","Jarrell",
               "Keegan","Lombard","Maddox","Nunez","Ogilvie","Prescott","Quillen","Rossiter","Sundberg","Tate",
               "Underwood","Valdez","Whitlock","Yarborough","Ziegler","Boyette","Crosswhite","Dupont","Erskine","Fontana",
               "Grimsley","Hadley","Iverson","Jessup","Kerrigan","Larkin"];
  var DEPTH = {QB:12, RB:24, WR:30, TE:14, K:10};

  var POSITIONS = ["QB","RB","WR","TE","K","DEF"];
  var FLEX_POS = ["RB","WR","TE"];
  function flexOk(pos){ return FLEX_POS.indexOf(pos) >= 0; }
  function fits(slot, pos){ return slot === "FLEX" ? flexOk(pos) : slot === pos; }

  var TEAM_POOL = [
    {name:"Hail Marys", abbr:"HAIL"}, {name:"Option Reads", abbr:"OPTN"},
    {name:"Blue Bloods", abbr:"BLUE"}, {name:"Cupcake Week", abbr:"CAKE"},
    {name:"Tailgate Club", abbr:"TGTE"}, {name:"Bowl Eligible", abbr:"BOWL"},
    {name:"Portal Kings", abbr:"PRTL"}, {name:"Triple Option", abbr:"TRPL"},
    {name:"Red Zone Rats", abbr:"RZRT"}, {name:"Walk-Ons", abbr:"WALK"},
    {name:"Homecoming", abbr:"HOME"}, {name:"Two-Minute Drill", abbr:"2MIN"}
  ];
  var ME = 0;
  var BOARD_LENGTH = 6;

  var PLAYERS = RAW.map(function(line, i){
    var f = line.split("|");
    return {id:i, name:f[0], pos:f[1], school:f[2], rating:parseInt(f[3],10)};
  });
  (function buildDepth(){
    var schools = [], seen = {};
    PLAYERS.forEach(function(p){ if (!seen[p.school]){ seen[p.school] = 1; schools.push(p.school); } });
    var names = {}, id = PLAYERS.length, k = 0;
    PLAYERS.forEach(function(p){ names[p.name] = 1; });
    POSITIONS.forEach(function(pos){
      var n = DEPTH[pos], floor = pos === "K" ? 30 : 34;
      for (var i = 0; i < n; i++){
        var nm, tries = 0;
        do {
          nm = FIRST[(k * 5 + tries * 7) % FIRST.length] + " " + LAST[(k * 11 + tries * 3) % LAST.length];
          tries++;
        } while (names[nm] && tries < 40);
        names[nm] = 1;
        PLAYERS.push({
          id: id++, name: nm, pos: pos,
          school: schools[(k * 17) % schools.length],
          rating: Math.max(floor, 54 - Math.round(i * (54 - floor) / Math.max(1, n - 1)))
        });
        k++;
      }
    });
  })();
  /* One draftable unit per school: a whole team's defence, scored as one line. */
  (function buildDefenses(){
    var seen = {}, schools = [], id = PLAYERS.length;
    PLAYERS.forEach(function(p){ if (!seen[p.school]){ seen[p.school] = 1; schools.push(p.school); } });
    schools.forEach(function(school){
      var r = rng(hash(school));
      PLAYERS.push({id:id++, name:school, pos:"DEF", school:"Team defense",
                    rating: 50 + Math.floor(r() * 31)});
    });
  })();
  PLAYERS.sort(function(a,b){ return b.rating - a.rating || a.name.localeCompare(b.name); });

  /* A player's identity is a slug, not a position in this array. Add a player
     to the pool later and every already-drafted pick still points at the same
     person - which an array index would not. */
  var byKey = {}, used = {};
  PLAYERS.forEach(function(p){
    var base = (p.pos + "-" + p.name + "-" + p.school)
                 .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    var k = base, n = 2;
    while (used[k]) k = base + "-" + (n++);
    used[k] = 1;
    p.key = k;
    byKey[k] = p;
  });
  function P(key){ return byKey[key] || null; }

  /* Fantasy convention: a shutout is worth a lot, a blowout loss costs you. */
  function paPoints(pa){
    if (pa === 0) return 10;
    if (pa <= 6) return 7;
    if (pa <= 13) return 4;
    if (pa <= 20) return 1;
    if (pa <= 27) return 0;
    if (pa <= 34) return -1;
    return -3;
  }
  function points(st){
    var p = 0;
    if (st.paGiven !== undefined){
      p += (st.sacks || 0) + (st.dInt || 0) * 2 + (st.fumRec || 0) * 2 +
           (st.defTD || 0) * 6 + (st.safety || 0) * 2 + paPoints(st.paGiven);
      return r1(p);
    }
    p += (st.passYds || 0) / 25 + (st.passTD || 0) * 4 - (st.intc || 0) * 2;
    p += (st.rushYds || 0) / 10 + (st.rushTD || 0) * 6;
    p += (st.recYds || 0) / 10 + (st.recTD || 0) * 6 + (st.rec || 0) * 0.5;
    p += (st.fg0 || 0) * 3 + (st.fg40 || 0) * 4 + (st.fg50 || 0) * 5 + (st.xp || 0);
    p -= (st.fum || 0) * 2;
    return r1(p);
  }
  function qOf(p){
    return p.pos === "DEF"
      ? Math.max(0, Math.min(1, (p.rating - 50) / 30))
      : Math.max(0, Math.min(1, (p.rating - 50) / 47));
  }
  function statLine(p, week, seed){
    var r = rng(hash(p.key) + week * 104729 + seed * 7717);
    var q = qOf(p);
    var m = 0.45 + r() * 1.15;
    var st = {};
    if (p.pos === "QB"){
      st.passYds = Math.round((150 + q * 175) * m);
      st.passTD  = Math.round((0.5 + q * 2.4) * m * (0.55 + r() * 0.95));
      st.intc    = r() < 0.34 - q * 0.14 ? 1 : 0;
      st.rushYds = Math.round((4 + q * 34) * (0.25 + r() * 1.5));
      st.rushTD  = r() < 0.09 + q * 0.2 ? 1 : 0;
    } else if (p.pos === "RB"){
      st.rushAtt = Math.round((7 + q * 13) * m);
      st.rushYds = Math.round(st.rushAtt * (3.0 + q * 2.6) * (0.6 + r() * 0.8));
      st.rushTD  = r() < 0.16 + q * 0.5 ? (r() < 0.2 ? 2 : 1) : 0;
      st.rec     = Math.round((0.6 + q * 3.2) * (0.4 + r() * 1.4));
      st.recYds  = Math.round(st.rec * (5 + q * 6) * (0.6 + r() * 0.9));
    } else if (p.pos === "WR" || p.pos === "TE"){
      var sc = p.pos === "WR" ? 1 : 0.78;
      st.rec    = Math.round((1.4 + q * 5.4) * sc * m);
      st.recYds = Math.round(st.rec * (8 + q * 8) * (0.6 + r() * 0.9));
      st.recTD  = r() < (0.11 + q * 0.44) * sc ? (r() < 0.12 ? 2 : 1) : 0;
    } else if (p.pos === "DEF"){
      st.sacks  = Math.max(0, Math.round((1.2 + q * 3.4) * m));
      st.dInt   = r() < 0.30 + q * 0.48 ? (r() < 0.22 ? 2 : 1) : 0;
      st.fumRec = r() < 0.25 + q * 0.32 ? 1 : 0;
      st.defTD  = r() < 0.04 + q * 0.13 ? 1 : 0;
      st.safety = r() < 0.03 ? 1 : 0;
      st.paGiven = Math.max(0, Math.round((40 - q * 30) * (0.55 + r() * 0.85)));
      return st;
    } else {
      var att = 1 + Math.floor(r() * 4);
      st.fg0 = 0; st.fg40 = 0; st.fg50 = 0; st.fgMiss = 0;
      for (var i = 0; i < att; i++){
        var d = r(), made = r() < 0.6 + q * 0.32;
        if (!made) st.fgMiss++;
        else if (d < 0.5) st.fg0++;
        else if (d < 0.82) st.fg40++;
        else st.fg50++;
      }
      st.xp = 1 + Math.floor(r() * 4);
    }
    st.fum = r() < 0.06 ? 1 : 0;
    return st;
  }
  function weekPts(key, week, seed){ var p = P(key); return p ? points(statLine(p, week, seed)) : 0; }
  /* Fitted to this generator's actual long-run output, not guessed.
     Least squares on q, 400 weeks x 5 seeds, r-squared 0.969-1.000. */
  function projOf(p){
    var q = qOf(p);
    if (p.pos === "QB")  return r1( 8.3 + q * 22.4);
    if (p.pos === "RB")  return r1( 3.7 + q * 17.7);
    if (p.pos === "WR")  return r1( 2.3 + q * 15.3);
    if (p.pos === "TE")  return r1( 1.9 + q * 11.3);
    if (p.pos === "DEF") return r1(Math.max(0, -0.1 + q * 12.2));
    return r1( 7.9 + q *  2.9);
  }
  function statText(p, st){
    if (p.pos === "DEF")
      return st.sacks + (st.sacks === 1 ? " sack" : " sacks") +
             (st.dInt ? ", " + st.dInt + " INT" : "") +
             (st.fumRec ? ", " + st.fumRec + " FR" : "") +
             (st.defTD ? ", def TD" : "") + (st.safety ? ", safety" : "") +
             ", " + st.paGiven + " allowed";
    if (p.pos === "QB")
      return st.passYds + " pass, " + st.passTD + " TD" + (st.intc ? ", " + st.intc + " INT" : "") +
             (st.rushYds >= 15 ? ", " + st.rushYds + " rush" : "") + (st.rushTD ? " + TD" : "");
    if (p.pos === "RB")
      return st.rushAtt + " car, " + st.rushYds + " yds" + (st.rushTD ? ", " + st.rushTD + " TD" : "") +
             (st.rec ? ", " + st.rec + " rec " + st.recYds : "");
    if (p.pos === "K")
      return (st.fg0 + st.fg40 + st.fg50) + "/" + (st.fg0 + st.fg40 + st.fg50 + st.fgMiss) + " FG, " + st.xp + " XP";
    return st.rec + " rec, " + st.recYds + " yds" + (st.recTD ? ", " + st.recTD + " TD" : "");
  }


  window.SFPool = {
    VERSION:   1,
    PLAYERS:   PLAYERS,
    P:         P,
    POSITIONS: POSITIONS,
    FLEX_POS:  FLEX_POS,
    TEAM_POOL: TEAM_POOL,
    flexOk:    flexOk,
    fits:      fits,
    points:    points,
    statLine:  statLine,
    weekPts:   weekPts,
    projOf:    projOf,
    statText:  statText,
    qOf:       qOf,
    hash:      hash,
    rng:       rng,
    r1:        r1,
    mmss:      mmss,
    esc:       esc
  };
})();
