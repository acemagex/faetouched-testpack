// Faetouched gases (B-034, knowledge/systems/gases.md): the world simulation of gas cloud blocks, the reactions,
// the gas vent (an MBD2 kinetic machine) and collector ticks (the collector also draws rime from ice: K3, and takes a filter), Create fans and nozzles
// moving gas, the gas filters, the wake-ups, Create open pipe ends, the tags and recipes, the K2 reading of gas by registered blocks, the K5 lamp's detection, the /gas test command and the
// /gas debug test rig.
// The gas table, the reaction table, the fluids and blocks, and the shared Java collections are made in
// startup_scripts/faetouched_gases.js. Every recipe gets an explicit faetouched: ID (CLAUDE.md). Rhino rejects
// const/let redeclared inside loop bodies, so this file uses var and plain functions.
//
// One update of a cell holding L layers of gas g. "Ahead" is the cell above for a rising gas, below for a sinking
// one; every move is the same for both directions, mirrored.
//   0. primed by an explosion: a gas that explodes (hydrogen, firedamp) ignites now, within the per-tick ignition cap
//   1. a rising gas at or above its ceiling (per dimension: the world's top cell, or a Y the table gives) loses one
//      layer; a sinking gas whose cell ahead is outside the build height (a void below) loses all its layers (the
//      failsafe); nothing else
//   2. reactions: the gas's rules against its six neighbours; the first that fires is applied and ends the update (a
//      block result changes the partner block, or turns the cell into a block, instead of making gas: slice 3; a rule's
//      conditions, such as sky, storm or warm, are read at the cell first and need no neighbour: slice 4)
//   2a. held by a running Create fan's current or a nozzle (spec-fans-pumps): the update ends here, unqueued; the fan's own
//      step (the airflow tick, "Fans and nozzles" below) moves the gas along the current, whatever its buoyancy
//   3. density swap: if the cell ahead (looking through any permeable run) holds another gas that g passes (rising:
//      g is lighter; sinking: g is heavier), the two cells trade places, layers and all; the update ends. Every pair
//      of different gases swaps, so the denser gas always ends below
//   4. move: straight ahead (through any run of permeable blocks, up to GAS_PERMEABLE_MAX; a plain move into the
//      adjacent cell first rolls the gas's drift chance and, on a hit, splits: half its layers go diagonally ahead if
//      they can, the rest straight), else diagonally ahead,
//      else spread one layer to the sides (also through permeable runs), else flow one step toward the nearest way
//      ahead within 4 cells (looking through permeable blocks), else pressure: one layer to the nearest cell with
//      room strictly ahead of p, found by a breadth-first search through air and the same gas that never steps
//      behind p and crosses permeable runs in a straight line (communicating vessels)
// There is no mixing step (removed, the author's call, 2026-11-18): gases that should combine get a reaction rule.
// Gas moves only into air or the same gas, and only destroys layers above its ceiling, below the world or in a
// reaction. A cell that changed is updated again after the gas's interval. Wake-ups (rule E, gasWakeWide): the cell a
// move leaves, both cells of a swap and a broken or placed block wake the gas around them; a filled cell wakes its
// six neighbours; both also wake the first gas cell past a permeable run in each of the six directions. A cell that
// didn't change drops out of the queue until something wakes it (a neighbour moving, a block broken or placed
// nearby, an explosion, a random tick).

var GAS_UPDATES_PER_TICK = 64 // shared by all dimensions; tune with spark
// Each gas's interval in the startup table is a relative flow rate; the simulation multiplies it by this. The author's
// call, 2026-11-18: gas at a third of the old rate (real gas moves slowly, and slower is more tactile). Everything
// timed by the interval follows (requeues, reaction retries); the vent and collector (every 10 ticks) and Create's
// open pipe ends don't. Set here, so /reload applies a change with no restart.
var GAS_INTERVAL_SCALE = 3
var GAS_LAYER_MB = 125 // 1 layer = 125 mB, 8 layers = 1000 mB
var GAS_SLOPE_REACH = 4 // how far a stuck cell looks along each side for a way ahead
// Permeable blocks in a row that gas crosses in one move, pressure search or swap (spec 5: any thickness; this is
// only a safety cap on the cells read, the build height being the other bound). A longer run blocks gas.
var GAS_PERMEABLE_MAX = 64
var GAS_PRESSURE_REACH = 48 // cells one pressure search may visit (permeable cells it crosses count)
var GAS_PRESSURE_VISITS_PER_TICK = 192 // cells all pressure searches may visit in one server tick; a search that could go over waits a tick
var GAS_IGNITIONS_PER_TICK = 2 // explosions from reactions per server tick; the rest wait
var GAS_REACTION_RETRY = 10 // ticks at least before a cell whose reaction roll failed checks again
var GAS_PERMEABLE_TAG = 'faetouched:gas_permeable'
// Drift (B-034, prototypes/gases/specs/spec-drift.md): the chance that a straight move ahead splits the cell, half its
// layers to an open diagonal and the rest straight (spec-top-split.md), so a plume spreads and thins into a cone. The
// author's call, 2026-11-20: lighter gases drift more. A gas table entry's `drift` (0 to 1) overrides these.
var GAS_DRIFT_RISING = 0.33
var GAS_DRIFT_SINKING = 0.2
// Ceilings (spec-top-split, the author's request, 2026-11-20): a table `ceiling: 'top'` is the top cell of the world the
// gas is in, level.getMaxBuildHeight() - 1 (LevelHeightAccessor's one-signature default method; no hit in the KubeJS
// jar): overworld 319, the End 255. A number is that Y. GAS_CEILING_FALLBACK is used only if that call fails in game
// (warned once per dimension): the ceiling of every rising gas before 'top'.
var GAS_CEILING_TOP = 'top'
var GAS_CEILING_FALLBACK = 192

var GasTreeMap = Java.loadClass('java.util.TreeMap')
var GasArrayDeque = Java.loadClass('java.util.ArrayDeque')
var GasHashSet = Java.loadClass('java.util.HashSet')
var GasHashMap = Java.loadClass('java.util.HashMap')
var GasLong = Java.loadClass('java.lang.Long')
var GasFluidStack = Java.loadClass('net.neoforged.neoforge.fluids.FluidStack')
var GasFluidAction = Java.loadClass('net.neoforged.neoforge.fluids.capability.IFluidHandler$FluidAction')

var GAS_QUEUES = global.faetouchedGasQueues
var GAS_MEMBERS = global.faetouchedGasMembers
var GAS_INBOX = global.faetouchedGasInbox
var GAS_PIPE = global.faetouchedGasPipe
var GAS_PRIMED = global.faetouchedGasPrimed
var GAS_STATE = global.faetouchedGasState
var GAS_SETTLE = global.faetouchedGasSettle
// Fans and nozzles (spec-fans-pumps): null after a /reload that comes before the restart which makes them (no fan moves gas yet).
var GAS_FANS = global.faetouchedGasFans
var GAS_HELD = global.faetouchedGasHeld
var GAS_CURRENT_CELLS = global.faetouchedGasCurrentCells

// --- Vibrations (B-034, prototypes/gases/specs/spec-sculk.md): a reaction that fires emits a vanilla game event at the
// reacting cell's centre, so sculk sensors hear it and a calibrated sensor tells the reactions apart by the event's
// frequency (vanilla's VibrationSystem table, read in the 1.21.1 srg client jar: block_activate 10, block_change 11,
// fluid_pickup 12, fluid_place 13, explode 15; resonate_1 to resonate_15 give 1 to 15). A rule's shape is decided once at
// load (gasShapeOf) and picks the default; a rule's `vibration: '<minecraft game event id>'` or `false` overrides it.
// The call is GameEventDispatcher.post(Holder<GameEvent>, Vec3, GameEvent$Context), the one signature it has, on a
// dispatcher made for the level (its only constructor takes the ServerLevel, its only state). Not level.gameEvent: it has
// a (Holder, BlockPos, Context) overload beside the Vec3 one, and KubeJS wraps both BlockPos and Vec3, which Rhino scores
// alike (.claude/rules/kubejs.md), so the call could be ambiguous. NeoForge's ServerLevel.gameEvent only posts its
// cancellable VanillaGameEvent first and then calls the same post (read in neoforge-21.1.265-client.jar), so other mods'
// VanillaGameEvent listeners don't see these vibrations; sculk sensors, wardens and shriekers hear them as usual. GameEvent$Context's only constructor is (Entity, BlockState):
// no source entity and no state, made once (Context.of(null) is ambiguous). The holders are static fields of GameEvent.
var GasGameEvent = Java.loadClass('net.minecraft.world.level.gameevent.GameEvent')
var GasVec3 = Java.loadClass('net.minecraft.world.phys.Vec3')
var GasGameEventDispatcher = Java.loadClass('net.minecraft.world.level.gameevent.GameEventDispatcher')
var GAS_VIBRATION_CONTEXT = new (Java.loadClass('net.minecraft.world.level.gameevent.GameEvent$Context'))(null, null)
var GAS_VIBRATION_DEFAULT = {
  block: GasGameEvent.BLOCK_ACTIVATE, // frequency 10: a block result
  gas: GasGameEvent.BLOCK_CHANGE, // 11: the product is a gas (the whole-cell flip too)
  vanish: GasGameEvent.FLUID_PICKUP, // 12: no product, the gas is used up
  fluid: GasGameEvent.FLUID_PLACE, // 13: the product is a fluid
  explode: null // 15 already: vanilla's Explosion.explode emits EXPLODE itself, so nothing extra
}
var GAS_SETTLE_VIBRATION = GasGameEvent.FLUID_PLACE // 13: a settle conversion, whatever the gas

// The holder of a vanilla game event from its ID (minecraft:resonate_7 is GameEvent.RESONATE_7), or null when the ID isn't
// one: another namespace, an unknown name, or a static field that isn't a holder (CODEC, DEFAULT_NOTIFICATION_RADIUS).
function gasVibrationHolder(id) {
  var m = /^minecraft:([a-z0-9_]+)$/.exec(String(id))
  if (m == null) return null
  var name = m[1].toUpperCase()
  if (name == 'CODEC') return null
  // Rhino throws for a name that isn't a field of a Java class (NativeJavaClass.get ends in reportMemberNotFound, read in
  // rhino-2101.2.8), so an unknown event must be caught here or it would break the whole loader.
  var h = null
  try { h = GasGameEvent[name] } catch (err) { return null }
  if (h == null || typeof h != 'object') return null
  return h
}
// A rule's holder, or null for none: the rule's `vibration` field if it has one, else its shape's default. A field that
// isn't false or a vanilla game event ID is warned about (once per rule, at load) and the default is kept.
function gasVibrationOf(id, shape, v) {
  var def = GAS_VIBRATION_DEFAULT[shape]
  if (v === undefined) return def
  if (v === false || String(v) === 'false') return null
  var h = gasVibrationHolder(v)
  if (h == null) {
    console.warn('faetouched gases: reaction ' + id + ' has vibration: ' + v + " (use a minecraft: game event ID such as minecraft:resonate_7, or false); the shape's default is used")
    return def
  }
  return h
}
// The rule's shape, decided once. An explode effect counts as explode whatever the product (a block result loses its
// explode effect in the loader); then a block result, a fluid product, a gas product, else the gas is used up.
function gasShapeOf(r) {
  if (r.effect != null && r.effect.type == 'explode') return 'explode'
  if (r.k1 != null) return 'block'
  if (r.resultFluid != null) return 'fluid'
  if (r.resultGas >= 0) return 'gas'
  return 'vanish'
}
// One call per firing, after the reaction applied, at the cell's centre. A failing call must never undo a reaction.
function gasVibrate(level, holder, pos, id) {
  if (holder == null) return
  try {
    // A fresh dispatcher each call: one small object, and it can never hold a level from an earlier world.
    new GasGameEventDispatcher(level).post(holder, new GasVec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5), GAS_VIBRATION_CONTEXT)
  } catch (err) {
    gasWarnOnce('vibration ' + id, 'the vibration of ' + id + ' failed (' + err + '); it is skipped')
  }
}

var GAS_AIR = -1 // gasCell(): air
var GAS_BLOCKED = -2 // gasCell(): anything else, an unloaded chunk or outside the build height
var GAS_PERMEABLE = -3 // gasCell(): a block gas passes through (block tag faetouched:gas_permeable)
var GAS_H_DIRS = [Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST]
var GAS_H_STEPS = [[0, -1], [1, 0], [0, 1], [-1, 0]] // [x, z] steps of GAS_H_DIRS, in the same order
var GAS_ALL_DIRS = [Direction.UP, Direction.DOWN, Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST]
var GAS_ALL_STEPS = [[0, 1, 0], [0, -1, 0], [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]] // [x, y, z] steps of GAS_ALL_DIRS
var GAS_AIR_STATE = Blocks.AIR.defaultBlockState()
// Cells visited by pressure searches this tick. A script variable is enough: the tick handler resets it, and
// gasUpdate runs only from that handler, in the same copy of the script.
var gasPressureVisits = 0

function gasId(path) { return 'faetouched' + ':' + path }

// The tables cross from the startup script as script objects or as Java maps and lists; read either.
function gasField(o, k) {
  if (o == null) return undefined
  var v = o[k]
  if (v === undefined && typeof o.get === 'function' && typeof o.containsKey === 'function') v = o.containsKey(k) ? o.get(k) : undefined
  return v === null ? undefined : v
}
function gasKeys(o) {
  var keys = []
  if (o == null) return keys
  if (typeof o.keySet === 'function') {
    var ka = o.keySet().toArray()
    for (var x = 0; x < ka.length; x++) keys.push(String(ka[x]))
  } else Object.keys(o).forEach(k => keys.push(String(k)))
  return keys
}
// A list, a Java list, or a single value (a single object becomes a list of one).
function gasList(v) {
  var out = []
  if (v == null) return out
  if (Array.isArray(v) || (typeof v.length === 'number' && typeof v !== 'string')) {
    for (var i = 0; i < v.length; i++) out.push(v[i])
  } else if (typeof v.size === 'function' && typeof v.iterator === 'function' && typeof v.keySet !== 'function') {
    var it = v.iterator()
    while (it.hasNext()) out.push(it.next())
  } else out.push(v)
  return out
}

// The gas table, copied into this script's own objects. Cloud states are built once from the block's possible
// states (never setValue from a script): GAS_STATE_CODE maps a state to gas index * 16 + layers.
var GASES = []
var GAS_STATE_CODE = new GasHashMap()
var GAS_BY_FLUID = new GasHashMap()
;(function () {
  var table = gasList(global.faetouchedGases)
  for (var i = 0; i < table.length; i++) {
    var t = table[i]
    var g = {
      index: i, key: String(gasField(t, 'key')), dir: Number(gasField(t, 'dir')), density: Number(gasField(t, 'density')),
      ceiling: 1e9, ceilings: {},
      interval: Math.max(1, Number(gasField(t, 'interval'))) * GAS_INTERVAL_SCALE, states: [null], fluid: null, ceilingCache: {}
    }
    // ceiling (rising gases): a number is that Y; 'top' (GAS_CEILING_TOP) is the top cell of the world the gas is in,
    // resolved per dimension by gasCeiling; unset, no ceiling. Anything else (a string, true, NaN) is warned about (once,
    // here at load) and taken as 'top'.
    var rawCeil = gasField(t, 'ceiling')
    if (rawCeil === undefined) g.ceiling = 1e9
    else if (String(rawCeil) == GAS_CEILING_TOP) g.ceiling = GAS_CEILING_TOP
    else {
      var cv = (typeof rawCeil == 'string' || typeof rawCeil == 'boolean') ? NaN : Number(rawCeil)
      if (isFinite(cv)) g.ceiling = cv
      else {
        console.warn('faetouched gases: gas ' + g.key + ' has ceiling: ' + rawCeil + " (use a Y number or 'top'); the world's top is used")
        g.ceiling = GAS_CEILING_TOP
      }
    }
    // settles: { into: { fluid }, after }: full and still for `after` ticks (real time, not scaled), the cell becomes
    // a source of that fluid (gasUpdate).
    g.settle = null
    var settles = gasField(t, 'settles')
    if (settles !== undefined) {
      var into = gasField(settles, 'into')
      var sf = into !== undefined ? gasField(into, 'fluid') : undefined
      var after = gasField(settles, 'after')
      if (sf !== undefined) g.settle = { fluid: String(sf), after: Math.max(1, Number(after !== undefined ? after : 20)), state: null }
    }
    // drift (optional, 0 to 1): the default by direction; a value that isn't a number from 0 to 1 is warned about (once,
    // here at load) and the default is kept.
    var driftDefault = g.dir > 0 ? GAS_DRIFT_RISING : GAS_DRIFT_SINKING
    g.drift = driftDefault
    var rawDrift = gasField(t, 'drift')
    if (rawDrift !== undefined) {
      var dv = (typeof rawDrift == 'string' || typeof rawDrift == 'boolean') ? NaN : Number(rawDrift)
      if (dv >= 0 && dv <= 1) g.drift = dv
      else console.warn('faetouched gases: gas ' + g.key + ' has drift: ' + rawDrift + ' (use a number from 0 to 1); the default ' + driftDefault + ' is used')
    }
    var over = gasField(t, 'ceilings')
    gasKeys(over).forEach(k => { g.ceilings[k] = Number(gasField(over, k)) })
    var block = Block.getBlock(gasId(g.key + '_cloud'))
    var states = block.getStateDefinition().getPossibleStates()
    for (var s = 0; s < states.size(); s++) {
      var st = states.get(s)
      var layers = Number(st.getValue(BlockProperties.LAYERS))
      g.states[layers] = st
      GAS_STATE_CODE.put(st, i * 16 + layers)
    }
    g.fluid = Fluid.getType(gasId(g.key))
    GAS_BY_FLUID.put(g.fluid, i)
    GAS_BY_FLUID.put(Fluid.getType(gasId('flowing_' + g.key)), i)
    GASES.push(g)
  }
})()

function gasIndexOf(key) {
  for (var i = 0; i < GASES.length; i++) if (GASES[i].key == key) return i
  return -1
}

// Block results (quest-gas slice 3, kind K1; the startup table's comment gives the forms), read from a rule's result.
// Returns null when the result isn't a block result, false when it is one that can't be used (warned; the rule is
// dropped), else { kind, at, id, props, n, state, cache, missing, water }: kind 'block' or 'fluid' (state: the block's
// default state or the fluid's source block, looked up once here; water: it holds water, which an ultrawarm dimension
// evaporates), 'state' (props: the properties to set; cache: per partner state, that state with them set; missing: the
// partner states whose block lacks one) or 'tick' (n random ticks).
function gasK1(id, r, res) {
  var rb = gasField(res, 'block')
  var rs = gasField(res, 'state')
  var rt = gasField(res, 'tick')
  var rf = gasField(res, 'fluid')
  var rat = gasField(res, 'at')
  var at = rat !== undefined ? String(rat) : null
  // { fluid } alone or at: 'self' is the older form (a source in the reacting cell), read by the loader itself.
  if (rb === undefined && rs === undefined && rt === undefined && !(rf !== undefined && at == 'partner')) return null
  var bad = function (why) { console.warn('faetouched gases: reaction ' + id + ' has a bad block result (' + why + '); the rule is dropped'); return false }
  var kinds = (rb !== undefined ? 1 : 0) + (rs !== undefined ? 1 : 0) + (rt !== undefined ? 1 : 0) + (rf !== undefined ? 1 : 0)
  if (kinds != 1) return bad('give exactly one of block, state, tick and fluid')
  if (gasField(res, 'gas') !== undefined) return bad('a block result makes no gas')
  if (at != 'partner' && !(at == 'self' && rb !== undefined)) return bad("at must be 'partner', or 'self' for a block")
  var k = { kind: rb !== undefined ? 'block' : (rs !== undefined ? 'state' : (rt !== undefined ? 'tick' : 'fluid')), at: at, id: null, props: {}, n: 1, state: null, cache: new GasHashMap(), missing: new GasHashSet(), water: false }
  if (at == 'partner') {
    if (r.partners.length == 0 || !r.partners.every(p => p.kind == 'block' || p.kind == 'fluid')) return bad("at: 'partner' needs block or fluid partners")
  } else if (!(r.consume == 'all' || r.consume >= 8)) return bad("at: 'self' must use up the whole cell, consume 'all' or 8")
  if (k.kind == 'block' || k.kind == 'fluid') {
    k.id = String(k.kind == 'block' ? rb : rf)
    k.state = k.kind == 'block' ? Block.getBlock(k.id).defaultBlockState() : Fluid.getType(k.id).defaultFluidState().createLegacyBlock()
    if (k.state == null || (k.state.isAir() && k.id != 'minecraft:air')) return bad('unknown ' + k.kind + ' ' + k.id)
    var kfs = k.state.getFluidState()
    k.water = !kfs.isEmpty() && kfs.getType().hasTag('minecraft:water')
  } else if (k.kind == 'state') {
    gasKeys(rs).forEach(key => { k.props[key] = String(gasField(rs, key)) })
    if (Object.keys(k.props).length == 0) return bad('state names no property')
  } else {
    k.n = Math.floor(Number(rt))
    if (!(k.n >= 1)) return bad('tick must be 1 or more')
  }
  return k
}

// The reaction table, normalised. GAS_RULES[gas index] lists { rule, asOther }: a gas-gas rule is listed under
// both gases, and asOther marks the listing under the partner (the reacting cell is then the neighbour).
// GAS_IGNITE[gas index]: the gas's first rule that explodes, used when an explosion primes a cell.
// A partner the loader doesn't know is reported in the log, never dropped silently; a rule naming an unknown
// condition is dropped with a warning.
// The condition partners (quest-gas slice 4, K6): name -> { cost, test(level, pos) }. A rule's conditions are ANDed and read
// at the reacting cell only when the rule is checked, cheapest (lowest cost) first, each at most once per cell update
// (gasConditionsMet). The test functions are declared further down, with the world calls they make (function declarations
// are hoisted, so the table can name them here); adding a condition is one entry and one function.
var GAS_CONDITION_TESTS = {
  always: { cost: 0, test: gasCondAlways },
  ultrawarm: { cost: 1, test: gasCondUltraWarm },
  day: { cost: 1, test: gasCondDay },
  storm: { cost: 2, test: gasCondStorm },
  warm: { cost: 3, test: gasCondWarm },
  snowy: { cost: 3, test: gasCondSnowy },
  sky: { cost: 4, test: gasCondSky }
}
var GAS_CONDITIONS = Object.keys(GAS_CONDITION_TESTS) // the condition names gasReact knows
var GAS_BLEACH_MAX_RADIUS = 4 // a reaction's bleach radius: 1 to this (radius 4 reads 257 blocks a firing)
var GAS_RULES = []
var GAS_IGNITE = []
;(function () {
  for (var i = 0; i < GASES.length; i++) { GAS_RULES.push([]); GAS_IGNITE.push(null) }
  var table = gasList(global.faetouchedGasReactions)
  for (var n = 0; n < table.length; n++) {
    var t = table[n]
    var id = String(gasField(t, 'id'))
    var gi = gasIndexOf(String(gasField(t, 'gas')))
    if (gi < 0) { console.warn('faetouched gases: reaction ' + id + ' names an unknown gas'); continue }
    var consume = gasField(t, 'consume')
    var r = {
      id: id, gas: gi, partners: [],
      minLayers: gasField(t, 'minLayers') !== undefined ? Number(gasField(t, 'minLayers')) : 1,
      chance: gasField(t, 'chance') !== undefined ? Number(gasField(t, 'chance')) : 1,
      // At least 1, except for a block result (k1 below), which may use no gas (R29 to R31).
      consume: String(consume) == 'all' ? 'all' : Number(consume !== undefined ? consume : 1),
      consumeOther: gasField(t, 'consumeOther') !== undefined ? Number(gasField(t, 'consumeOther')) : 0,
      resultGas: -1, resultLayers: 'same', resultRatio: null, resultFluid: null, resultFluidState: null, resultAt: null, flipWhenFull: false,
      effect: null, skipUltraWarm: gasField(t, 'skipUltraWarm') == true, condition: false, conditions: [], condOnly: false, k1: null,
      shape: 'vanish', vibration: null, bleach: null
    }
    // bleach: { radius } (R24): each firing bleaches the GAS_BLEACH blocks within the radius of the reacting cell.
    var bl = gasField(t, 'bleach')
    if (bl !== undefined) {
      var brad = Number(gasField(bl, 'radius'))
      if (brad >= 1 && brad <= GAS_BLEACH_MAX_RADIUS && Math.floor(brad) == brad) r.bleach = { radius: brad }
      else console.warn('faetouched gases: reaction ' + id + ' has bleach radius ' + gasField(bl, 'radius') + ' (a whole number, 1 to ' + GAS_BLEACH_MAX_RADIUS + '); no bleaching')
    }
    var dropped = false
    gasList(gasField(t, 'with')).forEach(w => {
      var wg = gasField(w, 'gas')
      var wb = gasField(w, 'block')
      var wf = gasField(w, 'fluid')
      var wc = gasField(w, 'condition')
      if (wc !== undefined) {
        // A condition partner holds for the reacting cell, with no neighbour (R6: an ultrawarm dimension; quest-gas slice 4:
        // sky, day, storm, warm, always). Several are ANDed, so r.conditions keeps each name once, cheapest test first.
        var cname = String(wc)
        if (GAS_CONDITIONS.indexOf(cname) < 0) { console.warn('faetouched gases: reaction ' + id + ' has an unknown condition ' + cname + '; the rule is dropped'); dropped = true; return }
        r.partners.push({ kind: 'condition', condition: cname })
        r.condition = true
        if (r.conditions.indexOf(cname) < 0) {
          var at = r.conditions.length
          while (at > 0 && GAS_CONDITION_TESTS[r.conditions[at - 1]].cost > GAS_CONDITION_TESTS[cname].cost) at--
          r.conditions.splice(at, 0, cname)
        }
      } else if (wg !== undefined) {
        var pgi = gasIndexOf(String(wg))
        if (pgi < 0 || pgi == gi) { console.warn('faetouched gases: reaction ' + id + ' has a bad partner gas ' + wg); return }
        r.partners.push({ kind: 'gas', gas: pgi })
      } else if (wb !== undefined || wf !== undefined) {
        var ref = String(wb !== undefined ? wb : wf)
        var part = {
          kind: wb !== undefined ? 'block' : 'fluid', tag: ref.charAt(0) == '#' ? ref.substring(1) : null, id: ref,
          state: {}, cache: new GasHashMap()
        }
        var ws = gasField(w, 'state')
        gasKeys(ws).forEach(k => { part.state[k] = String(gasField(ws, k)) })
        // Filters (slice 3): source (fluid partners: the fluid's own source block) and growing (block partners: the
        // block's isValidBonemealTarget, read on every check, never cached).
        part.source = gasField(w, 'source') == true
        part.growing = gasField(w, 'growing') == true
        if (part.source && part.kind != 'fluid') console.warn('faetouched gases: reaction ' + id + ' has source: true on a block partner (only fluid partners); ignored')
        if (part.growing && part.kind != 'block') console.warn('faetouched gases: reaction ' + id + ' has growing: true on a fluid partner (only block partners); ignored')
        if (part.kind != 'fluid') part.source = false
        if (part.kind != 'block') part.growing = false
        r.partners.push(part)
      } else console.warn('faetouched gases: reaction ' + id + ' has a partner with no gas, block, fluid or condition')
    })
    if (dropped) continue
    // A rule whose partners are all conditions needs no neighbour: it fires on the reacting cell itself.
    r.condOnly = r.condition && r.partners.every(pp => pp.kind == 'condition')
    var res = gasField(t, 'result')
    // Block results (slice 3, K1): gasK1 reads them; a bad one drops the rule with a warning.
    var k1 = res !== undefined ? gasK1(id, r, res) : null
    if (k1 === false) continue
    if (k1 != null) { r.k1 = k1; res = undefined }
    if (r.consume != 'all' && !(r.consume >= 1) && !(r.k1 != null && r.consume === 0)) {
      console.warn('faetouched gases: reaction ' + id + ' has consume: ' + gasField(t, 'consume') + ' (0 only with a block result); 1 is used')
      r.consume = 1
    }
    if (res !== undefined) {
      var rg = gasField(res, 'gas')
      if (rg !== undefined) {
        r.resultGas = gasIndexOf(String(rg))
        var rl = gasField(res, 'layers')
        r.resultLayers = rl === undefined || String(rl) == 'same' ? 'same' : Number(rl)
      }
      var rf = gasField(res, 'fluid')
      if (rf !== undefined) r.resultFluid = String(rf)
      var ratio = gasField(res, 'ratio')
      if (ratio !== undefined) r.resultRatio = Number(ratio)
      var rat = gasField(res, 'at')
      if (rat !== undefined) {
        if (String(rat) == 'partner' && r.partners.some(p => p.kind == 'gas')) r.resultAt = 'partner'
        else console.warn('faetouched gases: reaction ' + id + ' has result at: ' + rat + ' (only \'partner\', with a partner gas); the product goes into the reacting cell')
      }
      // whenFull: 'flip' (R5, the author's call, 2026-11-19): when the partner has no room for the product, the whole
      // reacting cell turns into the product gas, layer for layer, so the reaction keeps spreading.
      var wf = gasField(res, 'whenFull')
      if (wf !== undefined) {
        if (String(wf) == 'flip' && r.resultAt == 'partner') r.flipWhenFull = true
        else console.warn('faetouched gases: reaction ' + id + ' has result whenFull: ' + wf + ' (only \'flip\', with at: \'partner\'); ignored')
      }
    }
    var ef = gasField(t, 'effect')
    if (ef !== undefined) {
      r.effect = {
        type: String(gasField(ef, 'type')),
        powerPerLayer: Number(gasField(ef, 'powerPerLayer') || 0), maxPower: Number(gasField(ef, 'maxPower') || 0),
        fire: gasField(ef, 'fire') == true, mode: String(gasField(ef, 'mode') || 'none'),
        particle: String(gasField(ef, 'particle') || ''), count: Number(gasField(ef, 'count') || 1)
      }
      // A block result takes particles only (gasApplyBlock).
      if (r.k1 != null && r.effect.type != 'particles') {
        console.warn('faetouched gases: reaction ' + id + ' has a block result and a ' + r.effect.type + ' effect (only particles); the effect is ignored')
        r.effect = null
      }
      if (r.effect != null && r.effect.type == 'explode' && GAS_IGNITE[gi] == null) GAS_IGNITE[gi] = r
    }
    // The vibration (spec-sculk): the shape is decided once, here, after the effect is settled; `vibration` overrides.
    r.shape = gasShapeOf(r)
    r.vibration = gasVibrationOf(id, r.shape, gasField(t, 'vibration'))
    GAS_RULES[gi].push({ rule: r, asOther: false })
    r.partners.forEach(p => { if (p.kind == 'gas') GAS_RULES[p.gas].push({ rule: r, asOther: true }) })
  }
})()

// --- Intake by collector (quest-gas slice 5, K3; the startup table's comment gives the format) ---
// GAS_INTAKE_LIST: { id, gas (index), every, p (the chance a face gives a layer each collector action), conditions (names, cheapest
// first, ANDed), part (the block partner, tested by gasPartnerAt) }. A bad entry is dropped with a warning, never silently.
var GAS_COLLECTOR_ACTION_TICKS = 10 // the collector's block entity ticks every 10 ticks (startup script, tickFrequency): one action
var GAS_INTAKE_LIST = []
;(function () {
  var table = gasList(global.faetouchedGasIntakes)
  for (var n = 0; n < table.length; n++) {
    var t = table[n]
    var id = String(gasField(t, 'id'))
    var gi = gasIndexOf(String(gasField(t, 'gas')))
    var ref = gasField(t, 'block')
    var every = Number(gasField(t, 'every'))
    if (gi < 0) { console.warn('faetouched gases: intake ' + id + ' names an unknown gas; the entry is dropped'); continue }
    if (ref === undefined) { console.warn('faetouched gases: intake ' + id + ' names no block; the entry is dropped'); continue }
    if (!(every >= 1)) { console.warn('faetouched gases: intake ' + id + ' has every: ' + gasField(t, 'every') + ' (1 or more); the entry is dropped'); continue }
    var conds = []
    var bad = false
    gasList(gasField(t, 'conditions')).forEach(c => {
      var cname = String(c)
      if (GAS_CONDITION_TESTS[cname] === undefined) { console.warn('faetouched gases: intake ' + id + ' has an unknown condition ' + cname + '; the entry is dropped'); bad = true; return }
      if (conds.indexOf(cname) >= 0) return
      var at = conds.length
      while (at > 0 && GAS_CONDITION_TESTS[conds[at - 1]].cost > GAS_CONDITION_TESTS[cname].cost) at--
      conds.splice(at, 0, cname)
    })
    if (bad) continue
    var rs = String(ref)
    GAS_INTAKE_LIST.push({
      id: id, gas: gi, every: every, p: Math.min(1, GAS_COLLECTOR_ACTION_TICKS / every), conditions: conds,
      part: { kind: 'block', tag: rs.charAt(0) == '#' ? rs.substring(1) : null, id: rs, state: {}, cache: new GasHashMap(), source: false, growing: false }
    })
  }
})()

// --- Blocks that read gas (quest-gas slice 5, K2; the startup table's comment gives the format) ---
// gasSenseSpec(raw) normalises one reading's spec (an entry of the startup table, or a machine script's own object); gasSense
// reads with it. The six faces are indexes into GAS_ALL_DIRS (up, down, north, east, south, west).
var GAS_SENSE_FACES = { up: 0, down: 1, north: 2, east: 3, south: 4, west: 5 }
var GAS_SENSE_EVERY_MIN = 20 // ticks: a block is read at most this often
var GAS_SENSE_DATA = 'faetouched_gas_sense_' // block entity data keys: <this><id> (boolean) and faetouched_gas_layers_<id> (int)
function gasSenseSpec(raw) {
  var gases = []
  gasList(gasField(raw, 'gas')).forEach(g => { var gi = gasIndexOf(String(g)); if (gi >= 0 && gases.indexOf(gi) < 0) gases.push(gi) })
  var faces = []
  var unknown = []
  var fl = gasField(raw, 'faces')
  var names = fl === undefined ? Object.keys(GAS_SENSE_FACES) : gasList(fl).map(x => String(x))
  names.forEach(nm => {
    var fi = GAS_SENSE_FACES[nm]
    if (fi === undefined) unknown.push(nm)
    else if (faces.indexOf(fi) < 0) faces.push(fi)
  })
  var ml = gasField(raw, 'minLayers')
  var mf = gasField(raw, 'minFaces')
  var sp = gasField(raw, 'spend')
  var ev = gasField(raw, 'every')
  var prop = gasField(raw, 'property')
  var id = gasField(raw, 'id')
  return {
    id: id === undefined ? '' : String(id), gases: gases, faces: faces, unknown: unknown,
    minLayers: Math.max(1, Math.min(8, ml === undefined ? 1 : Math.floor(Number(ml)))),
    minFaces: Math.max(1, mf === undefined ? 1 : Math.floor(Number(mf))),
    spend: Math.max(0, sp === undefined ? 0 : Math.floor(Number(sp))),
    every: Math.max(GAS_SENSE_EVERY_MIN, ev === undefined ? GAS_SENSE_EVERY_MIN : Math.floor(Number(ev))),
    property: prop === undefined ? null : String(prop),
    stateOn: new GasHashMap(), stateOff: new GasHashMap() // the block's states with the property set, per state (gasSensorProperty)
  }
}

// One reading at pos with a spec from gasSenseSpec: the gas cell touching each listed face is read (at most six reads); a face
// counts when its cell holds one of the gases with at least minLayers. Returns { met, faces (counted), layers (in those
// cells), spent }. met needs minFaces counted faces and, when the spec spends, at least `spend` layers among them: then spend
// layers are taken out of the cells, fullest first (the cells are written and the gas around them woken, as the collector
// does); a reading short of layers takes nothing.
function gasSense(level, pos, spec) {
  var hits = []
  var layers = 0
  for (var i = 0; i < spec.faces.length; i++) {
    var n = pos.relative(GAS_ALL_DIRS[spec.faces[i]])
    var code = gasCell(level, n)
    if (code < 0 || spec.gases.indexOf(code >> 4) < 0) continue
    var L = code & 15
    if (L < spec.minLayers) continue
    hits.push({ pos: n, code: code, L: L })
    layers += L
  }
  var met = hits.length > 0 && hits.length >= spec.minFaces
  var spent = 0
  if (met && spec.spend > 0) {
    if (layers < spec.spend) met = false
    else {
      hits.sort(function (a, b) { return b.L - a.L })
      var due = gasNow(level) + 1
      for (var h = 0; h < hits.length && spent < spec.spend; h++) {
        var hit = hits[h]
        var take = Math.min(hit.L, spec.spend - spent)
        if (!gasWrite(level, hit.pos, GASES[hit.code >> 4], hit.L - take, hit.L)) continue
        spent += take
        if (hit.L - take > 0) gasEnqueue(level, hit.pos, due)
        gasWakeAround(level, hit.pos, due)
      }
      if (spent < spec.spend) met = false // a write failed: not met (what was taken is gone)
    }
  }
  return { met: met, faces: hits.length, layers: layers, spent: spent }
}

// The registered sensors (GAS_SENSORS in the startup script), by block. An entry with no usable gas or face, an unknown face
// name, a duplicate id, or a block that doesn't exist is dropped with a warning.
var GAS_SENSOR_LIST = []
var GAS_SENSORS_BY_BLOCK = {}
;(function () {
  var table = gasList(global.faetouchedGasSensors)
  var seen = {}
  for (var n = 0; n < table.length; n++) {
    var t = table[n]
    var s = gasSenseSpec(t)
    var block = gasField(t, 'block')
    var why = null
    if (s.id == '' || seen[s.id]) why = 'it needs an id nothing else uses'
    else if (block === undefined) why = 'it names no block'
    else if (s.gases.length == 0) why = 'it names no known gas'
    else if (s.faces.length == 0 || s.unknown.length > 0) why = 'faces must be from ' + Object.keys(GAS_SENSE_FACES).join(', ') + (s.unknown.length > 0 ? ' (not ' + s.unknown.join(', ') + ')' : '')
    else if (Block.getBlock(String(block)).defaultBlockState().isAir()) why = 'there is no block ' + block
    if (why != null) { console.warn('faetouched gases: sensor ' + s.id + ' is dropped: ' + why); continue }
    seen[s.id] = true
    s.block = String(block)
    GAS_SENSOR_LIST.push(s)
    if (GAS_SENSORS_BY_BLOCK[s.block] === undefined) GAS_SENSORS_BY_BLOCK[s.block] = []
    GAS_SENSORS_BY_BLOCK[s.block].push(s)
  }
})()

// --- Masks and detectors (quest-gas slice 5, K5) ---
// The mask table is read by the startup script's cloud effects (a mask there ends a cloud's effects); this script puts the
// mask items in the item tag curios:head. The detectors: GAS_DETECTORS_LIST[i] = { item, signals } with signals[gas index]
// the gas's signal name or null.
var GAS_MASK_ITEMS = gasKeys(global.faetouchedGasMasks)
var GAS_DETECTOR_LIST = []
;(function () {
  var det = global.faetouchedGasDetectors
  gasKeys(det).forEach(item => {
    var map = gasField(det, item)
    var signals = []
    for (var i = 0; i < GASES.length; i++) signals.push(null)
    var any = false
    gasKeys(map).forEach(gk => {
      var gi = gasIndexOf(gk)
      if (gi < 0) { console.warn('faetouched gases: detector ' + item + ' names an unknown gas ' + gk + '; ignored'); return }
      signals[gi] = String(gasField(map, gk))
      any = true
    })
    if (any) GAS_DETECTOR_LIST.push({ item: item, signals: signals })
  })
})()

// --- Bleaching (R24's `bleach`; the startup table GAS_BLEACH gives the format) ---
// GAS_BLEACH_LIST: { tag (or null), id, toId, state (the plain block's default state), except (IDs) }, in table order. An entry
// whose plain block doesn't exist is dropped with a warning. GAS_BLEACH_CACHE: block state -> the index of the entry it
// bleaches by, or -1 (not bleachable, already plain, excepted, or a block entity), worked out once per state.
var GAS_BLEACH_LIST = []
var GAS_BLEACH_CACHE = new GasHashMap()
;(function () {
  gasList(global.faetouchedGasBleach).forEach(t => {
    var from = String(gasField(t, 'from'))
    var to = String(gasField(t, 'to'))
    var st = Block.getBlock(to).defaultBlockState()
    if (st.isAir()) { console.warn('faetouched gases: bleach entry ' + from + ' names no block ' + to + '; the entry is dropped'); return }
    GAS_BLEACH_LIST.push({ tag: from.charAt(0) == '#' ? from.substring(1) : null, id: from, toId: to, state: st, except: gasList(gasField(t, 'except')).map(x => String(x)) })
  })
})()
function gasBleachIndex(st) {
  var hit = GAS_BLEACH_CACHE.get(st)
  if (hit != null) return Number(hit)
  var idx = -1
  var id = String(st.getId())
  for (var i = 0; i < GAS_BLEACH_LIST.length && idx < 0; i++) {
    var b = GAS_BLEACH_LIST[i]
    if (b.tag != null ? !st.hasTag(b.tag) : id != b.id) continue
    // The first matching entry decides: a block already plain, or excepted, stays.
    idx = (id == b.toId || b.except.indexOf(id) >= 0) ? -2 : i
  }
  if (idx == -2) idx = -1
  // Never a block entity (a bed, a banner), should a mod tag one: setBlock would drop what it holds.
  if (idx >= 0 && typeof st.hasBlockEntity === 'function') {
    try { if (st.hasBlockEntity() == true) idx = -1 } catch (err) { gasWarnOnce('bleach be', 'hasBlockEntity failed (' + err + '); bleaching trusts the tags') }
  }
  GAS_BLEACH_CACHE.put(st, idx)
  return idx
}
// Bleaches every bleachable block within `radius` of `center` (a sphere), one setBlock (flags 3, dropping nothing itself)
// each; returns the blocks changed. Unloaded or out-of-world cells are skipped.
function gasBleach(level, center, radius) {
  var n = 0
  var r2 = radius * radius
  for (var dx = -radius; dx <= radius; dx++) {
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dy * dy + dz * dz > r2) continue
        var q = center.offset(dx, dy, dz)
        if (level.isOutsideBuildHeight(q) || !level.shouldTickBlocksAt(q)) continue
        var idx = gasBleachIndex(level.getBlockState(q))
        if (idx >= 0 && level.setBlock(q, GAS_BLEACH_LIST[idx].state, 3)) n++
      }
    }
  }
  return n
}

// The Y at and above which a rising gas loses a layer in this level, cached per gas and dimension: the dimension's
// override if the table gives one (the Nether's Y 120, below its bedrock roof at 128: its top, 255, is above the roof
// and out of reach), else the gas's ceiling, with 'top' read from the level once.
function gasCeiling(g, level) {
  var dim = String(level.getDimension())
  var c = g.ceilingCache[dim]
  if (c === undefined) {
    c = g.ceilings[dim] !== undefined ? g.ceilings[dim] : g.ceiling
    if (c === GAS_CEILING_TOP) c = gasWorldTop(level, dim)
    g.ceilingCache[dim] = c
  }
  return c
}

// The top cell of the level's world. If the call fails or gives no number (it shouldn't: one signature, nothing in
// KubeJS touches it), the old ceiling is used there, warned once per dimension, so the gas tick never breaks on it.
function gasWorldTop(level, dim) {
  var top = NaN
  var why = 'not a number'
  try { top = Number(level.getMaxBuildHeight()) - 1 } catch (err) { why = String(err) }
  if (isFinite(top)) return top
  gasWarnOnce('top ' + dim, 'level.getMaxBuildHeight() failed in ' + dim + ' (' + why + "); 'top' ceilings there use Y " + GAS_CEILING_FALLBACK)
  return GAS_CEILING_FALLBACK
}

// The cell the gas moves to (above for a rising gas, below for a sinking one).
function gasAhead(g, pos) { return g.dir > 0 ? pos.above() : pos.below() }

// Is the level's dimension ultrawarm (the Nether)? R1 skips it, R6 needs it, and nothing settles there.
function gasUltraWarm(level) { return level.dimensionType().ultraWarm() == true }

// --- Conditions (quest-gas slice 4, K6) ---
// Every world call a condition makes, with its one signature (read in the installed jars; KubeJS 2101.7's LevelMixin and
// LevelKJS rename or hide only getGameTime, dimension, getEntities and their own kjs$ methods, none of these):
//   Level.isDay()                      boolean: not a fixed-time dimension and skyDarken < 4 (ServerLevel.tick updates it)
//   Level.isThundering()               boolean: sky light and no ceiling in the dimension type, thunder level over 0.9
//   Level.isRainingAt(BlockPos)        boolean: raining, canSeeSky, no motion-blocking block above, biome precipitation RAIN
//   LevelReader.canSeeSky(BlockPos)    boolean: sky light at the cell is 15 (the light engine's value; a cloud block dims none)
//   Level.getHeight(Heightmap$Types, int, int)  int: the first Y above the highest block of that heightmap (3 arguments: the
//                                      only 3-argument overload, and the no-argument LevelHeightAccessor.getHeight differs by arity)
//   LevelReader.getBiome(BlockPos)     Holder<Biome>; .value() is the Biome, getBaseTemperature() its float base temperature
//   Biome.coldEnoughToSnow(BlockPos)   boolean (slice 5, 'snowy'): the temperature adjusted for height at that position is under 0.15
// None takes a number that Rhino could read as two overloads. A cell is gas, so the world is only read, never written.
var GasHeightmapTypes = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types')
var GAS_SKY_SHADE_TAG = 'faetouched:sky_shade' // stained glass, built in the block tag event below
var GAS_SKY_SCAN_MAX = 64 // blocks of a sky column read for shade, from the highest motion-blocking block down (a longer open shaft's lower part isn't read)
var GAS_WARM_TEMPERATURE = 1.0 // 'warm': a biome's base temperature at or above this (desert, savanna and badlands are 2.0)
var GAS_SHADE_CACHE = new GasHashMap() // block state -> 1 or 0: is it in faetouched:sky_shade (tested once per state)

function gasCondAlways(level, pos) { return true }
function gasCondUltraWarm(level, pos) { return gasUltraWarm(level) }
function gasCondDay(level, pos) { return level.isDay() == true }
// Thundering, and rain falls on this cell (isRainingAt needs sky light 15 at the cell, no motion-blocking block above it,
// and a biome that rains: glass, panes, iron bars and leaves shelter it, snow biomes and deserts never storm here).
function gasCondStorm(level, pos) { return level.isThundering() == true && level.isRainingAt(pos) == true }
function gasCondWarm(level, pos) { return Number(level.getBiome(pos).value().getBaseTemperature()) >= GAS_WARM_TEMPERATURE }
// 'snowy' (slice 5, K3): vanilla's Biome.coldEnoughToSnow(BlockPos), public with that one signature (neoforge-client jar: it is
// !warmEnoughToRain, whose test is the height-adjusted temperature under 0.15). Read at the position given, which for an
// intake is the ice, not the collector.
function gasCondSnowy(level, pos) { return level.getBiome(pos).value().coldEnoughToSnow(pos) == true }
function gasShadeBlock(st) {
  var hit = GAS_SHADE_CACHE.get(st)
  if (hit == null) {
    // The tag, or an ID that says stained glass: the fallback keeps stained glass shading if the tag event never built the tag.
    hit = (st.hasTag(GAS_SKY_SHADE_TAG) || String(st.getId()).indexOf('stained_glass') >= 0) ? 1 : 0
    GAS_SHADE_CACHE.put(st, hit)
  }
  return Number(hit) == 1
}
// Open sky (the author's call, 2026-11-19): sky light 15 at the cell, so nothing above it dims light (leaves, water, solid
// blocks and tinted glass all do), and no stained glass (the tag faetouched:sky_shade) anywhere in the column up to the
// highest motion-blocking block. Plain glass, glass panes and iron bars dim nothing and shade nothing: open. The
// column is read from the top down, where a roof is, and at most GAS_SKY_SCAN_MAX blocks.
function gasCondSky(level, pos) {
  if (level.canSeeSky(pos) != true) return false
  var top = Number(level.getHeight(GasHeightmapTypes.MOTION_BLOCKING, pos.getX(), pos.getZ()))
  var lowest = Math.max(pos.getY() + 1, top - GAS_SKY_SCAN_MAX)
  for (var y = top - 1; y >= lowest; y--) {
    if (gasShadeBlock(level.getBlockState(pos.offset(0, y - pos.getY(), 0)))) return false
  }
  return true
}

// Are all of rule r's conditions true at pos? memo (or null) holds the answers already read for this cell this update.
function gasConditionsMet(level, r, pos, memo) {
  for (var i = 0; i < r.conditions.length; i++) {
    var name = r.conditions[i]
    var v = memo != null ? memo[name] : undefined
    if (v === undefined) {
      v = GAS_CONDITION_TESTS[name].test(level, pos) == true
      if (memo != null) memo[name] = v
    }
    if (!v) return false
  }
  return true
}

// Does gas g pass gas h when h is in g's way? Lighter rising gas passes up, heavier sinking gas passes down.
function gasPasses(g, h) { return g.dir > 0 ? g.density < h.density : g.density > h.density }

// Permeable blocks, tested once per block state (the cache lives as long as this script; /reload rebuilds it).
var GAS_PERM_CACHE = new GasHashMap()

// GAS_AIR, GAS_BLOCKED, GAS_PERMEABLE or gas index * 16 + layers.
function gasCell(level, pos) {
  if (level.isOutsideBuildHeight(pos) || !level.shouldTickBlocksAt(pos)) return GAS_BLOCKED
  var st = level.getBlockState(pos)
  if (st.isAir()) return GAS_AIR
  var code = GAS_STATE_CODE.get(st)
  if (code != null) return Number(code)
  var perm = GAS_PERM_CACHE.get(st)
  if (perm == null) {
    perm = st.hasTag(GAS_PERMEABLE_TAG) ? 1 : 0
    GAS_PERM_CACHE.put(st, perm)
  }
  return Number(perm) == 1 ? GAS_PERMEABLE : GAS_BLOCKED
}

// Layers a cell of gas g can hold now, or -1 if it can't take g at all.
function gasRoom(code, gi) {
  if (code == GAS_AIR) return 8
  if (code >= 0 && (code >> 4) == gi) return 8 - (code & 15)
  return -1
}

// The first cell past a run of permeable blocks (any length up to GAS_PERMEABLE_MAX; none at all gives the
// neighbour itself), stepping (dx, dy, dz) from p, as { pos, code }; null if the run goes on further than that.
// gasCell counts cells outside the build height as blocked, so a run ends there too.
function gasBeyond(level, p, dx, dy, dz) {
  var t = p.offset(dx, dy, dz)
  var c = gasCell(level, t)
  var n = 0
  while (c == GAS_PERMEABLE && n < GAS_PERMEABLE_MAX) {
    t = t.offset(dx, dy, dz)
    c = gasCell(level, t)
    n++
  }
  if (c == GAS_PERMEABLE) return null
  return { pos: t, code: c }
}

// Can gas gi move on ahead from pos: does the cell ahead, looking through a permeable run as the straight move does,
// have room? The spread's and the flow search's "way ahead" test (spec 5: with only the cell ahead, a lone layer
// beside a column whose far side was full stayed above a 30-leaf run in the stub test).
function gasRoomAhead(level, g, gi, pos) {
  var b = gasBeyond(level, pos, 0, g.dir, 0)
  return b != null && gasRoom(b.code, gi) > 0
}

// Writes `layers` (0 = air) of gas g into a cell that held `had` layers. Flags 3 when the cell turns between air
// and gas, 18 (send to clients, skip shape updates) when only the layer count changes.
function gasWrite(level, pos, g, layers, had) {
  var st = layers <= 0 ? GAS_AIR_STATE : g.states[layers]
  var flags = (layers <= 0 || had <= 0) ? 3 : 18
  // A settling gas's cell that changes starts its still time again.
  if (g.settle != null) gasSettleForget(level, pos)
  // Gas written into an idle fan's straight current wakes that fan for the next tick (one map lookup; spec-fans-pumps).
  if (GAS_CURRENT_CELLS != null) gasFanWakeAt(level, pos)
  return level.setBlock(pos, st, flags)
}

// Trades the contents of two cells holding different gases (codes cp at p, cq at q): q is written first, then p;
// if p's write fails, q is put back. Returns whether both were written.
function gasSwapCells(level, p, cp, q, cq) {
  var gp = GASES[cp >> 4]
  var gq = GASES[cq >> 4]
  if (gp.settle != null || gq.settle != null) { gasSettleForget(level, p); gasSettleForget(level, q) }
  if (!level.setBlock(q, gp.states[cp & 15], 3)) return false
  if (!level.setBlock(p, gq.states[cq & 15], 3)) {
    level.setBlock(q, gq.states[cq & 15], 3)
    console.warn('faetouched gases: swap failed at ' + p + ', put ' + q + ' back')
    return false
  }
  return true
}

// Game time. KubeJS 2101.7 hides Level.getGameTime() from scripts (LevelMixin shadows it: "Cannot find
// function getGameTime"), so read it from the level data, which isn't hidden.
function gasNow(level) { return level.getLevelData().getGameTime() }

// --- Settling (a gas with `settles`, such as condensate) ---
// A full cell that hasn't moved for g.settle.after ticks becomes a source of the settle fluid. The startup-made map
// keeps, per dimension, each full still cell's position and the game time it was first seen so.

function gasSettleMap(level) {
  var dim = level.getDimension()
  var map = GAS_SETTLE.get(dim)
  if (map == null) { map = new GasHashMap(); GAS_SETTLE.put(dim, map) }
  return map
}
function gasSettleForget(level, pos) {
  if (GAS_SETTLE == null) return // a /reload before the restart that makes the map: no gas settles yet
  var map = GAS_SETTLE.get(level.getDimension())
  if (map != null) map.remove(pos)
}
// A full cell of a settling gas didn't move: remember since when, and update it again when its time is up.
function gasSettleStill(level, p, g, now) {
  var map = gasSettleMap(level)
  var since = map.get(p)
  if (since == null) { since = now; map.put(p.immutable(), GasLong.valueOf(Math.floor(now))) }
  gasEnqueue(level, p, Number(since) + g.settle.after)
}
// The fluid source a settling gas becomes, looked up once.
function gasSettleState(g) {
  if (g.settle.state == null) g.settle.state = Fluid.getType(g.settle.fluid).defaultFluidState().createLegacyBlock()
  return g.settle.state
}

// --- The queue ---

function gasQueue(level) {
  var dim = level.getDimension()
  var tree = GAS_QUEUES.get(dim)
  if (tree == null) {
    tree = new GasTreeMap()
    GAS_QUEUES.put(dim, tree)
    GAS_MEMBERS.put(dim, new GasHashSet())
  }
  return tree
}

// Queues pos for an update at game time `due`. A position already queued keeps its place (never pushed later).
function gasEnqueue(level, pos, due) {
  var tree = gasQueue(level)
  var members = GAS_MEMBERS.get(level.getDimension())
  if (members.contains(pos)) return
  var p = pos.immutable()
  members.add(p)
  // Every key is made the same way, so the TreeMap never mixes Long and Double keys.
  var key = GasLong.valueOf(Math.floor(due))
  var dq = tree.get(key)
  if (dq == null) { dq = new GasArrayDeque(); tree.put(key, dq) }
  dq.add(p)
}

// Queues pos if it holds gas.
function gasWakeCell(level, pos, due) {
  if (gasCell(level, pos) >= 0) gasEnqueue(level, pos, due)
}

// Queues the gas cell next to pos in each of the six directions, looking through a permeable run (spec 5): gas past
// a run reaches pos with its straight move, spread or density swap, so it must wake when pos changes. With no run
// in between, that is the neighbour itself.
function gasWakeThrough(level, pos, due) {
  for (var a = 0; a < 6; a++) {
    var st = GAS_ALL_STEPS[a]
    var b = gasBeyond(level, pos, st[0], st[1], st[2])
    if (b != null && b.code >= 0) gasEnqueue(level, b.pos, due)
  }
}

// Queues pos's six gas neighbours, and the gas past a permeable run in each direction.
function gasWakeNeighbours(level, pos, due) { gasWakeThrough(level, pos, due) }

// Queues every gas cell in the 3x3x3 cube around pos (it covers the cell below's side neighbours too).
function gasWakeAround(level, pos, due) {
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dz = -1; dz <= 1; dz++) gasWakeCell(level, pos.offset(dx, dy, dz), due)
    }
  }
}

// Wake rule E, for the cell a move leaves, both cells of a swap, and a broken or placed block: the 3x3x3 cube around
// pos, the four side lines out to GAS_SLOPE_REACH cells on its own level and the levels above and below (the cells
// whose flow search can see pos), the cells 2 and 3 above and below, and the gas past a permeable run in each of the
// six directions (gasWakeThrough). Filled cells wake only their six neighbours (and past runs).
function gasWakeWide(level, pos, due) {
  gasWakeAround(level, pos, due)
  gasWakeThrough(level, pos, due)
  for (var dy = -1; dy <= 1; dy++) {
    for (var s = 0; s < 4; s++) {
      for (var k = 2; k <= GAS_SLOPE_REACH; k++) gasWakeCell(level, pos.offset(GAS_H_STEPS[s][0] * k, dy, GAS_H_STEPS[s][1] * k), due)
    }
  }
  for (var v = 2; v <= 3; v++) {
    gasWakeCell(level, pos.offset(0, v, 0), due)
    gasWakeCell(level, pos.offset(0, -v, 0), due)
  }
}

// The set of primed cells of a level.
function gasPrimedSet(level) {
  var dim = level.getDimension()
  var set = GAS_PRIMED.get(dim)
  if (set == null) { set = new GasHashSet(); GAS_PRIMED.put(dim, set) }
  return set
}

// Takes one of this tick's ignitions; false when the cap is reached. Game time is shared by all dimensions.
function gasIgniteTake(now) {
  var t = GAS_STATE.get('igniteTick')
  if (t == null || Number(t) != Number(now)) {
    GAS_STATE.put('igniteTick', Number(now))
    GAS_STATE.put('igniteCount', 0)
  }
  var c = Number(GAS_STATE.get('igniteCount'))
  if (c >= GAS_IGNITIONS_PER_TICK) return false
  GAS_STATE.put('igniteCount', c + 1)
  return true
}

// --- Placing gas from any source ---

// Puts up to `layers` layers of gas g at pos, spilling what doesn't fit into the cell ahead and then the side
// neighbours. Returns the layers it could not place.
function gasAddCells(g, pos) {
  var cells = [pos, gasAhead(g, pos)]
  for (var d = 0; d < 4; d++) cells.push(pos.relative(GAS_H_DIRS[d]))
  return cells
}
// The layers gasAdd could place at pos now (what a mass-conserving reaction checks before it fires).
function gasAddRoom(level, pos, gi) {
  var cells = gasAddCells(GASES[gi], pos)
  var room = 0
  for (var i = 0; i < cells.length; i++) room += Math.max(0, gasRoom(gasCell(level, cells[i]), gi))
  return room
}
function gasAdd(level, pos, gi, layers) {
  var g = GASES[gi]
  var due = gasNow(level) + 1
  var cells = gasAddCells(g, pos)
  var left = layers
  for (var i = 0; i < cells.length && left > 0; i++) {
    var code = gasCell(level, cells[i])
    var room = gasRoom(code, gi)
    if (room <= 0) continue
    var had = code == GAS_AIR ? 0 : (code & 15)
    var put = Math.min(left, room)
    if (gasWrite(level, cells[i], g, had + put, had)) {
      left -= put
      gasEnqueue(level, cells[i], due)
    }
  }
  return left
}

// --- Reactions ---

// Does the block at n match a block or fluid partner? Cached per block state; the growing filter (slice 3) is read on
// every check, after the cached match, since AgriCraft keeps a crop's growth in its block entity.
function gasPartnerAt(level, n, part) {
  if (level.isOutsideBuildHeight(n) || !level.shouldTickBlocksAt(n)) return false
  var st = level.getBlockState(n)
  var hit = part.cache.get(st)
  if (hit == null) {
    hit = gasStateMatches(st, part) ? 1 : 0
    part.cache.put(st, hit)
  }
  if (Number(hit) != 1) return false
  return !part.growing || gasGrowing(level, n, st)
}

// Warnings that could repeat every tick are logged once per key.
var GAS_WARNED = {}
function gasWarnOnce(key, text) {
  if (GAS_WARNED[key]) return
  GAS_WARNED[key] = true
  console.warn('faetouched gases: ' + text)
}

// Is the block at pos still growing? Its own BonemealableBlock.isValidBonemealTarget(LevelReader, BlockPos,
// BlockState) (vanilla crops: not at their last age; AgriCraft's crop: a fertile plant not fully grown). A block that
// isn't bonemealable never is.
// A crop counts as growing only with light to grow by (the author's call, 2026-11-19): vanilla crops grow only at raw
// light 9 or more, so carbon dioxide beside an unlit crop would tick it for nothing and never settle.
var GAS_GROW_LIGHT = 9
// Two block states are the same state. KubeJS 2101.7 doesn't let scripts call BlockState.equals ("Cannot find
// function equals", in game 2026-11-20), so compare their text: Block{id}[every property=value].
function gasSameState(a, b) { return String(a) == String(b) }

function gasGrowing(level, pos, st) {
  var b = st.getBlock()
  if (typeof b.isValidBonemealTarget !== 'function') return false
  if (level.getRawBrightness(pos, 0) < GAS_GROW_LIGHT) return false
  try {
    return b.isValidBonemealTarget(level, pos, st) == true
  } catch (err) {
    gasWarnOnce('growing ' + st.getId(), 'isValidBonemealTarget failed on ' + st.getId() + ' (' + err + '); it counts as not growing')
    return false
  }
}

function gasStateMatches(st, part) {
  if (part.kind == 'block') {
    if (part.tag != null ? !st.hasTag(part.tag) : String(st.getId()) != part.id) return false
    var keys = Object.keys(part.state)
    for (var i = 0; i < keys.length; i++) {
      var prop = st.getBlock().getStateDefinition().getProperty(keys[i])
      if (prop == null || String(st.getValue(prop)) != part.state[keys[i]]) return false
    }
    return true
  }
  var fs = st.getFluidState()
  if (fs.isEmpty()) return false
  var fluid = fs.getType()
  if (!(part.tag != null ? fluid.hasTag(part.tag) : String(fluid.getId()) == part.id)) return false
  // source: true (slice 3): the fluid's own source block, so a block result never replaces a waterlogged block or a
  // water plant (their fluid state is a source too, but their block isn't the fluid's).
  return !part.source || (fs.isSource() && gasSameState(st, fs.createLegacyBlock()))
}

// The block state a fluid result places (a source block), looked up once.
function gasFluidBlock(r) {
  if (r.resultFluidState == null) r.resultFluidState = Fluid.getType(r.resultFluid).defaultFluidState().createLegacyBlock()
  return r.resultFluidState
}

// The state of st's block with the properties in props (name -> value text) set and every other property kept, found
// among the block's possible states (never setValue from a script); null when the block lacks one of them. Values are
// compared as text, as gasStateMatches does.
function gasStateWith(st, props) {
  var def = st.getBlock().getStateDefinition()
  var keys = Object.keys(props)
  for (var i = 0; i < keys.length; i++) if (def.getProperty(keys[i]) == null) return null
  var plist = gasList(def.getProperties())
  var all = def.getPossibleStates()
  for (var s = 0; s < all.size(); s++) {
    var cand = all.get(s)
    var ok = true
    for (var j = 0; j < plist.length && ok; j++) {
      var name = String(plist[j].getName())
      var want = props[name] !== undefined ? props[name] : String(st.getValue(plist[j]))
      if (String(cand.getValue(plist[j])) != want) ok = false
    }
    if (ok) return cand
  }
  return null
}

// Applies a block result (slice 3, K1; r.k1) to the reacting cell `react` (gas index rgi, rL layers). bpos is the
// block or fluid partner that matched (at: 'partner'); partner and pcode a partner gas cell, as in gasApply. One
// setBlock or random tick per firing, which drops nothing itself (the author's call, 2026-11-19); the setBlock runs
// vanilla's neighbour shape updates, so what a changed block held (a torch on melted ice) can still pop off as an item.
// The gas is written first and put back if the block change fails, so nothing changes unless both happen. Returns 1 if
// applied, 0 if not.
function gasApplyBlock(level, r, react, rgi, rL, partner, pcode, now, bpos) {
  var k = r.k1
  var g = GASES[rgi]
  var take = gasTake(r, rL)
  var left = rL - take
  var changed = [react]
  if (k.at == 'self') {
    // The reacting cell becomes the block (R33); the loader made sure the rule uses up the whole cell.
    if (left != 0) return 0
    if (g.settle != null) gasSettleForget(level, react)
    if (!level.setBlock(react, k.state, 3)) return 0
  } else {
    if (bpos == null) return 0
    var st = level.getBlockState(bpos)
    var next = null
    if (k.kind == 'block') next = k.state
    else if (k.kind == 'fluid') next = k.water && gasUltraWarm(level) ? GAS_AIR_STATE : k.state
    else if (k.kind == 'state') {
      var hit = k.cache.get(st)
      if (hit == null) {
        if (k.missing.contains(st)) return 0
        hit = gasStateWith(st, k.props)
        if (hit == null) { k.missing.add(st); return 0 }
        k.cache.put(st, hit)
      }
      next = hit
    } else {
      // A random tick never runs on a block holding lava: AgriCraft's crop sticks burn there and drop items
      // (CropBlock.randomTick destroys them with drops).
      var tfs = st.getFluidState()
      if (!tfs.isEmpty() && tfs.getType().hasTag('minecraft:lava')) return 0
    }
    if (take > 0 && !gasWrite(level, react, g, left, rL)) return 0
    if (next != null) {
      if (!level.setBlock(bpos, next, 3)) {
        if (take > 0) gasWrite(level, react, g, rL, left)
        return 0
      }
    } else {
      // tick: n random ticks through BlockState.randomTick(ServerLevel, BlockPos, RandomSource), the one signature,
      // which KubeJS's BlockStateBaseMixin only injects into (its random-tick callback); the state is read again
      // before each tick, since a tick can change it.
      try {
        for (var t = 0; t < k.n; t++) level.getBlockState(bpos).randomTick(level, bpos, level.getRandom())
      } catch (err) {
        gasWarnOnce('tick ' + st.getId(), 'a random tick failed on ' + st.getId() + ' (' + err + ')')
        if (take > 0) gasWrite(level, react, g, rL, left)
        return 0
      }
    }
    changed.push(bpos)
  }
  if (partner != null && pcode >= 0 && r.consumeOther > 0) {
    var pL = pcode & 15
    if (gasWrite(level, partner, GASES[pcode >> 4], pL - Math.min(r.consumeOther, pL), pL)) changed.push(partner)
  }
  if (r.effect != null && r.effect.type == 'particles') {
    level.spawnParticles(r.effect.particle, true, react.getX() + 0.5, react.getY() + 0.5, react.getZ() + 0.5, 0.3, 0.3, 0.3, r.effect.count, 0.02)
  }
  // Wake the gas around every changed cell by rule E, the changed block too: the gas beside fire that went out can
  // move into its cell.
  var due = now + g.interval
  for (var wi = 0; wi < changed.length; wi++) gasWakeWide(level, changed[wi], due)
  gasVibrate(level, r.vibration, react, r.id)
  return 1
}

// The layers rule r consumes from a reacting cell of rL layers.
function gasTake(r, rL) { return r.consume == 'all' ? rL : Math.min(r.consume, rL) }
// The product's layers: the layers consumed ('same'), at most n, or floor(consumed x ratio) (R1: 2 steam to 1
// condensate, an odd layer lost; R6: 1 condensate to 2 steam).
function gasResultLayers(r, rL) {
  if (r.resultGas < 0) return 0
  var take = gasTake(r, rL)
  return r.resultRatio != null ? Math.floor(take * r.resultRatio) : (r.resultLayers == 'same' ? take : Math.min(r.resultLayers, take))
}
// For a rule whose product goes to the partner (at: 'partner', R5): does gasAdd from the partner cell have room for
// all of it? The reacting cell counts as room when the rule empties it and gasAdd reaches it (beside the partner, or
// ahead of it). A partner without room doesn't count as in place, so the cell neither fires nor retries for it,
// unless the rule flips the whole cell when the partner is full (whenFull: 'flip').
function gasPartnerRoomOK(level, r, partnerPos, reactPos, rL) {
  if (r.resultAt != 'partner' || r.flipWhenFull) return true
  return gasPartnerHasRoom(level, r, partnerPos, reactPos, rL)
}
function gasPartnerHasRoom(level, r, partnerPos, reactPos, rL) {
  var need = gasResultLayers(r, rL)
  var room = gasAddRoom(level, partnerPos, r.resultGas)
  if (room < need && gasTake(r, rL) == rL) {
    var cells = gasAddCells(GASES[r.resultGas], partnerPos)
    for (var i = 1; i < cells.length; i++) {
      if (cells[i].getX() == reactPos.getX() && cells[i].getY() == reactPos.getY() && cells[i].getZ() == reactPos.getZ()) room += 8
    }
  }
  return room >= need
}

// Applies rule r to the reacting cell `react` (gas index rgi, rL layers); `partner` is a partner gas cell with
// code pcode, or null; bpos (slice 3) the block or fluid partner that matched, or null. Returns 1 if applied, 0 if a
// write failed (nothing changed), -1 if it is an ignition over this tick's cap (nothing changed; try again next tick).
function gasApply(level, r, react, rgi, rL, partner, pcode, now, bpos) {
  var eff = r.effect
  if (eff != null && eff.type == 'explode' && !gasIgniteTake(now)) return -1
  if (r.k1 != null) return gasApplyBlock(level, r, react, rgi, rL, partner, pcode, now, bpos || null)
  var g = GASES[rgi]
  var take = gasTake(r, rL)
  var left = rL - take
  var resultL = gasResultLayers(r, rL)
  var changed = [react]
  // at: 'partner' (R5): the product is placed by gasAdd from the partner gas cell, and only if all of it has room
  // there, so mass is conserved; otherwise nothing changes.
  var atPartner = r.resultAt == 'partner' && resultL > 0
  if (atPartner && (partner == null || pcode < 0)) return 0
  if (atPartner && !gasPartnerHasRoom(level, r, partner, react, rL)) {
    if (!r.flipWhenFull) return 0
    // whenFull: 'flip': the whole reacting cell turns into the product gas, layer for layer (mass conserved).
    var pg = GASES[r.resultGas]
    if (g.settle != null || pg.settle != null) gasSettleForget(level, react)
    if (!level.setBlock(react, pg.states[rL], 3)) return 0
    gasWakeWide(level, react, now + g.interval)
    gasVibrate(level, r.vibration, react, r.id)
    return 1
  }
  if (atPartner) {
    if (!gasWrite(level, react, g, left, rL)) return 0
  } else if (r.resultFluid != null && left == 0) {
    if (!level.setBlock(react, gasFluidBlock(r), 3)) return 0
  } else if (left == 0 && resultL > 0) {
    // The cell turns into the product gas in one write, at most 8 layers (R6 makes up to 16); the rest goes to gasAdd at the end.
    var inCell = Math.min(8, resultL)
    if (g.settle != null || GASES[r.resultGas].settle != null) gasSettleForget(level, react)
    if (!level.setBlock(react, GASES[r.resultGas].states[inCell], 3)) return 0
    resultL -= inCell
  } else if (!gasWrite(level, react, g, left, rL)) return 0
  if (partner != null && pcode >= 0 && r.consumeOther > 0) {
    var pL = pcode & 15
    if (gasWrite(level, partner, GASES[pcode >> 4], pL - Math.min(r.consumeOther, pL), pL)) changed.push(partner)
  }
  if (atPartner) {
    // gasAdd queues the cells it writes; the room was checked above (the reacting cell, if it emptied, only adds room).
    gasAdd(level, partner, r.resultGas, resultL)
    changed.push(partner)
    resultL = 0
  }
  // A product that couldn't go into the reacting cell spills like placed gas; what has no room is lost.
  if (resultL > 0) gasAdd(level, react, r.resultGas, resultL)
  var cx = react.getX() + 0.5
  var cy = react.getY() + 0.5
  var cz = react.getZ() + 0.5
  if (eff != null && eff.type == 'explode') {
    // The vanilla 9-argument explode (entity, damage source, calculator, x, y, z, strength, fire, interaction), the
    // only overload of that arity: it reaches ServerLevel's override, which sends the explosion packet. KubeJS's
    // explode(x, y, z, {...}) takes a 13-argument path that ServerLevel doesn't override, so players would see and
    // hear nothing (a reviewer's bytecode read, 2026-11-18).
    level.explode(null, null, null, cx, cy, cz, Math.min(eff.maxPower, eff.powerPerLayer * take), eff.fire, eff.mode)
  } else if (eff != null && eff.type == 'particles') {
    level.spawnParticles(eff.particle, true, cx, cy, cz, 0.3, 0.3, 0.3, eff.count, 0.02)
  }
  // Wake the gas around the changed cells by rule E (spec 5; the 3x3x3 cube alone missed a flow search that could
  // see a cell a reaction emptied 4 cells along its line, in the stub test's random boxes).
  var due = now + g.interval
  for (var c = 0; c < changed.length; c++) gasWakeWide(level, changed[c], due)
  gasVibrate(level, r.vibration, react, r.id)
  return 1
}

// Checks the rules of the gas at p (gas index gi, L layers). Returns 0 if no partner is in place, 1 if a rule
// fired, 2 if a partner is in place but its chance roll failed (check again later), 3 if an ignition waits for
// next tick's cap.
function gasReact(level, p, gi, L, now) {
  var list = GAS_RULES[gi]
  if (list.length == 0) return 0
  var retry = false
  var ultraWarm = null
  var memo = null // the conditions already read for the cell at p this update (slice 4)
  for (var e = 0; e < list.length; e++) {
    var r = list[e].rule
    var asOther = list[e].asOther
    if (r.skipUltraWarm) {
      if (ultraWarm == null) ultraWarm = gasUltraWarm(level)
      if (ultraWarm) continue
    }
    if (!asOther && L < r.minLayers) continue
    var react = null
    var rL = 0
    var partner = null
    var pcode = -1
    var bpos = null // the block or fluid partner that matched (slice 3: block results change it)
    // Conditions (R6; slice 4, K6) are read at the reacting cell, ANDed, and only when the rule is being checked. A rule
    // with nothing but conditions needs no neighbour: a false one skips it here, before any block is read. A rule that
    // also has a partner reads them once its partner is found (neighbour reads are cheaper than a light or biome read),
    // below; one listed under its partner gas (asOther) reads them at the neighbour it reacts in.
    if (r.condOnly) {
      if (memo == null) memo = {}
      if (!gasConditionsMet(level, r, p, memo)) continue
      react = p; rL = L
    }
    for (var a = 0; a < 6 && react == null; a++) {
      var n = p.relative(GAS_ALL_DIRS[a])
      if (asOther) {
        // p is the partner gas; the reacting gas is the neighbour.
        var cn = gasCell(level, n)
        if (cn >= 0 && (cn >> 4) == r.gas && (cn & 15) >= r.minLayers && gasPartnerRoomOK(level, r, p, n, cn & 15) && (!r.condition || gasConditionsMet(level, r, n, null))) {
          react = n; rL = cn & 15; partner = p; pcode = gi * 16 + L
        }
      } else {
        for (var k = 0; k < r.partners.length && react == null; k++) {
          var part = r.partners[k]
          if (part.kind == 'condition') continue // checked above
          if (part.kind == 'gas') {
            var cg = gasCell(level, n)
            if (cg >= 0 && (cg >> 4) == part.gas && gasPartnerRoomOK(level, r, n, p, L)) { react = p; rL = L; partner = n; pcode = cg }
          } else if (gasPartnerAt(level, n, part)) { react = p; rL = L; bpos = n }
        }
      }
    }
    if (react == null) continue
    if (r.condition && !r.condOnly && !asOther) {
      if (memo == null) memo = {}
      if (!gasConditionsMet(level, r, p, memo)) continue
    }
    if (r.chance < 1 && Math.random() >= r.chance) { retry = true; continue }
    var res = gasApply(level, r, react, r.gas, rL, partner, pcode, now, bpos)
    if (res == -1) return 3
    if (res == 1) {
      // Only a firing that happened bleaches (R24), around the reacting cell.
      if (r.bleach != null) gasBleach(level, react, r.bleach.radius)
      return 1
    }
  }
  return retry ? 2 : 0
}

// --- One update ---

// Cells a gas at p may enter diagonally, edges first then corners, each group in random order.
// A passable cell holds air or the same gas (full or not); permeable blocks count as blocked here.
function gasDiagonalTargets(level, p, g, gi) {
  var pass = {}
  for (var s = 0; s < 4; s++) pass[s] = gasRoom(gasCell(level, p.relative(GAS_H_DIRS[s])), gi) >= 0
  var edges = []
  var corners = []
  for (var s = 0; s < 4; s++) {
    if (pass[s]) edges.push(gasAhead(g, p.relative(GAS_H_DIRS[s])))
    var s2 = (s + 1) % 4 // N+E, E+S, S+W, W+N
    if (!pass[s] && !pass[s2]) continue
    var diag = p.offset(GAS_H_STEPS[s][0] + GAS_H_STEPS[s2][0], 0, GAS_H_STEPS[s][1] + GAS_H_STEPS[s2][1])
    if (gasRoom(gasCell(level, diag), gi) >= 0) corners.push(gasAhead(g, diag))
  }
  return gasShuffle(edges).concat(gasShuffle(corners))
}

// Step 4b's move, also drift's (step 4a): as many of L layers at p as fit into the first diagonal target
// (gasDiagonalTargets' order) with room, the target written first. 4b passes the whole cell; drift passes its share
// (gasDriftShare). Pushes the target onto `filled` and returns the layers moved, 0 if no target took gas.
function gasMoveDiagonal(level, p, g, gi, L, filled) {
  var targets = gasDiagonalTargets(level, p, g, gi)
  for (var t = 0; t < targets.length; t++) {
    var dq = targets[t]
    var cd = gasCell(level, dq)
    var roomD = gasRoom(cd, gi)
    if (roomD <= 0) continue
    var hadD = cd == GAS_AIR ? 0 : (cd & 15)
    var upD = Math.min(L, roomD)
    if (gasWrite(level, dq, g, hadD + upD, hadD)) { filled.push(dq); return upD }
  }
  return 0
}

// A drift hit's diagonal share of a cell of L layers (spec-top-split): half, rounded down, and at least 1, so 8 splits
// 4 + 4, 7 splits 3 diagonally + 4 straight, and a 1-layer cell moves diagonally whole. A plume thins as it rises.
function gasDriftShare(L) { return Math.max(1, Math.floor(L / 2)) }

function gasShuffle(a) {
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1))
    var t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

// Pressure (communicating vessels): breadth-first from p through face-connected cells of air or the same gas (never
// other gases, and never a cell behind p, or the visits would go on the air under the gas), at most
// GAS_PRESSURE_REACH cells visited. A permeable run is crossed in a straight line to the first cell beyond it (spec 5,
// at most GAS_PERMEABLE_MAX blocks): the search never branches inside the run, never targets a permeable cell, never
// enters one backward (down for a rising gas, up for a sinking one), and each block crossed counts as a visit.
// Returns { target, visits, gasCells }: the nearest visited cell with room strictly ahead of p (null if none), the
// cells visited, and the visited cells holding the gas (woken on success).
function gasPressure(level, p, g, gi) {
  var seen = {}
  seen['0,0,0'] = true
  var queue = [[0, 0, 0]]
  var head = 0
  var visits = 0
  var gasCells = []
  while (head < queue.length && visits < GAS_PRESSURE_REACH) {
    var cur = queue[head++]
    for (var a = 0; a < 6 && visits < GAS_PRESSURE_REACH; a++) {
      var st = GAS_ALL_STEPS[a]
      var nx = cur[0] + st[0]
      var ny = cur[1] + st[1]
      var nz = cur[2] + st[2]
      var ahead = g.dir * ny
      if (ahead < 0) continue
      var key = nx + ',' + ny + ',' + nz
      if (seen[key]) continue
      var npos = p.offset(nx, ny, nz)
      var c = gasCell(level, npos)
      if (c == GAS_PERMEABLE) {
        if (g.dir * st[1] < 0) continue // never into a run backward
        var run = 0
        while (c == GAS_PERMEABLE && run < GAS_PERMEABLE_MAX && visits < GAS_PRESSURE_REACH) {
          visits++
          run++
          nx += st[0]
          ny += st[1]
          nz += st[2]
          npos = p.offset(nx, ny, nz)
          c = gasCell(level, npos)
        }
        if (c == GAS_PERMEABLE || visits >= GAS_PRESSURE_REACH) continue
        ahead = g.dir * ny
        if (ahead < 0) continue
        key = nx + ',' + ny + ',' + nz
        if (seen[key]) continue
      }
      if (c != GAS_AIR && !(c >= 0 && (c >> 4) == gi)) continue
      seen[key] = true
      visits++
      if (c >= 0) gasCells.push(npos)
      if (ahead > 0 && gasRoom(c, gi) > 0) return { target: npos, visits: visits, gasCells: gasCells }
      queue.push([nx, ny, nz])
    }
  }
  return { target: null, visits: visits, gasCells: gasCells }
}

function gasUpdate(level, p, now) {
  var code = gasCell(level, p)
  if (code < 0) {
    // No longer gas, or its chunk stopped ticking: drop it, and its primed mark, so gas that drifts in later
    // doesn't explode with no fire anywhere (a reviewer's finding, 2026-11-18).
    var stale = GAS_PRIMED.get(level.getDimension())
    if (stale != null) stale.remove(p)
    gasSettleForget(level, p)
    return
  }
  var gi = code >> 4
  var g = GASES[gi]
  var L = code & 15
  var moved = 0 // layers taken from p
  var filled = [] // cells written as targets
  var pressed = null // after a pressure move: the same-gas cells its search visited, to wake

  // Settling: a full cell still since `since` becomes the settle fluid's source once g.settle.after ticks have
  // passed; a cell that isn't full forgets. The new source wakes the gas around it (rule E). Never in an ultrawarm
  // dimension, where condensate evaporates instead (R6); the gate is the same for the four fluid condensates (moonwater,
  // vitriol, vermilion, quicksilver: 2026-11-20), which stay gas there (a proposal to let them settle is open).
  var settles = g.settle != null && !gasUltraWarm(level)
  if (settles) {
    var since = gasSettleMap(level).get(p)
    if (L < 8) { if (since != null) gasSettleForget(level, p) }
    else if (since != null && now >= Number(since) + g.settle.after) {
      gasSettleForget(level, p)
      if (level.setBlock(p, gasSettleState(g), 3)) { gasWakeWide(level, p, now + 1); gasVibrate(level, GAS_SETTLE_VIBRATION, p, 'settle'); return }
    }
  }

  // 0. Primed by an explosion: ignite, within this tick's cap (else wait a tick, primed).
  var primed = GAS_PRIMED.get(level.getDimension())
  if (primed != null && primed.remove(p)) {
    var ir = GAS_IGNITE[gi]
    if (ir != null) {
      var ires = gasApply(level, ir, p, gi, L, null, -1, now)
      if (ires == 1) return
      if (ires == -1) { primed.add(p.immutable()); gasEnqueue(level, p, now + 1); return }
    }
  }

  // 1. Ceiling (rising gas thins out) and the failsafe (sinking gas falls out of the world).
  var done = false
  if (g.dir > 0 && p.getY() >= gasCeiling(g, level)) { moved = 1; done = true }
  else if (g.dir < 0 && level.isOutsideBuildHeight(gasAhead(g, p))) { moved = L; done = true }

  // 2. Reactions.
  var retry = false
  if (!done && GAS_RULES[gi].length > 0) {
    var rr = gasReact(level, p, gi, L, now)
    if (rr == 1) return // applied; gasApply woke the cells around
    if (rr == 3) { gasEnqueue(level, p, now + 1); return }
    if (rr == 2) retry = true
  }

  // 2a. Held (spec-fans-pumps): a cell inside a running fan's current (not its downstream end) or a nozzle's region doesn't
  // move on its own: no swap, move, drift, spread, flow or pressure, and no requeue; the fan's step moves it. A reaction retry
  // still comes back, and a full settling cell held still counts toward settling.
  if (!done && GAS_HELD != null && gasHeldUntil(level, p, now) > now) {
    if (retry) gasEnqueue(level, p, now + Math.max(g.interval, GAS_REACTION_RETRY))
    else if (settles && L == 8) gasSettleStill(level, p, g, now)
    return
  }

  if (!done) {
    // The cell ahead, past any permeable run (b.pos is the cell ahead itself when there is none); null when the run
    // goes on past GAS_PERMEABLE_MAX.
    var b = gasBeyond(level, p, 0, g.dir, 0)

    // 3. Density swap with the cell ahead, looking through a permeable run as the straight move does: whole cells
    // trade places (mass conserved), and the update ends. Every pair of different gases swaps when g passes the
    // other, so the denser gas always ends below.
    if (b != null && b.code >= 0 && (b.code >> 4) != gi && gasPasses(g, GASES[b.code >> 4])) {
      var q = b.pos
      var cq = b.code
      if (gasSwapCells(level, p, code, q, cq)) {
        var sdue = now + g.interval
        gasEnqueue(level, p, sdue)
        gasEnqueue(level, q, sdue)
        gasWakeWide(level, p, sdue)
        gasWakeWide(level, q, sdue)
      }
      return
    }

    // 4a. Straight ahead, through any permeable run (up to GAS_PERMEABLE_MAX blocks). The target is written first; p
    // gives up its layers only if that write succeeded.
    // Drift (spec-drift, split by spec-top-split): when the cell ahead is the adjacent one (no permeable run crossed) and
    // has room, the gas first rolls its drift chance; on a hit the cell splits: gasDriftShare(L) layers (half, at least
    // 1) move diagonally ahead as 4b does (gasMoveDiagonal, as many as fit), and the rest go straight ahead. A 1-layer
    // cell moves diagonally whole; if no diagonal takes gas, the whole cell goes straight (the plain move). One random
    // number per straight move; the diagonal scan only on a hit.
    if (b != null) {
      var roomQ = gasRoom(b.code, gi)
      if (roomQ > 0) {
        if (g.drift > 0 && b.pos.getY() == p.getY() + g.dir && Math.random() < g.drift) moved = gasMoveDiagonal(level, p, g, gi, gasDriftShare(L), filled)
        // The straight move: the layers the diagonal didn't take (all L on a miss), as many as fit. If this write fails
        // after a diagonal one, the rest stays in p; either way p keeps L - moved (written after step 4), as after a spread.
        var hadQ = b.code == GAS_AIR ? 0 : (b.code & 15)
        var up = Math.min(L - moved, roomQ)
        if (up > 0 && gasWrite(level, b.pos, g, hadQ + up, hadQ)) { moved += up; filled.push(b.pos) }
      }
    }

    // 4b. Diagonally ahead (the author's request, 2026-11-18), when straight ahead is blocked: into the cell ahead
    // of a side neighbour (an edge), then ahead of a horizontal diagonal (a corner). Only along an open path, so
    // gas never slips through the seam where a wall meets a roof: an edge needs its side cell passable (air or
    // the same gas), a corner needs its diagonal cell and one of the two side cells passable.
    if (moved == 0) moved = gasMoveDiagonal(level, p, g, gi, L, filled)

    // 4c. Spread, one layer to each side that can take it, through any permeable run (up to GAS_PERMEABLE_MAX).
    // Air takes a layer when L >= 2, or when the cell ahead of it has room (gas slides out from under an edge).
    if (moved == 0) {
      var order = gasShuffle([0, 1, 2, 3])
      for (var i = 0; i < 4 && L - moved > 0; i++) {
        var nb = gasBeyond(level, p, GAS_H_STEPS[order[i]][0], 0, GAS_H_STEPS[order[i]][1])
        if (nb == null) continue
        var n = nb.pos
        var cn = nb.code
        var cur = L - moved
        if (cn == GAS_AIR) {
          if (cur >= 2 || gasRoomAhead(level, g, gi, n)) {
            if (gasWrite(level, n, g, 1, 0)) { moved++; filled.push(n) }
          }
        } else if (cn >= 0 && (cn >> 4) == gi && (cn & 15) <= cur - 2) {
          if (gasWrite(level, n, g, (cn & 15) + 1, cn & 15)) { moved++; filled.push(n) }
        }
      }
    }

    // 4d. Flow toward the nearest way ahead within reach, one layer one step. The search looks through permeable
    // blocks along its line (spec 5: they hold no gas, so they are never the way ahead); the step itself always
    // goes to the side cell, which must take gas.
    if (moved == 0) {
      var best = GAS_SLOPE_REACH + 1
      var bestSides = []
      for (var s = 0; s < 4; s++) {
        var dir = GAS_H_DIRS[s]
        if (gasRoom(gasCell(level, p.relative(dir)), gi) <= 0) continue
        for (var k = 1; k <= GAS_SLOPE_REACH && k <= best; k++) {
          // Not p.relative(dir, k): Rhino can't choose between relative(Direction, int) and
          // relative(Direction$Axis, int) (an in-game error, 2026-11-18).
          var cell = p.offset(GAS_H_STEPS[s][0] * k, 0, GAS_H_STEPS[s][1] * k)
          var cc = gasCell(level, cell)
          if (cc == GAS_PERMEABLE) continue
          var roomC = gasRoom(cc, gi)
          if (roomC < 0) break // not air or the same gas
          if (roomC > 0 && gasRoomAhead(level, g, gi, cell)) {
            if (k < best) { best = k; bestSides = [dir] } else bestSides.push(dir)
            break
          }
        }
      }
      if (bestSides.length > 0) {
        var step = p.relative(bestSides[Math.floor(Math.random() * bestSides.length)])
        var cs = gasCell(level, step)
        var hadS = cs == GAS_AIR ? 0 : (cs & 15)
        if (gasWrite(level, step, g, hadS + 1, hadS)) { moved = 1; filled.push(step) }
      }
    }

    // 4e. Pressure (spec 4): one layer to the nearest cell with room strictly ahead of p, through a connected body of
    // air and the same gas, for what the local rules can't resolve (it can look like a jump within a cloud). Each
    // move raises the sum of direction x height x layers, so it ends. The visits are capped per tick: a search that
    // could go over the cap waits a tick.
    if (moved == 0) {
      if (gasPressureVisits + GAS_PRESSURE_REACH > GAS_PRESSURE_VISITS_PER_TICK) { gasEnqueue(level, p, now + 1); return }
      var pr = gasPressure(level, p, g, gi)
      gasPressureVisits += pr.visits
      if (pr.target != null) {
        var ct = gasCell(level, pr.target)
        var hadT = ct == GAS_AIR ? 0 : (ct & 15)
        if (gasWrite(level, pr.target, g, hadT + 1, hadT)) { moved = 1; filled.push(pr.target); pressed = pr.gasCells }
      }
    }

    if (moved == 0) {
      // A reaction partner is in place but its roll failed: check again later.
      if (retry) { gasEnqueue(level, p, now + Math.max(g.interval, GAS_REACTION_RETRY)); return }
      // Otherwise settled: costs nothing until something wakes it. A full cell of a settling gas that stayed put
      // counts towards turning into its fluid (never in an ultrawarm dimension).
      if (settles && L == 8) gasSettleStill(level, p, g, now)
      return
    }
  }

  var left = L - moved
  if (!gasWrite(level, p, g, left, L)) {
    // Can't happen in practice (the state differs and the chunk ticks), but if it did, the targets already
    // hold the moved layers and gas would be duplicated: say so in the log rather than fail silently.
    console.warn('faetouched gases: source write failed at ' + p + ' after moving ' + moved + ' layer(s); gas duplicated')
    return
  }

  // Requeue: p if still gas, every filled cell and its gas neighbours (so arriving gas meets settled gas and
  // reaction partners at once), the gas around p by rule E (so gas behind and beside follows), and after a pressure
  // move the same-gas cells its search visited.
  var due = now + g.interval
  if (left > 0) gasEnqueue(level, p, due)
  for (var f = 0; f < filled.length; f++) {
    gasEnqueue(level, filled[f], due)
    gasWakeNeighbours(level, filled[f], due)
  }
  gasWakeWide(level, p, due)
  if (pressed != null) for (var w = 0; w < pressed.length; w++) gasWakeCell(level, pressed[w], due)
}

// --- The tick ---

var gasTickCount = 0

// Create open pipe ends: every full 125 mB becomes a layer at the output cell; the rest waits.
function gasDrainPipes(level) {
  var byPos = GAS_PIPE.get(level.getDimension())
  if (byPos == null || byPos.isEmpty()) return
  var posIt = byPos.entrySet().iterator()
  while (posIt.hasNext()) {
    var posEntry = posIt.next()
    var pos = posEntry.getKey()
    var fluidIt = posEntry.getValue().entrySet().iterator()
    while (fluidIt.hasNext()) {
      var fe = fluidIt.next()
      var gi = GAS_BY_FLUID.get(fe.getKey())
      var mb = Number(fe.getValue())
      if (gi == null) { fluidIt.remove(); continue }
      var layers = Math.floor(mb / GAS_LAYER_MB)
      if (layers <= 0 || !level.shouldTickBlocksAt(pos)) continue
      var left = gasAdd(level, pos, Number(gi), layers)
      mb -= (layers - left) * GAS_LAYER_MB
      if (mb <= 0) fluidIt.remove()
      else fe.setValue(mb)
    }
    if (posEntry.getValue().isEmpty()) posIt.remove()
  }
}

// Runs due updates of one level, at most `budget`; returns how many it ran. Due entries left over carry over.
function gasRunQueue(level, budget) {
  var tree = GAS_QUEUES.get(level.getDimension())
  if (tree == null || tree.isEmpty()) return 0
  var members = GAS_MEMBERS.get(level.getDimension())
  var now = gasNow(level)
  var ran = 0
  while (ran < budget) {
    var first = tree.firstEntry()
    if (first == null || first.getKey() > now) break
    var dq = first.getValue()
    while (ran < budget && !dq.isEmpty()) {
      var p = dq.pollFirst()
      members.remove(p)
      gasUpdate(level, p, now)
      ran++
    }
    // Updates queue at now + 1 or later, so this entry is still the first one.
    if (dq.isEmpty()) tree.pollFirstEntry()
  }
  return ran
}

ServerEvents.tick(e => {
  gasTickCount++
  gasPressureVisits = 0
  gasAirflowSpent = 0
  // Random-tick wake-ups from the startup script.
  while (!GAS_INBOX.isEmpty()) {
    var en = GAS_INBOX.poll()
    var lv = en.getKey()
    gasEnqueue(lv, en.getValue(), gasNow(lv))
  }
  // The detectors (K5): once a second, for every player holding one.
  if (gasTickCount % GAS_DETECT_EVERY == 0) gasDetectAll(e.server)
  // Fans (spec-fans-pumps): the player-area scan that finds them again after a restart or /reload.
  if (GAS_FANS != null) gasFanScan(e.server)
  // Gas screens whose block went without a player breaking it (spec-tank-view).
  if (gasTickCount % GAS_VIEW_ORPHAN_EVERY == 0) gasViewOrphans(e.server)
  var levels = []
  var it = e.server.getAllLevels().iterator()
  while (it.hasNext()) levels.push(it.next())
  if (levels.length == 0) return
  var budget = GAS_UPDATES_PER_TICK
  // Start at a different level each tick so one busy dimension can't starve the others.
  var start = gasTickCount % levels.length
  for (var i = 0; i < levels.length; i++) {
    var level = levels[(start + i) % levels.length]
    gasDrainPipes(level)
    // The airflow (fans and nozzles), before the cell updates, under its own read budget shared by all dimensions.
    if (GAS_FANS != null) gasAirflow(level)
    if (budget > 0) budget -= gasRunQueue(level, budget)
  }
})

// --- Wake-ups ---

// A block broken or placed wakes the gas around it by rule E (gasWakeWide).
// A collector broken drops its filter, and a fan or nozzle placed or broken has its fan looked at on the next airflow tick
// (spec-fans-pumps).
BlockEvents.broken(e => {
  var b = e.block
  gasWakeWide(b.level, b.pos, gasNow(b.level))
  gasFanBlockChanged(b.level, b.pos)
  gasCollectorBroken(b)
  gasViewBroken(b)
})

BlockEvents.placed(e => {
  var b = e.block
  gasWakeWide(b.level, b.pos, gasNow(b.level))
  gasFanBlockChanged(b.level, b.pos)
})

// An explosion wakes the gas around everything it reached. Cloud cells of a gas that explodes (hydrogen, firedamp) are
// taken out of the blast, so they survive it, and primed: each ignites on its next update, within the per-tick
// ignition cap, so a cloud burns through as a chain.
LevelEvents.afterExplosion(e => {
  var level = e.level
  var now = gasNow(level)
  var seen = new GasHashSet()
  var blocks = e.getAffectedBlocks()
  var primed = null
  for (var i = 0; i < blocks.size(); i++) {
    var lb = blocks.get(i)
    var p = lb.pos
    var code = gasCell(level, p)
    if (code >= 0 && GAS_IGNITE[code >> 4] != null) {
      e.removeAffectedBlock(lb)
      if (primed == null) primed = gasPrimedSet(level)
      primed.add(p.immutable())
      gasEnqueue(level, p, now)
    }
    for (var a = 0; a < 6; a++) {
      var n = p.relative(GAS_ALL_DIRS[a])
      if (seen.add(n)) gasWakeCell(level, n, now)
    }
    var below = p.below()
    for (var b = 0; b < 4; b++) {
      var s = below.relative(GAS_H_DIRS[b])
      if (seen.add(s)) gasWakeCell(level, s, now)
    }
  }
})

// --- Vent (a Multiblocked2 kinetic machine) and collector (a KubeJS block entity); each acts every 10 ticks ---

// Vent: the pipe-to-world outlet. Every action (10 ticks) it releases layers from its tank on the gas's side (the top for a
// rising gas, the bottom for a sinking one), else on the first free side of the two that aren't shaft faces. With no turning
// shaft it releases one layer an action (12.5 mB a tick, the author's call, 2026-11-21); turning, it speeds up to the nozzle's
// rate, |RPM| / 2 mB a tick (spec-pump-speed).
// Since spec-kinetic-vent (2026-11-21) the vent is an MBD2 Create kinetic machine (mbd2/machines/gas_vent.json, written to
// minecraft/ldlib2/assets/mbd2/create_machine/gas_vent.cm by tools/mbd2-gen.js), so it is itself a member of the shaft network
// through its front and back (its shaft faces), imposes stress (4 su per RPM, as Create's mechanical pump) and turns with the
// network: its speed is its own block entity's getSpeed(), and no neighbouring shaft is read any more. Its tank is the MBD2
// trait 'gas' and the tank view's slot the trait 'view' (gasTankOf, gasViewInv).
var GAS_VENT_ID = gasId('gas_vent')
var GAS_VENT_ACTION_TICKS = 10 // the vent acts on every 10th tick of its offset timer (gasVentTick)
var GAS_VENT_FACINGS = ['north', 'east', 'south', 'west'] // the facing names, in GAS_H_DIRS order
var GAS_VENT_RELEASE_MAX = 40 // layers an action at most: the nozzle's cap of 8 a 2-tick step over 10 ticks (past 256 RPM only)
var gasVentCredit = {} // vent key -> the mB fraction it carries to its next action (this script copy; lost on /reload: harmless)
// mB a vent earns in one action at a shaft speed: the nozzle's rate (gasNozzleEarn over its pace) for 10 ticks, and never under
// one layer (the idle rate, also with no turning shaft): 125 to 25 RPM, then 5 x |RPM| (320 at 64, 640 at 128, 1280 at 256).
function gasVentEarn(rpm) {
  if (rpm == 0) return GAS_LAYER_MB
  return Math.max(GAS_LAYER_MB, gasNozzleEarn(rpm) * GAS_VENT_ACTION_TICKS / gasFanPace(rpm))
}
// Layers the vent with this key releases this action: what it earns plus the fraction it carried, in whole layers, at most 40.
// The fraction carries; whole layers it can't release (a short tank, no room) are dropped, as at the nozzle.
function gasVentLayers(key, rpm) {
  var mb = (gasVentCredit[key] || 0) + gasVentEarn(rpm)
  var n = Math.min(GAS_VENT_RELEASE_MAX, Math.floor(mb / GAS_LAYER_MB))
  var left = Math.min(mb - n * GAS_LAYER_MB, GAS_LAYER_MB - 1)
  if (left > 0) gasVentCredit[key] = left
  else delete gasVentCredit[key]
  return n
}
// One release step, which gasVentTick calls and the stub tests drive directly: tank is the vent's FluidTank (its 'gas' trait's
// storages[0]), facing its front (a Direction, or null) and rpm its own signed speed.
function gasVentRelease(level, pos, facing, rpm, tank) {
  var fs = tank.getFluid()
  if (fs.isEmpty() || fs.getAmount() < GAS_LAYER_MB) return
  var fluid = fs.getFluid()
  var gi = GAS_BY_FLUID.get(fluid)
  if (gi == null) return
  gi = Number(gi)
  // The shaft faces as GAS_H_DIRS indices (front, back); a Direction's toString() is its lowercase name. With no horizontal
  // front there are none, and every side may take gas.
  var f = facing == null ? -1 : GAS_VENT_FACINGS.indexOf(String(facing))
  var faces = f < 0 ? [] : [f, (f + 2) % 4]
  var n = gasVentLayers(String(level.getDimension()) + '|' + gasFanKey(pos), Math.abs(Number(rpm)))
  var cells = [gasAhead(GASES[gi], pos)]
  for (var d = 0; d < 4; d++) if (faces.indexOf(d) < 0) cells.push(pos.relative(GAS_H_DIRS[d]))
  for (var k = 0; k < n; k++) {
    if (tank.getFluid().getAmount() < GAS_LAYER_MB) return
    var placed = false
    for (var i = 0; i < cells.length; i++) {
      if (gasRoom(gasCell(level, cells[i]), gi) <= 0) continue
      // The tank gives up only what was placed. Drain by a FluidStack, never by a number: FluidTank also has drain(int, action),
      // and Rhino bound drain(125, EXECUTE) to drain(FluidStack, action), where KubeJS failed to read a stack from "125.0" (in
      // game, 2026-11-21: the layer was placed, the tank never went down, and the vent released gas forever).
      if (gasAdd(level, cells[i], gi, 1) == 0) { tank.drain(new GasFluidStack(fluid, GAS_LAYER_MB), GasFluidAction.EXECUTE); placed = true }
      break
    }
    if (!placed) return
  }
}
// The vent's tick. MBD2's onTick fires on every server tick; the vent acts only when its offset timer (getOffsetTimer: the game
// time plus a per-block-entity offset) is a multiple of 10, which keeps one action per 10 ticks and spreads many vents over
// different ticks instead of running them all on the same one.
function gasVentTick(machine) {
  if (Number(machine.getOffsetTimer()) % GAS_VENT_ACTION_TICKS != 0) return
  var level = machine.getLevel()
  var pos = machine.getPos()
  var be = machine.getHolder()
  gasViewSweep(level, pos, gasViewInv(be, false), false)
  var tank = gasTankOf(be)
  if (tank == null) return
  // getSpeed(): the vent's own speed in its network (Create's KineticBlockEntity), signed.
  gasVentRelease(level, pos, machine.getFrontFacing().orElse(null), be.getSpeed(), tank)
}
// MBD2's KubeJS events. Only server-side ones are used (onTick, onOpenUI): MBD2 posts its other events to server scripts on the
// singleplayer client thread too. A bare reference to a binding that doesn't exist throws and stops the rest of this file, so
// the binding is tested with typeof first; without it the vent is skipped, with one warning.
// Cancelling: only e.event.setCanceled(true) works. MBD2 registers its events without a result, so e.cancel() throws an exit
// that KubeJS logs as "Event returned result when it's not cancellable" and ignores, and a handler's return value is discarded.
// Never use e.cancel() or return false in an MBD2 handler.
if (typeof MBDMachineEvents === 'undefined') {
  gasWarnOnce('vent mbd2', 'MBDMachineEvents is missing (is Multiblocked2 loaded?): the gas vent is skipped')
} else {
  MBDMachineEvents.onTick(GAS_VENT_ID, e => {
    try { gasVentTick(e.event.machine) } catch (err) { gasWarnOnce('vent tick', 'a gas vent tick failed (' + err + ')') }
  })
  // The spec sets hasUI true, not false: with hasUI false MBD2's block passes a right click on the client, which then predicts
  // the held item's use (a ghost block and its sound, fixed for the KubeJS vent with an empty rightClick callback); with hasUI
  // true the client's openUI answers SUCCESS. On the server BlockEvents.rightClicked (below) runs first, opens the tank view and
  // cancels; for the clicks it lets through (sneaking with both hands empty, a missing block entity, a Create deployer) this
  // stops MBD2's default machine screen.
  MBDMachineEvents.onOpenUI(GAS_VENT_ID, e => {
    try { e.event.setCanceled(true) } catch (err) { gasWarnOnce('vent ui', 'the gas vent could not stop MBD2\'s machine screen (' + err + ')') }
  })
}

// Intake by collector (quest-gas slice 5, K3): on each collector action, every face that touches a listed block rolls the
// intake's chance (10 / every) and, when the roll is won and the conditions hold at the block (snowy: the ice, not the
// collector, is where the biome is read), adds one layer of the gas to the tank if the tank can take it (empty, or already
// that gas, with 125 mB of room). The block is not used up and nothing appears in the world. Block test (cached per state),
// then the roll, then the conditions (a biome read), so a face with nothing listed costs one cached lookup.
// A filtered collector (spec-fans-pumps) draws only its filter's gas here too: `filter` is that gas key, or null.
function gasCollectorIntake(level, pos, tank, filter) {
  if (GAS_INTAKE_LIST.length == 0) return
  for (var a = 0; a < 6; a++) {
    if (tank.getSpace() < GAS_LAYER_MB) return
    var n = pos.relative(GAS_ALL_DIRS[a])
    for (var i = 0; i < GAS_INTAKE_LIST.length; i++) {
      var it = GAS_INTAKE_LIST[i]
      if (filter != null && GASES[it.gas].key != filter) continue
      if (!gasPartnerAt(level, n, it.part)) continue
      if (it.p < 1 && Math.random() >= it.p) continue
      if (!gasConditionsMet(level, it, n, null)) continue
      var stack = new GasFluidStack(GASES[it.gas].fluid, GAS_LAYER_MB)
      if (tank.fill(stack, GasFluidAction.SIMULATE) < GAS_LAYER_MB) continue // holds another gas
      tank.fill(stack, GasFluidAction.EXECUTE)
      break // one layer a face
    }
  }
}

// Collector: takes one layer from each neighbouring cloud of the gas its tank holds (any gas when empty), then draws
// from the ice against it (K3, gasCollectorIntake). A collector with a gas filter (spec-fans-pumps) takes only that gas.
BlockEvents.blockEntityTick(gasId('gas_collector'), e => {
  gasCollectorMigrate(e.block.entity, e.block)
  gasViewSweep(e.level, e.block.pos, gasViewInv(e.block.entity, true), false)
  var tank = e.block.entity.attachments.get('tank')
  var filter = gasFilterOf(e.block.entity)
  var level = e.level
  var pos = e.block.pos
  var due = gasNow(level) + 1
  for (var a = 0; a < 6; a++) {
    if (tank.getSpace() < GAS_LAYER_MB) break
    var n = pos.relative(GAS_ALL_DIRS[a])
    var code = gasCell(level, n)
    if (code < 0) continue
    var gi = code >> 4
    if (filter != null && GASES[gi].key != filter) continue
    var L = code & 15
    var stack = new GasFluidStack(GASES[gi].fluid, GAS_LAYER_MB)
    if (tank.fill(stack, GasFluidAction.SIMULATE) < GAS_LAYER_MB) continue // holds another gas
    if (!gasWrite(level, n, GASES[gi], L - 1, L)) continue
    tank.fill(stack, GasFluidAction.EXECUTE)
    if (L - 1 > 0) gasEnqueue(level, n, due)
    // The 3x3x3 cube also wakes the side neighbours of the cell behind n, as gasUpdate does.
    gasWakeAround(level, n, due)
  }
  gasCollectorIntake(level, pos, tank, filter)
})

// --- Fans and nozzles (B-034, prototypes/gases/specs/spec-fans-pumps.md; the author's answers, 2026-11-20) ---
// A running Create encased fan moves the gas in its straight current, and a fan with Create's nozzle on its front draws gas
// in (pulling) or disperses it (pushing). Each fan steps every `pace` ticks, from 12 at the slowest to 2 at 256 RPM, under
// an airflow read budget shared by every fan and dimension. Gas a fan moves is held: its own update ends after reactions
// (gasUpdate step 2a), so the current beats buoyancy; the downstream end isn't held, so gas leaving the current follows the
// normal rules again. A fan stopped, removed or changed releases its cells (their holds end and the gas cells are queued).
// What Create gives a script (read in create-1.21.1-6.0.10.jar, 2026-11-20): EncasedFanBlockEntity's public field
// airCurrent (an AirCurrent: public direction, the fan's front face, set to getAirflowOriginSide(); pushing, true when the
// flow leaves that face; maxDistance, the reach cut by the first solid with collision, which gas clouds never are), its
// getSpeed() (signed RPM) and IAirCurrentSource's default getMaxDistance() (3 blocks at the slowest to 20 at 256 RPM in this
// pack's create-server.toml). No KubeJS mixin touches BlockEntity or LevelChunk (none in the 2101.7.2 jar), and LevelMixin
// hides neither hasChunkAt nor getChunkAt.
// The fans' records live in this script copy (the tick copy: the airflow tick and the scan make and read them); events from
// the other copy reach the tick through the startup-made sets and maps: GAS_FANS (fans to look at now), GAS_HELD (held cells)
// and GAS_CURRENT_CELLS (idle fans' current cells).
var GAS_FAN_ID = 'create:encased_fan'
var GAS_NOZZLE_ID = 'create:nozzle'
var GAS_FAN_PACE_SLOW = 12 // ticks between steps at the slowest
var GAS_FAN_PACE_FAST = 2 // ticks between steps at GAS_FAN_RPM_FULL and over
var GAS_FAN_RPM_FULL = 256 // the pack's fanRotationArgmax: full reach and pace from here
var GAS_FAN_IDLE_TICKS = 20 // a fan or nozzle that found no gas looks again after this (an idle fan's current wakes it sooner)
var GAS_FAN_SCAN_TICKS = 100 // each player's area is scanned for fans about this often, at most one player a tick
var GAS_FAN_SCAN_CHUNKS = 6 // chunks around the player a scan reads (13 x 13, loaded chunks only)
var GAS_NOZZLE_VISITS = 256 // cells a nozzle's search reads at most a step
var GAS_NOZZLE_EDGE_READS = 32 // cells past the search a pushing nozzle may read a step, to push gas out of its region
var GAS_NOZZLE_FACE_READS = 38 // with the edge reads, the margin over the search in a step's worst case: a pulling step reads the fan's 5 faces and at most 5 per output try (each refused try moves on to the next of at most 5 touching cells: at most GAS_NOZZLE_INTAKE_MAX + 5 = 13 tries, so 70 reads = 32 + 38) and no edge cells, a pushing step at most the 32 edge cells
// The intake (spec-pump-speed, 2026-11-21): a pulling nozzle earns mB each step at Create's own pump rate, |RPM| / 2 mB a tick
// (FluidNetwork: max(1, pump pressure / 2), the pressure being the pump's |RPM|) over the fan's pace, and at least one layer a
// step; it draws the whole layers it has earned, at most 8, and carries the fraction to its next step. So its rate is
// max(one layer a step, |RPM| / 2 mB a tick), which never falls as the speed rises (rounding each step's layers instead dipped
// at 65, 116, 141, 167 and 193 RPM: a reviewer's finding).
var GAS_NOZZLE_MB_PER_RPM = 0.5 // mB a tick per RPM, as a Create pump moves fluid
var GAS_NOZZLE_INTAKE_MAX = 8 // layers a step at most (one full cell); the pack's motors (256 RPM at most) give 1 to 4
var GAS_AIRFLOW_READS_PER_TICK = 512 // cell reads all fans and nozzles may make in one server tick; a step that could go over waits a tick

var gasAirflowSpent = 0 // cell reads by fans and nozzles this tick
var gasFanRecords = {} // dimension -> { list, byKey, turn }: the registered fans
var gasFanScanTurn = 0

function gasFanKey(p) { return p.getX() + ',' + p.getY() + ',' + p.getZ() }
function gasFanReg(level) {
  var dim = String(level.getDimension())
  var r = gasFanRecords[dim]
  if (r === undefined) { r = { list: [], byKey: {}, turn: 0 }; gasFanRecords[dim] = r }
  return r
}
// The per-dimension Java map of a startup-made map, made on first use.
function gasDimMap(top, level) {
  var dim = level.getDimension()
  var m = top.get(dim)
  if (m == null) { m = new GasHashMap(); top.put(dim, m) }
  return m
}
// Steps between fan steps for a speed in RPM: 12 at 0+, 10 at 64, 7 at 128, 2 at 256 and over.
function gasFanPace(rpm) {
  return Math.round(GAS_FAN_PACE_SLOW - (GAS_FAN_PACE_SLOW - GAS_FAN_PACE_FAST) * Math.min(Math.abs(rpm) / GAS_FAN_RPM_FULL, 1))
}
// mB a pulling nozzle earns in one step at a speed in RPM: 0 when stopped, else max(125, |rpm| x 0.5 x pace). Over the pace
// that is 10.4 mB a tick at 1 to 12 RPM, 11.4 at 13 to 22, then |RPM| / 2 (32 at 64, 64 at 128, 128 at 256).
function gasNozzleEarn(rpm) {
  if (rpm == 0) return 0
  return Math.max(GAS_LAYER_MB, Math.abs(rpm) * GAS_NOZZLE_MB_PER_RPM * gasFanPace(rpm))
}
// Layers the nozzle of fan record f may draw this step: what it earns plus the fraction it carried, in whole layers, at most
// 8. The fraction carries to the next step; whole layers it doesn't draw (no gas, no outlet) are dropped, so nothing banks up
// while it waits.
function gasNozzleIntake(f, rpm) {
  var mb = (f.credit || 0) + gasNozzleEarn(rpm)
  var n = Math.min(GAS_NOZZLE_INTAKE_MAX, Math.floor(mb / GAS_LAYER_MB))
  f.credit = Math.min(mb - n * GAS_LAYER_MB, GAS_LAYER_MB - 1)
  return n
}
// The game time a cell is held until (0 when it isn't); an expired entry is dropped.
function gasHeldUntil(level, p, now) {
  var m = GAS_HELD.get(level.getDimension())
  if (m == null) return 0
  var t = m.get(p)
  if (t == null) return 0
  if (Number(t) <= now) { m.remove(p); return 0 }
  return Number(t)
}
// A fan or nozzle placed or broken at pos: the fan there, or the fan behind a nozzle there, is looked at on the next airflow
// tick (a new fan is registered then).
function gasFanBlockChanged(level, pos) {
  if (GAS_FANS == null) return
  var id = String(level.getBlockState(pos).getId())
  var set = null
  var mark = function (p) {
    if (set == null) {
      set = GAS_FANS.get(level.getDimension())
      if (set == null) { set = new GasHashSet(); GAS_FANS.put(level.getDimension(), set) }
    }
    set.add(p.immutable())
  }
  if (id == GAS_FAN_ID) mark(pos)
  // A nozzle (placed, or broken: the event comes before the block goes) or anything else broken next to a fan: the fans around it.
  for (var a = 0; a < 6; a++) {
    var n = pos.relative(GAS_ALL_DIRS[a])
    if (String(level.getBlockState(n).getId()) == GAS_FAN_ID) mark(n)
  }
}
// Gas written into an idle fan's straight current: that fan is looked at on the next airflow tick.
function gasFanWakeAt(level, pos) {
  var cells = GAS_CURRENT_CELLS.get(level.getDimension())
  if (cells == null || cells.isEmpty()) return
  var fp = cells.get(pos)
  if (fp == null) return
  var set = GAS_FANS.get(level.getDimension())
  if (set == null) { set = new GasHashSet(); GAS_FANS.put(level.getDimension(), set) }
  set.add(fp)
}
// Registers the fan at pos (once); its first step is due now.
function gasFanRegister(level, pos, now) {
  var reg = gasFanReg(level)
  var k = gasFanKey(pos)
  var f = reg.byKey[k]
  if (f !== undefined) return f
  f = { pos: pos.immutable(), key: k, nextStep: now, shape: null, line: [], cells: [], prevCells: [], idle: false, indexed: false, pace: GAS_FAN_PACE_SLOW, rrC: 0, rrO: 0, dead: false }
  reg.byKey[k] = f
  reg.list.push(f)
  return f
}
// What the fan at pos is doing now, read from its block entity: null when it isn't a fan any more or its chunk doesn't tick;
// rpm 0 when it is stopped. shape names everything whose change releases the fan's cells.
function gasFanRead(level, pos) {
  if (!level.shouldTickBlocksAt(pos)) return null
  if (String(level.getBlockState(pos).getId()) != GAS_FAN_ID) return null
  try {
    var be = level.getBlockEntity(pos)
    if (be == null) return null
    var rpm = Number(be.getSpeed())
    var ac = be.airCurrent
    var dir = ac == null ? null : ac.direction
    if (rpm == 0 || dir == null) return { rpm: 0 }
    var s = { rpm: rpm, dir: dir, pushing: ac.pushing == true, L: Math.floor(Number(ac.maxDistance)), nozzle: false, R: 0 }
    s.nozzle = String(level.getBlockState(pos.relative(dir)).getId()) == GAS_NOZZLE_ID
    if (s.nozzle) s.R = Math.floor(Number(be.getMaxDistance()))
    s.shape = String(dir) + '|' + s.pushing + '|' + (s.nozzle ? 'nozzle ' + s.R : 'line ' + s.L)
    return s
  } catch (err) {
    gasWarnOnce('fan read', 'a Create fan could not be read (' + err + '); fans move no gas')
    return null
  }
}
// Adds (on) or removes the fan's straight current cells in the idle index.
function gasFanIndex(level, f, on) {
  if (on == f.indexed) return
  var cells = gasDimMap(GAS_CURRENT_CELLS, level)
  for (var i = 0; i < f.line.length; i++) {
    if (on) cells.put(f.line[i], f.pos)
    else if (cells.get(f.line[i]) != null && gasFanKey(cells.get(f.line[i])) == f.key) cells.remove(f.line[i])
  }
  f.indexed = on
}
// Lets the fan's cells go: the cells its last two steps held (a hold outlasts the next step by two ticks) and every cell of its
// old straight current lose their hold, and those holding gas are queued now, so the normal rules take over at once; each wakes
// the gas around it when it moves. (The spec's rule E around each released cell is left out: for a busy nozzle that was some
// 18,000 reads in one tick, outside the airflow budget; a reviewer's finding, 2026-11-20.)
function gasFanRelease(level, f, now) {
  var held = GAS_HELD.get(level.getDimension())
  var done = {}
  var all = f.cells.concat(f.prevCells, f.line)
  for (var i = 0; i < all.length; i++) {
    var p = all[i]
    var k = gasFanKey(p)
    if (done[k]) continue
    done[k] = true
    if (held != null) held.remove(p)
    if (gasCell(level, p) >= 0) gasEnqueue(level, p, now)
  }
  gasFanIndex(level, f, false)
  f.cells = []
  f.prevCells = []
}
// Marks the given cells held for this step (the last step's cells are kept for a release).
function gasFanHold(level, f, cells, now) {
  var held = gasDimMap(GAS_HELD, level)
  var until = GasLong.valueOf(Math.floor(now + f.pace + 2))
  f.prevCells = f.cells
  f.cells = cells
  for (var i = 0; i < cells.length; i++) held.put(cells[i], until)
}
// Moves as many layers of a's gas as fit into b (air or the same gas; never a swap): b written first, then a. a and b are
// { pos, code } kept current; the target is queued and a cell emptied wakes its six neighbours. Returns whether it moved.
function gasFanMove(level, a, b, now) {
  if (a.code < 0) return false
  var gi = a.code >> 4
  var room = gasRoom(b.code, gi)
  if (room <= 0) return false
  var La = a.code & 15
  var hadB = b.code == GAS_AIR ? 0 : (b.code & 15)
  var put = Math.min(La, room)
  var g = GASES[gi]
  if (!gasWrite(level, b.pos, g, hadB + put, hadB)) return false
  if (!gasWrite(level, a.pos, g, La - put, La)) console.warn('faetouched gases: fan source write failed at ' + a.pos + '; gas duplicated')
  b.code = gi * 16 + hadB + put
  a.code = La - put > 0 ? gi * 16 + La - put : GAS_AIR
  var due = gasNow(level) + g.interval
  gasEnqueue(level, b.pos, due)
  if (a.code == GAS_AIR) gasWakeNeighbours(level, a.pos, due)
  return true
}
// The straight current's cells, 1 to L from the fan.
function gasFanLine(pos, s) {
  var out = []
  var p = pos
  for (var i = 1; i <= s.L; i++) { p = p.relative(s.dir); out.push(p) }
  return out
}
// One step of a straight current: cells taken downstream first, each moving one cell along the flow (a pushing current's end
// cell also out past the reach when air or the same gas is there; a wall or another gas stops it). Returns { reads, gas }.
function gasFanStraight(level, f, s, now) {
  var L = f.line.length
  if (L < 1) return { reads: 0, gas: false }
  var c = []
  for (var i = 0; i < L; i++) c.push({ pos: f.line[i], code: gasCell(level, f.line[i]) })
  var beyond = s.pushing ? f.line[L - 1].relative(s.dir) : null
  if (beyond != null) c.push({ pos: beyond, code: gasCell(level, beyond) })
  var reads = c.length
  var any = false
  for (var j = 0; j < L; j++) if (c[j].code >= 0) any = true
  if (!any) return { reads: reads, gas: false }
  // c[i] is cell i + 1. Pushing: L -> L + 1, then L - 1 -> L down to 1 -> 2. Pulling: 2 -> 1 up to L -> L - 1.
  if (s.pushing) for (var u = L - 1; u >= 0; u--) gasFanMove(level, c[u], c[u + 1], now)
  else for (var v = 1; v < L; v++) gasFanMove(level, c[v], c[v - 1], now)
  // Held: every gas cell of the current but its downstream end (cell L pushing, cell 1 pulling).
  var hold = []
  for (var h = s.pushing ? 0 : 1; h < (s.pushing ? L - 1 : L); h++) if (c[h].code >= 0) hold.push(c[h].pos)
  gasFanHold(level, f, hold, now)
  return { reads: reads, gas: true }
}
// A collector's gas filter: the gas key of the imprinted filter in its filter slot (spec-tank-view), or null for none. A
// collector placed before the slot existed, not yet migrated (gasCollectorMigrate), still has the key in its block entity data.
function gasFilterOf(be) {
  if (be == null) return null
  var inv = gasCollectorSlot(be)
  if (inv != null) {
    var st = gasSlotGet(inv)
    if (!st.isEmpty()) return gasFilterKeyOf(st)
  }
  return gasFilterOldKey(be)
}
// The filter key a collector placed before spec-tank-view keeps in its block entity data, or null.
function gasFilterOldKey(be) {
  var d = be.data
  if (d == null || !d.contains(GAS_FILTER_BE_KEY)) return null
  var v = String(d.getString(GAS_FILTER_BE_KEY))
  return v == '' ? null : v
}
// The collector's filter slot (its 'filter' inventory attachment), or null if it has none.
function gasCollectorSlot(be) {
  try { var a = be.attachments.get('filter'); return a == null ? null : a } catch (err) { gasWarnOnce('filter slot', 'a collector has no filter slot (' + err + ')'); return null }
}
// One layer of gas gi drawn by a pulling nozzle goes out through the fan's other faces (outs, made once a step: { pos, be }
// where be is a collector's block entity, else null): collectors that can take it first (filter, tank empty or that gas, room
// for a layer), round robin from a rotating start, straight into the tank; else an open face (air or the same gas with room),
// round robin, written as gasAdd writes its target. Returns false when nothing could take it, so nothing is drawn.
function gasNozzleOutput(level, f, outs, gi, now, st) {
  var n = outs.length
  var g = GASES[gi]
  for (var k = 0; k < n; k++) {
    var ic = (f.rrC + k) % n
    var be = outs[ic].be
    if (be == null) continue
    var filter = gasFilterOf(be)
    if (filter != null && filter != g.key) continue
    var tank = be.attachments.get('tank')
    var stack = new GasFluidStack(g.fluid, GAS_LAYER_MB)
    if (tank.fill(stack, GasFluidAction.SIMULATE) < GAS_LAYER_MB) continue
    tank.fill(stack, GasFluidAction.EXECUTE)
    f.rrC = ic + 1
    return true
  }
  for (var m = 0; m < n; m++) {
    var io = (f.rrO + m) % n
    if (outs[io].be != null) continue
    var code = gasCell(level, outs[io].pos)
    st.reads++
    var room = gasRoom(code, gi)
    if (room <= 0) continue
    var had = code == GAS_AIR ? 0 : (code & 15)
    if (!gasWrite(level, outs[io].pos, g, had + 1, had)) continue
    gasEnqueue(level, outs[io].pos, now + 1)
    gasWakeNeighbours(level, outs[io].pos, now + 1)
    f.rrO = io + 1
    return true
  }
  return false
}
// One nozzle step: a search from the nozzle's five free faces through air and gas (permeable blocks count as solid) over
// the cells within Manhattan distance R of the nozzle or in the fan's 3 x 3 x 3 cube, taken in order of that distance, at most
// GAS_NOZZLE_VISITS cells read. Pulling: gas touching the nozzle is drawn in (at most
// gasNozzleIntake(f, rpm) layers, fullest first) and goes out through the fan (gasNozzleOutput); then every gas cell, nearest first,
// moves one step toward the nozzle (into its search parent, air or the same gas). Pushing: every gas cell, farthest first,
// moves one step away (to a neighbour one farther, or past the search), straight out along the dominant axis when it can,
// else at random. The gas cells of the region are held. Returns { reads, gas }.
function gasNozzleStep(level, f, s, now) {
  var noz = f.pos.relative(s.dir)
  var st = { reads: 0 }
  var seen = {}
  seen[gasFanKey(noz)] = -2
  seen[gasFanKey(f.pos)] = -2
  // The fan's own faces stay out of the region: they are the outlets, and gas written there mid-step must not be moved from
  // a stale count (a reviewer's finding, 2026-11-20: carbon dioxide written to an open side was overwritten and lost).
  for (var fa = 0; fa < 6; fa++) seen[gasFanKey(f.pos.relative(GAS_ALL_DIRS[fa]))] = -2
  var cells = []
  var capped = false
  // The reach (spec-pump-speed, 2026-11-21): a cell is in reach when its Manhattan distance from the nozzle is at most R, or when
  // it lies in the fan's own 3 x 3 x 3 cube, so the search goes round the fan and reaches as far behind the nozzle as to its sides
  // (before, the search stopped at path distance R, and the fan with its six faces cost a detour of about 4 steps behind). Cells
  // are taken in order of that distance (a bucket per distance; one found from a farther cell joins the current bucket), so the
  // read cap grows the region evenly. d stays the path length through the search (the push step reads it); a parent is always
  // found before its children, so the pull step still moves the nearest cells first.
  var nx = noz.getX(), ny = noz.getY(), nz = noz.getZ()
  var fx = f.pos.getX(), fy = f.pos.getY(), fz = f.pos.getZ()
  var reachOf = function (p) {
    var px = p.getX(), py = p.getY(), pz = p.getZ()
    var m = Math.abs(px - nx) + Math.abs(py - ny) + Math.abs(pz - nz)
    if (m <= s.R) return m
    if (Math.abs(px - fx) <= 1 && Math.abs(py - fy) <= 1 && Math.abs(pz - fz) <= 1) return m
    return -1
  }
  var buckets = [[]]
  var bucketAdd = function (idx, m, at) {
    var bi = Math.max(m, at)
    while (buckets.length <= bi) buckets.push([])
    buckets[bi].push(idx)
  }
  for (var a = 0; a < 6; a++) {
    var n0 = noz.relative(GAS_ALL_DIRS[a])
    var k0 = gasFanKey(n0)
    if (seen[k0] !== undefined) continue
    var c0 = gasCell(level, n0)
    st.reads++
    if (c0 == GAS_AIR || c0 >= 0) { seen[k0] = cells.length; bucketAdd(cells.length, 1, 1); cells.push({ pos: n0, code: c0, d: 1, parent: -1 }) } else seen[k0] = -1
  }
  for (var bi = 1; bi < buckets.length && !capped; bi++) {
    var bk = buckets[bi]
    for (var qi = 0; qi < bk.length && !capped; qi++) {
      var head = bk[qi]
      var cur = cells[head]
      for (var b = 0; b < 6; b++) {
        var n = cur.pos.relative(GAS_ALL_DIRS[b])
        var kn = gasFanKey(n)
        if (seen[kn] !== undefined) continue
        var mn = reachOf(n)
        if (mn < 0) continue
        if (st.reads >= GAS_NOZZLE_VISITS) { capped = true; break }
        var cn = gasCell(level, n)
        st.reads++
        if (cn == GAS_AIR || cn >= 0) { seen[kn] = cells.length; bucketAdd(cells.length, mn, bi); cells.push({ pos: n, code: cn, d: cur.d + 1, parent: head }) } else seen[kn] = -1
      }
    }
  }
  var any = false
  for (var q = 0; q < cells.length; q++) if (cells[q].code >= 0) any = true
  if (!any) return { reads: st.reads, gas: false }
  if (!s.pushing) {
    // The fan's other faces, read once: a collector's block entity, or an outlet to try per layer.
    var outs = []
    for (var o = 0; o < 6; o++) {
      var fp = f.pos.relative(GAS_ALL_DIRS[o])
      if (gasFanKey(fp) == gasFanKey(noz)) continue
      var isCol = String(level.getBlockState(fp).getId()) == gasId('gas_collector')
      st.reads++
      outs.push({ pos: fp, be: isCol ? level.getBlockEntity(fp) : null })
    }
    var touching = cells.filter(t => t.d == 1 && t.code >= 0).sort((x, y) => (y.code & 15) - (x.code & 15))
    var drawn = 0
    var intake = gasNozzleIntake(f, s.rpm)
    for (var ti = 0; ti < touching.length && drawn < intake; ti++) {
      var t = touching[ti]
      while (t.code >= 0 && drawn < intake) {
        var gi = t.code >> 4
        var Lt = t.code & 15
        if (!gasNozzleOutput(level, f, outs, gi, now, st)) break
        if (!gasWrite(level, t.pos, GASES[gi], Lt - 1, Lt)) console.warn('faetouched gases: nozzle intake write failed at ' + t.pos + '; gas duplicated')
        t.code = Lt - 1 > 0 ? gi * 16 + Lt - 1 : GAS_AIR
        if (t.code == GAS_AIR) gasWakeNeighbours(level, t.pos, now + GASES[gi].interval)
        drawn++
      }
    }
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i]
      if (c.d >= 2 && c.code >= 0) gasFanMove(level, c, cells[c.parent], now)
    }
  } else {
    var order = cells.filter(x => x.code >= 0).sort((x, y) => y.d - x.d)
    var edge = 0
    for (var j = 0; j < order.length; j++) {
      var cc = order[j]
      if (cc.code < 0) continue
      var gj = cc.code >> 4
      var ox = cc.pos.getX() - noz.getX(), oy = cc.pos.getY() - noz.getY(), oz = cc.pos.getZ() - noz.getZ()
      var big = Math.max(Math.abs(ox), Math.abs(oy), Math.abs(oz))
      var best = []
      var other = []
      for (var e = 0; e < 6; e++) {
        var stp = GAS_ALL_STEPS[e]
        var np = cc.pos.offset(stp[0], stp[1], stp[2])
        var kk = gasFanKey(np)
        var idx = seen[kk]
        var tgt = null
        if (idx === undefined) {
          if (edge >= GAS_NOZZLE_EDGE_READS) continue
          var ce = gasCell(level, np)
          st.reads++
          edge++
          seen[kk] = (ce == GAS_AIR || ce >= 0) ? cells.length : -1
          if (seen[kk] < 0) continue
          tgt = { pos: np, code: ce, d: cc.d + 1, parent: -1, outside: true }
          cells.push(tgt)
        } else if (idx >= 0 && (cells[idx].d == cc.d + 1 || cells[idx].outside)) tgt = cells[idx]
        if (tgt == null || gasRoom(tgt.code, gj) <= 0) continue
        // Straight out: the step goes along an axis on which the cell lies farthest from the nozzle, away from it.
        var out = (big > 0 && ((stp[0] != 0 && Math.abs(ox) == big && stp[0] * ox > 0) || (stp[1] != 0 && Math.abs(oy) == big && stp[1] * oy > 0) || (stp[2] != 0 && Math.abs(oz) == big && stp[2] * oz > 0)))
        if (out) best.push(tgt)
        else other.push(tgt)
      }
      var pick = best.length > 0 ? best : other
      if (pick.length > 0) gasFanMove(level, cc, pick[Math.floor(Math.random() * pick.length)], now)
    }
  }
  // Held: the region's gas cells (not the ones pushed out past it).
  var hold = []
  for (var hh = 0; hh < cells.length; hh++) if (cells[hh].code >= 0 && !cells[hh].outside) hold.push(cells[hh].pos)
  gasFanHold(level, f, hold, now)
  return { reads: st.reads, gas: true }
}
// One fan's step, or nothing (it waits a tick) when the step could go over this tick's airflow budget.
function gasFanStep(level, f, now) {
  var s = gasFanRead(level, f.pos)
  if (s == null) { gasFanRelease(level, f, now); f.dead = true; return }
  if (s.rpm == 0) {
    if (f.shape != null) { gasFanRelease(level, f, now); f.shape = null; f.line = [] }
    f.idle = true
    f.nextStep = now + GAS_FAN_IDLE_TICKS
    return
  }
  var worst = s.nozzle ? GAS_NOZZLE_VISITS + GAS_NOZZLE_EDGE_READS + GAS_NOZZLE_FACE_READS : s.L + 1
  if (gasAirflowSpent + worst > GAS_AIRFLOW_READS_PER_TICK) return
  if (s.shape != f.shape) {
    gasFanRelease(level, f, now)
    f.shape = s.shape
    f.line = s.nozzle ? [] : gasFanLine(f.pos, s)
  }
  f.pace = gasFanPace(s.rpm)
  var r = s.nozzle ? gasNozzleStep(level, f, s, now) : gasFanStraight(level, f, s, now)
  gasAirflowSpent += r.reads
  if (r.gas) {
    f.idle = false
    f.nextStep = now + f.pace
    gasFanIndex(level, f, false)
  } else {
    f.idle = true
    f.prevCells = f.cells
    f.cells = []
    f.nextStep = now + GAS_FAN_IDLE_TICKS
    if (!s.nozzle) gasFanIndex(level, f, true)
  }
}
// The airflow of one level: the fans to look at now (placed, or an idle current woken) step at once; then every fan whose step
// is due steps, round robin from a rotating start, within the budget.
function gasAirflow(level) {
  var now = Number(gasNow(level))
  var reg = gasFanReg(level)
  var set = GAS_FANS.get(level.getDimension())
  if (set != null && !set.isEmpty()) {
    var it = set.iterator()
    while (it.hasNext()) {
      var p = it.next()
      it.remove()
      var f0 = gasFanRegister(level, p, now)
      if (f0.nextStep > now) f0.nextStep = now
    }
  }
  var n = reg.list.length
  if (n == 0) return
  var start = reg.turn++ % n
  var dead = false
  for (var i = 0; i < n; i++) {
    var f = reg.list[(start + i) % n]
    if (f.dead || f.nextStep > now) continue
    gasFanStep(level, f, now)
    if (f.dead) dead = true
  }
  if (dead) {
    reg.list = reg.list.filter(x => !x.dead)
    Object.keys(reg.byKey).forEach(k => { if (reg.byKey[k].dead) delete reg.byKey[k] })
  }
}
// The player-area scan: one player's surroundings at most each tick, each player about every GAS_FAN_SCAN_TICKS ticks. Every
// fan block entity in a loaded chunk within GAS_FAN_SCAN_CHUNKS of the player is registered (a chunk not loaded is never
// loaded for it). This finds fans again after a restart or /reload; gas only moves in ticking chunks anyway.
function gasFanScan(server) {
  var players = server.getPlayerList().getPlayers()
  var n = players.size()
  if (n == 0) return
  var every = Math.max(1, Math.floor(GAS_FAN_SCAN_TICKS / n))
  if (gasTickCount % every != 0) return
  var pl = players.get(gasFanScanTurn++ % n)
  gasFanScanAround(pl.level, pl.blockPosition())
}
function gasFanScanAround(level, at) {
  var now = Number(gasNow(level))
  for (var dx = -GAS_FAN_SCAN_CHUNKS; dx <= GAS_FAN_SCAN_CHUNKS; dx++) {
    for (var dz = -GAS_FAN_SCAN_CHUNKS; dz <= GAS_FAN_SCAN_CHUNKS; dz++) {
      var cp = at.offset(dx * 16, 0, dz * 16)
      if (!level.hasChunkAt(cp)) continue
      var it = level.getChunkAt(cp).getBlockEntities().values().iterator()
      while (it.hasNext()) {
        var be = it.next()
        if (String(be.getBlockState().getId()) == GAS_FAN_ID) gasFanRegister(level, be.getBlockPos(), now)
      }
    }
  }
}

// --- Gas filters (spec-fans-pumps) ---
// Right-click with a blank filter: a ray from the eye along the look, cell by cell, up to the block interaction range, passes
// air, gas and permeable blocks and stops at anything else (cloud blocks have an empty outline, so vanilla's hit result looks
// through them). At the first gas cell it takes one layer (the cell written, rule E's cube around it, as the collector does),
// one blank filter leaves the stack and one imprinted filter for that gas goes to the player (dropped when the inventory is
// full). An imprinted filter right-clicked on a gas collector goes in (swapping out the old one); sneak-right-click with an
// empty hand takes it out; breaking the collector drops it. ItemEvents.rightClicked (use in the air) and BlockEvents.rightClicked
// (looking through a cloud at a block) can both fire for one click, so a player acts at most once a tick.
var GAS_FILTER_ID = gasId('gas_filter')
var GAS_FILTER_IMPRINTED_ID = gasId('gas_filter_imprinted')
var GAS_FILTER_ITEM_KEY = 'faetouched_gas' // the imprinted filter's custom data: the gas key
var GAS_FILTER_BE_KEY = 'faetouched_gas_filter' // the collector's block entity data: the gas key
var GAS_FILTER_RANGE = 4.5 // used only if the player's blockInteractionRange() can't be read

// The first gas cell on the ray from eye (x, y, z) along look (x, y, z) within range blocks, as { pos, code }, or null. A 3D
// DDA: it steps into each cell the ray enters, in order.
function gasFilterRay(level, eye, look, range) {
  var len = Math.sqrt(look[0] * look[0] + look[1] * look[1] + look[2] * look[2])
  if (!(len > 0)) return null
  var d = [look[0] / len, look[1] / len, look[2] / len]
  var cell = [Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2])]
  var pos = BlockPos.containing(eye[0], eye[1], eye[2])
  var step = [0, 0, 0]
  var tMax = [Infinity, Infinity, Infinity]
  var tDelta = [Infinity, Infinity, Infinity]
  for (var a = 0; a < 3; a++) {
    if (d[a] > 0) { step[a] = 1; tMax[a] = (cell[a] + 1 - eye[a]) / d[a]; tDelta[a] = 1 / d[a] }
    else if (d[a] < 0) { step[a] = -1; tMax[a] = (eye[a] - cell[a]) / -d[a]; tDelta[a] = -1 / d[a] }
  }
  var t = 0
  for (var guard = 0; guard < 64 && t <= range; guard++) {
    var code = gasCell(level, pos)
    if (code >= 0) return { pos: pos, code: code }
    if (code == GAS_BLOCKED) return null
    var ax = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2)
    t = tMax[ax]
    tMax[ax] += tDelta[ax]
    pos = pos.offset(ax == 0 ? step[0] : 0, ax == 1 ? step[1] : 0, ax == 2 ? step[2] : 0)
  }
  return null
}
// An imprinted filter for the gas key.
function gasFilterStack(key) {
  var stack = Item.of(GAS_FILTER_IMPRINTED_ID)
  var tag = stack.getCustomData()
  tag.putString(GAS_FILTER_ITEM_KEY, key)
  stack.setCustomData(tag)
  var gi = gasIndexOf(key)
  try {
    stack.setLore([Text.of(gi >= 0 ? gasDebugGasTitle(gi) : key)])
  } catch (err) {
    gasWarnOnce('filter lore', 'the gas filter\'s lore could not be set (' + err + '); it names no gas')
  }
  return stack
}
// The gas key an imprinted filter holds, or null.
function gasFilterKeyOf(stack) {
  if (stack == null || stack.isEmpty() || String(stack.id) != GAS_FILTER_IMPRINTED_ID) return null
  var tag = stack.getCustomData()
  if (!tag.contains(GAS_FILTER_ITEM_KEY)) return null
  var key = String(tag.getString(GAS_FILTER_ITEM_KEY))
  return gasIndexOf(key) >= 0 ? key : null
}
function gasFilterName(key) { var gi = gasIndexOf(key); return gi >= 0 ? gasDebugGasTitle(gi) : key }
// Once a tick per player: false when the player already acted this tick.
function gasFilterTurn(player, level) {
  var k = 'filter ' + String(player.getStringUuid())
  var now = Number(gasNow(level))
  var t = GAS_STATE.get(k)
  if (t != null && Number(t) == now) return false
  GAS_STATE.put(k, now)
  return true
}
// Imprinting with the blank filter stack in the player's hand. Returns whether a layer was taken.
function gasFilterImprint(player, stack) {
  if (stack == null || stack.isEmpty() || String(stack.id) != GAS_FILTER_ID) return false
  var level = player.level
  if (!gasFilterTurn(player, level)) return false
  var eye = player.getEyePosition()
  var look = player.getLookAngle()
  var range = GAS_FILTER_RANGE
  try { range = Number(player.blockInteractionRange()) } catch (err) { gasWarnOnce('filter range', 'blockInteractionRange() could not be read (' + err + '); filters reach ' + GAS_FILTER_RANGE + ' blocks') }
  var hit = gasFilterRay(level, [eye.x(), eye.y(), eye.z()], [look.x(), look.y(), look.z()], range)
  if (hit == null) return false
  var gi = hit.code >> 4
  var L = hit.code & 15
  if (!gasWrite(level, hit.pos, GASES[gi], L - 1, L)) return false
  var due = gasNow(level) + 1
  if (L - 1 > 0) gasEnqueue(level, hit.pos, due)
  gasWakeAround(level, hit.pos, due)
  stack.shrink(1)
  player.give(gasFilterStack(GASES[gi].key))
  player.setStatusMessage(Text.of('Gas filter imprinted: ' + gasDebugGasTitle(gi)))
  return true
}
// Whether the player already acted this tick (gasFilterTurn), without taking the turn.
function gasFilterActed(player, level) {
  var t = GAS_STATE.get('filter ' + String(player.getStringUuid()))
  return t != null && Number(t) == Number(gasNow(level))
}

// --- The collector's filter slot and the tank view (spec-tank-view) ---
// The collector's filter is the one item in its 'filter' inventory attachment (startup script): an imprinted filter, put in
// by hand, through the screen, or by a hopper or funnel on the top or bottom face. The slot is read and written through
// stacks() (KubeJS's InventoryAttachment$Wrapped, the only class with that name), not getStackInSlot or setStackInSlot, which
// the class has twice for scripts (ItemStackHandler's and KubeJS's kjs$ copy, both the same name and arguments). A write
// through stacks() fires no change event, so it saves the block entity itself.
var GAS_COLLECTOR_ID = gasId('gas_collector') // GAS_VENT_ID: with the vent's tick, above
var GAS_VIEW_RANGE_SQ = 64 // a viewer more than 8 blocks from the block's centre has the screen closed, as vanilla containers do
function gasSlotGet(inv) { return inv.stacks().get(0) }
function gasSlotSet(be, inv, stack) { inv.stacks().set(0, stack); be.save() }
// A collector placed before the slot keeps its filter's gas key in its block entity data: move it into the slot, or drop it at
// the block if the slot is already full, so no filter is lost.
function gasCollectorMigrate(be, block) {
  var key = gasFilterOldKey(be)
  if (key == null) return
  var inv = gasCollectorSlot(be)
  if (inv == null) return
  be.data.remove(GAS_FILTER_BE_KEY)
  if (gasSlotGet(inv).isEmpty()) gasSlotSet(be, inv, gasFilterStack(key))
  else { block.popItem(gasFilterStack(key)); be.save() }
}
// Rule 1: an imprinted filter goes into the slot, and the one that was there comes back to the player.
function gasCollectorInsert(player, stack, level, be) {
  if (!gasFilterTurn(player, level)) return true
  var inv = gasCollectorSlot(be)
  if (inv == null) return true
  var key = gasFilterKeyOf(stack)
  var old = gasSlotGet(inv)
  gasSlotSet(be, inv, gasFilterStack(key))
  stack.shrink(1)
  if (!old.isEmpty()) player.give(old)
  player.setStatusMessage(Text.of('Collector filter: ' + gasFilterName(key)))
  return true
}
// Rule 2: sneaking with an empty hand takes the filter out. With none in, nothing happens (false: not cancelled).
function gasCollectorRemove(player, level, be) {
  var inv = gasCollectorSlot(be)
  if (inv == null) return false
  var old = gasSlotGet(inv)
  if (old.isEmpty()) return false
  if (!gasFilterTurn(player, level)) return true
  gasSlotSet(be, inv, Item.of('minecraft:air'))
  player.give(old)
  player.setStatusMessage(Text.of('Collector filter removed'))
  return true
}
// A collector placed before the slot and broken before it migrated still has its key: drop that filter (the event comes
// before the block goes). A filter in the slot is dropped by KubeJS (InventoryAttachment.onRemove), so not here.
function gasCollectorBroken(b) {
  if (String(b.level.getBlockState(b.pos).getId()) != GAS_COLLECTOR_ID) return
  var be = b.level.getBlockEntity(b.pos)
  var key = be == null ? null : gasFilterOldKey(be)
  if (key != null) b.popItem(gasFilterStack(key))
}
// The screen's title: the tank's reading when the screen opens, e.g. 'Gas Collector: Steam, 520 mB (4 layers + 20 mB)'.
function gasTankTitle(name, tank) {
  if (tank == null) return name
  var fs = tank.getFluid()
  if (fs.isEmpty()) return name + ': empty'
  var mb = Number(fs.getAmount())
  var gi = GAS_BY_FLUID.get(fs.getFluid())
  var gas = gi != null ? gasDebugGasTitle(Number(gi)) : 'unknown gas'
  var L = Math.floor(mb / GAS_LAYER_MB)
  var rest = mb - L * GAS_LAYER_MB
  var layers = L == 0 ? 'under a layer' : (L == 1 ? '1 layer' : L + ' layers') + (rest > 0 ? ' + ' + rest + ' mB' : '')
  return name + ': ' + gas + ', ' + mb + ' mB (' + layers + ')'
}
// The block's tank: the collector's KubeJS 'tank' attachment, or the vent's MBD2 trait 'gas' (its first storage, an LDLib
// FluidStorage, which is a NeoForge FluidTank). The vent's block entity is an MBD2 one, the only kind with getMetaMachine. A
// mistyped trait name in the spec decodes silently to an empty trait, so a missing one warns (once) and gives null.
function gasTankOf(be) {
  try {
    if (typeof be.getMetaMachine != 'function') return be.attachments.get('tank')
    var t = be.getMetaMachine().getTraitByName('gas')
    if (t == null) { gasWarnOnce('vent gas trait', 'a gas vent has no \'gas\' trait (mbd2/machines/gas_vent.json): it releases nothing'); return null }
    return t.storages[0]
  } catch (err) { gasWarnOnce('gas tank', 'a gas block\'s tank could not be read (' + err + ')'); return null }
}
// The block's screen inventory: the collector's filter slot (its 'filter' attachment), or the vent's MBD2 trait 'view', whose
// storage (an LDLib ItemStackTransfer, a NeoForge ItemStackHandler, which openInventoryGUI takes) refuses every item (an enabled
// item whitelist with nothing listed). The storage is one object for the life of the block entity, so the screens' identity
// checks (gasViewing, gasViewOrphans) work as with the attachment.
function gasViewInv(be, collector) {
  try {
    if (collector) { var a = be.attachments.get('filter'); return a == null ? null : a }
    var t = be.getMetaMachine().getTraitByName('view')
    if (t == null) { gasWarnOnce('vent view trait', 'a gas vent has no \'view\' trait (mbd2/machines/gas_vent.json): its screen can\'t open'); return null }
    return t.storage
  } catch (err) { gasWarnOnce('view inv', 'a gas block has no screen inventory (' + err + ')'); return null }
}
// Rule 5: KubeJS's inventory screen (real slots; it doesn't take the player's inventory, as its chest screen does), one slot,
// titled with the tank.
function gasViewOpen(player, be, collector, pos) {
  // A fake player (a Create deployer) gets no screen: it shares its owner's UUID, so its record would replace the owner's.
  if (player.isFake() == true) return
  var inv = gasViewInv(be, collector)
  if (inv == null) return
  var u = String(player.getStringUuid())
  GAS_STATE.put('view ' + u, Number(gasNow(player.level)))
  // For gasViewOrphans: the screen's slot, and where its block is (dimension, position, which block).
  GAS_STATE.put('viewinv ' + u, inv)
  GAS_STATE.put('viewat ' + u, String(player.level.getDimension()) + '|' + pos.getX() + '|' + pos.getY() + '|' + pos.getZ() + '|' + (collector ? 'c' : 'v'))
  player.openInventoryGUI(inv, Text.of(gasTankTitle(collector ? 'Gas Collector' : 'Gas Vent', gasTankOf(be))), 1, 1)
}
// A screen whose block is gone (a drill, an explosion, /setblock, a contraption: nothing a player breaks, so neither the
// broken event nor the block's own tick, which stops with it, closes it), the author's report 2026-11-21. Every
// GAS_VIEW_ORPHAN_EVERY ticks, for each player a gas screen was opened for: when the open menu no longer holds that screen's
// slot, the record is dropped (the player closed it, or opened another screen, which is left alone); when it does, the screen
// closes if the player is in another dimension or the block at the recorded position is no longer that block with that slot.
var GAS_VIEW_ORPHAN_EVERY = 5
function gasViewForget(u) { GAS_STATE.remove('viewinv ' + u); GAS_STATE.remove('viewat ' + u) }
function gasViewOrphans(server) {
  var ps = server.getPlayerList().getPlayers()
  var n = ps.size()
  for (var i = 0; i < n; i++) {
    var p = ps.get(i)
    var u = String(p.getStringUuid())
    var inv = GAS_STATE.get('viewinv ' + u)
    if (inv == null) continue
    if (!gasViewing(p, inv)) { gasViewForget(u); continue }
    var at = String(GAS_STATE.get('viewat ' + u)).split('|')
    var level = p.level
    var gone = at.length != 5 || String(level.getDimension()) != at[0]
    // Declared here, not in the block below: KubeJS's Rhino scoped a var set in one if block of this loop to that block,
    // and the next block threw "pos is not defined" in game (2026-11-22).
    var pos = null
    if (!gone) {
      pos = BlockPos.containing(Number(at[1]), Number(at[2]), Number(at[3]))
      // Farther than the block tick's 8 blocks (a teleport, whose block may no longer tick), or in a chunk that isn't loaded:
      // closed without reading the block, which would load the chunk on the server thread every pass.
      var dx = p.getX() - (pos.getX() + 0.5), dy = p.getY() - (pos.getY() + 0.5), dz = p.getZ() - (pos.getZ() + 0.5)
      gone = dx * dx + dy * dy + dz * dz > GAS_VIEW_RANGE_SQ || !level.isLoaded(pos)
    }
    if (!gone) {
      var id = String(level.getBlockState(pos).getId())
      var collector = at[4] == 'c'
      var be = id == (collector ? GAS_COLLECTOR_ID : GAS_VENT_ID) ? level.getBlockEntity(pos) : null
      gone = be == null || gasViewInv(be, collector) != inv
    }
    if (gone) { gasViewClose(p); gasViewForget(u) }
  }
}
// A record holds the slot, and through it the block entity and its level, in a global map: forget it when the player leaves
// (ServerEvents.loaded forgets them all at the next start).
PlayerEvents.loggedOut(e => { gasViewForget(String(e.player.getStringUuid())) })
// Whether the player's open screen is the one for this inventory (a KubeJSMenu whose guiData holds it).
function gasViewing(player, inv) {
  var menu = player.getOpenInventory()
  if (menu == null) return false
  var gui = menu.guiData
  return gui != null && gui.inventory == inv
}
// Closes the player's screen. KubeJS renames Player.closeContainer to closeMenu for scripts (@RemapForJS in PlayerMixin).
function gasViewClose(player) {
  try { player.closeMenu() } catch (err) { gasWarnOnce('view close', 'closeMenu() failed (' + err + '); trying closeContainer()'); player.closeContainer() }
}
// KubeJS's menus never close themselves (stillValid is always true), so on each block tick the screens open on this block are
// closed for players more than 8 blocks away or in another dimension; with broken set, all of them (the block is going).
function gasViewSweep(level, pos, inv, broken) {
  if (inv == null) return
  var server = level.getServer()
  if (server == null) return
  var ps = server.getPlayerList().getPlayers()
  var n = ps.size()
  if (n == 0) return
  var dim = String(level.getDimension())
  for (var i = 0; i < n; i++) {
    var p = ps.get(i)
    if (!gasViewing(p, inv)) continue
    var close = broken || String(p.level.getDimension()) != dim
    if (!close) {
      var dx = p.getX() - (pos.getX() + 0.5), dy = p.getY() - (pos.getY() + 0.5), dz = p.getZ() - (pos.getZ() + 0.5)
      close = dx * dx + dy * dy + dz * dz > GAS_VIEW_RANGE_SQ
    }
    if (close) gasViewClose(p)
  }
}
function gasViewBroken(b) {
  var id = String(b.level.getBlockState(b.pos).getId())
  if (id != GAS_COLLECTOR_ID && id != GAS_VENT_ID) return
  var be = b.level.getBlockEntity(b.pos)
  if (be != null) gasViewSweep(b.level, b.pos, gasViewInv(be, id == GAS_COLLECTOR_ID), true)
}
// The right-click rules for the collector and the vent, in order; the first that applies wins. Returns whether the script
// acted (the click is then cancelled). The main hand's event decides; an off-hand event is cancelled only when the player
// already acted this tick.
//   1. imprinted filter: into the collector (swapping); the vent goes on to the rules below
//   2. sneaking, empty hand: the collector's filter comes out (with none, nothing); the vent: nothing
//   2b. a wrench (Create's or Extended Wrenches') on the vent, not sneaking, opens nothing: for a player who may build it turns
//      the vent's front a quarter turn whichever face is clicked (the author's call, 2026-11-22); for one who may not
//      (adventure, spectator) nothing happens, as Create's wrench refuses them. On the top or bottom, and for a player who may
//      not build, the script does nothing, so the click goes on to the block (MBD2's screen is cancelled by onOpenUI, which
//      answers "not used") and then to the wrench. On a side the script turns it (gasVentWrench) and cancels. Sneaking with
//      it falls under rule 3 (Create picks the vent up). The collector has no wrench action.
//   3. sneaking with an item: nothing from the script (vanilla places the block or uses the item)
//   4. a blank filter: imprint from a gas on the look ray; if no layer was taken, go on to rule 5
//   5. anything else, or an empty hand: open the screen
var GAS_WRENCH_IDS = ['create:wrench', 'extendedwrenches:extended_wrench'] // ExtendedWrenchItem extends Create's WrenchItem
var GasUseOnContext = Java.loadClass('net.minecraft.world.item.context.UseOnContext')
// MBD2 turns a kinetic machine around the clicked face's axis (MBDKineticMachineBlock.getRotatedBlockState). A side face's
// axis is horizontal, which would point the vent's front up or down; the vent's rotation state (NON_Y_AXIS) forbids that, so
// MBD2 skipped on to the opposite side, a half-turn flip, and the shaft faces did nothing. A side click is therefore handed to
// Create's own onWrenched as if on the top (its sound and kinetic update come with it). Returns whether the script acted.
// A player who may not build (adventure, spectator) is left to Create's WrenchItem.useOn, which then does nothing, as on the top.
function gasVentWrench(e, level, pos) {
  var face = String(e.facing)
  if (face == 'up' || face == 'down') return false
  if (e.entity.mayBuild() != true) return false
  var state = level.getBlockState(pos)
  state.getBlock().onWrenched(state, new GasUseOnContext(e.entity, e.hand, e.hitResult.withDirection(Direction.UP)))
  return true
}
function gasTankClick(e, collector) {
  var player = e.entity
  var stack = e.item
  var b = e.block
  var level = b.level
  if (String(e.hand) != 'MAIN_HAND') return gasFilterActed(player, level)
  var be = level.getBlockEntity(b.pos)
  if (be == null) return false
  if (collector) gasCollectorMigrate(be, b)
  var empty = stack == null || stack.isEmpty()
  if (collector && !empty && gasFilterKeyOf(stack) != null) return gasCollectorInsert(player, stack, level, be)
  if (!collector && !empty && GAS_WRENCH_IDS.indexOf(String(stack.id)) >= 0 && player.isShiftKeyDown() != true) return gasVentWrench(e, level, b.pos)
  if (player.isShiftKeyDown() == true) return collector && empty ? gasCollectorRemove(player, level, be) : false
  var blank = !empty && String(stack.id) == GAS_FILTER_ID
  if (blank && gasFilterImprint(player, stack)) return true
  // A blank filter's imprint attempt already took this tick's turn.
  if (blank || gasFilterTurn(player, level)) gasViewOpen(player, be, collector, b.pos)
  return true
}

// A guard: before the blocks answered a right click on the client (the collector's empty rightClick callback in the startup
// script, the vent's hasUI true in its MBD2 spec), the client didn't know the click was used and sent an item use after it,
// so a bucket poured against the block or a pearl flew. Those stop it on the client; any item use by a player who opened a
// gas screen this tick or the last is still cancelled here.
function gasViewJustOpened(player) {
  var t = GAS_STATE.get('view ' + String(player.getStringUuid()))
  return t != null && Number(gasNow(player.level)) - Number(t) <= 1
}
ItemEvents.rightClicked(e => { if (gasViewJustOpened(e.entity)) e.cancel() })
ItemEvents.rightClicked(GAS_FILTER_ID, e => { if (!gasViewJustOpened(e.entity)) gasFilterImprint(e.entity, e.item) })
BlockEvents.rightClicked(e => {
  var b = e.block
  var id = String(b.level.getBlockState(b.pos).getId())
  if (id == GAS_COLLECTOR_ID || id == GAS_VENT_ID) {
    if (gasTankClick(e, id == GAS_COLLECTOR_ID)) e.cancel()
    return
  }
  gasFilterImprint(e.entity, e.item)
})

// --- Blocks that read gas (K2): the poll of every registered sensor's block ---
// A registered block's own tick (it must be a KubeJS block entity block that ticks) reads each of its sensors once their
// `every` has passed since the block's last reading of it (the time is kept in the block entity's data), keeps the result in
// the data (faetouched_gas_sense_<id>, faetouched_gas_layers_<id>) and, if the entry names a property, sets it.
function gasSensorProperty(level, pos, s, met) {
  var st = level.getBlockState(pos)
  var cache = met ? s.stateOn : s.stateOff
  var next = cache.get(st)
  if (next == null) {
    var props = {}
    props[s.property] = met ? 'true' : 'false'
    next = gasStateWith(st, props)
    if (next == null) { gasWarnOnce('sensor property ' + s.id, 'sensor ' + s.id + ' names the property ' + s.property + ', which ' + st.getId() + ' lacks; nothing is set'); return }
    cache.put(st, next)
  }
  if (!gasSameState(next, st)) level.setBlock(pos, next, 3)
}
function gasSensorPoll(e, list) {
  var be = e.block.entity
  var level = e.level
  var pos = e.block.pos
  var now = Number(gasNow(level))
  var data = be.data
  for (var i = 0; i < list.length; i++) {
    var s = list[i]
    var atKey = GAS_SENSE_DATA + s.id + '_at'
    if (data.contains(atKey) && now - Number(data.getLong(atKey)) < s.every) continue
    data.putLong(atKey, now)
    var res = gasSense(level, pos, s)
    var metKey = GAS_SENSE_DATA + s.id
    var was = data.contains(metKey) ? data.getBoolean(metKey) == true : null
    data.putBoolean(metKey, res.met)
    data.putInt('faetouched_gas_layers_' + s.id, res.layers)
    if (was !== res.met) be.save()
    if (s.property != null) gasSensorProperty(level, pos, s, res.met)
  }
}
Object.keys(GAS_SENSORS_BY_BLOCK).forEach(function (bid) {
  var list = GAS_SENSORS_BY_BLOCK[bid]
  try {
    BlockEvents.blockEntityTick(bid, e => gasSensorPoll(e, list))
  } catch (err) {
    console.warn('faetouched gases: the sensors of ' + bid + ' could not be hooked (' + err + '); they do nothing')
  }
})

// --- Detectors (K5): the Sapper's Safety Lamp reads the gas around a player holding it, once a second ---
// Held in either hand, the lamp reads the 3 x 3 columns around the player from one cell below the feet to three above them
// (45 cells). Each gas with a signal that is there (any layers) gives that signal: 'blue' sets the lamp's custom model data
// to 1 (its blue model) and anything else clears it; every signal says so on the action bar, 'gutter' with smoke too.
// The lamp is no open flame, so it lights nothing. Nothing is read for a player holding no detector.
var GAS_DETECT_EVERY = 20 // ticks between readings
var GAS_DETECT_DOWN = 1 // cells below the player's feet
var GAS_DETECT_UP = 3 // cells above the player's feet
var GAS_DETECT_RADIUS = 1 // cells to each side
var GAS_SIGNAL_TEXT = { blue: 'The lamp burns blue: ', gutter: 'The lamp flame gutters: ' }
// The model: KubeJS's own stack.setCustomModelData(int) (ComponentFunctions.kjs$setCustomModelData, read in the jar), not
// ItemStack.get, set or remove, which KubeJS also remaps (kjs$get and kjs$remove) and which would be ambiguous. Value 0 is
// the lamp's plain model: the item model's override matches custom_model_data 1 and above only. Setting the value it already
// has changes nothing.
function gasLampModel(stack, n) {
  try {
    stack.setCustomModelData(n)
  } catch (err) {
    gasWarnOnce('lamp model', 'the lamp\'s model could not be set (' + err + '); it keeps its look')
  }
}
function gasDetectorFor(stack) {
  if (stack == null || stack.isEmpty()) return null
  var id = String(stack.id)
  for (var i = 0; i < GAS_DETECTOR_LIST.length; i++) if (GAS_DETECTOR_LIST[i].item == id) return GAS_DETECTOR_LIST[i]
  return null
}
// The gas indexes found around the feet cell `feet` in the detection box.
function gasDetectScan(level, feet) {
  var found = {}
  for (var dx = -GAS_DETECT_RADIUS; dx <= GAS_DETECT_RADIUS; dx++) {
    for (var dz = -GAS_DETECT_RADIUS; dz <= GAS_DETECT_RADIUS; dz++) {
      for (var dy = -GAS_DETECT_DOWN; dy <= GAS_DETECT_UP; dy++) {
        var code = gasCell(level, feet.offset(dx, dy, dz))
        if (code >= 0) found[code >> 4] = true
      }
    }
  }
  return found
}
function gasDetect(p) {
  var held = [p.getMainHandItem(), p.getOffHandItem()]
  var lamps = []
  for (var h = 0; h < held.length; h++) {
    var det = gasDetectorFor(held[h])
    if (det != null) lamps.push({ stack: held[h], det: det })
  }
  if (lamps.length == 0) return
  var level = p.level
  var found = null
  var shown = {}
  for (var i = 0; i < lamps.length; i++) {
    if (found == null) found = gasDetectScan(level, p.blockPosition())
    var signals = []
    var texts = []
    for (var gi = 0; gi < GASES.length; gi++) {
      var sg = lamps[i].det.signals[gi]
      if (sg == null || !found[gi]) continue
      if (signals.indexOf(sg) < 0) signals.push(sg)
      texts.push((GAS_SIGNAL_TEXT[sg] !== undefined ? GAS_SIGNAL_TEXT[sg] : sg + ': ') + GASES[gi].key.split('_').join(' '))
    }
    gasLampModel(lamps[i].stack, signals.indexOf('blue') >= 0 ? 1 : 0)
    if (texts.length > 0 && !shown[texts.join('; ')]) {
      shown[texts.join('; ')] = true
      p.setStatusMessage(Text.of(texts.join('; ')))
    }
    if (signals.indexOf('gutter') >= 0) level.spawnParticles('minecraft:smoke', true, p.getX(), p.getY() + 1.0, p.getZ(), 0.15, 0.15, 0.15, 3, 0.01)
  }
}
function gasDetectAll(server) {
  if (GAS_DETECTOR_LIST.length == 0) return
  var players = server.getPlayerList().getPlayers()
  for (var i = 0; i < players.size(); i++) gasDetect(players.get(i))
}

// The shared collections live for the whole game launch (startup script), so a world opened after another in
// the same launch would inherit its queue, inbox, pipe remainders, primed cells and settle times: clear them when a
// server starts. `loaded` fires once per server start, so the double load of server scripts doesn't matter here.
ServerEvents.loaded(e => {
  GAS_QUEUES.clear()
  GAS_MEMBERS.clear()
  GAS_INBOX.clear()
  GAS_PIPE.clear()
  GAS_PRIMED.clear()
  GAS_STATE.clear()
  if (GAS_SETTLE != null) GAS_SETTLE.clear()
  if (GAS_FANS != null) { GAS_FANS.clear(); GAS_HELD.clear(); GAS_CURRENT_CELLS.clear() }
  gasFanRecords = {}
})

// --- Tags and recipes ---

ServerEvents.tags('fluid', e => {
  GASES.forEach(g => {
    e.add('faetouched:gases', [gasId(g.key), gasId('flowing_' + g.key)])
  })
})

// Blocks gas passes through (any number in a row, up to GAS_PERMEABLE_MAX): leaves, fences, chains, bars, scaffolding and
// glass panes (glass panes leak: the author's call, 2026-11-18).
// The vent is an MBD2 machine (spec-kinetic-vent), which has no tool setting: it goes in minecraft:mineable/pickaxe here, as
// KubeJS's tagBlock did, so a pickaxe still mines it fast (it drops by hand too now). A plain add: it is replayed or rerun
// with the rest of this handler either way.
ServerEvents.tags('block', e => {
  e.add('minecraft:mineable/pickaxe', GAS_VENT_ID)
  e.add(GAS_PERMEABLE_TAG, ['#minecraft:leaves', '#minecraft:fences', '#c:chains', '#c:glass_panes', 'minecraft:iron_bars', 'minecraft:scaffolding'])
  gasSkyShadeTag(e)
})

// The masks (K5, slice 5) go in the Curios head slot's item tag (curios:head is an item tag in the pack's dump), so a mask can
// be worn there; the startup script's cloud effects also count a mask in the head armor slot.
ServerEvents.tags('item', e => {
  if (GAS_MASK_ITEMS.length > 0) e.add('curios:head', GAS_MASK_ITEMS)
})

// faetouched:sky_shade (slice 4, R35): the blocks that shade the sky, stained glass of every mod, panes too. Built here
// from the glass-like tags, keeping blocks whose ID contains "stained_glass" (the author's call, 2026-11-19: all other
// glass is open): the glass blocks, glass panes, dyed and impermeable tags, #c:glass if the event lists it, and every tag
// whose own name says stained glass (Chipped, which is
// disabled in this pack today, keeps its pane blocks only in tags such as chipped:red_stained_glass_pane). Clear glass,
// glass panes, tinted glass (a roof anyway: it passes no light), iron bars and the rest never match the ID test.
// How KubeJS 2101.7 runs this handler (read in ServerScriptManager.reload, PreTagKubeEvent and TagLoaderKJS): first on a
// PreTagKubeEvent with no tags loaded, whose recorded add and remove calls it replays when the tags load, unless the run
// asked a tag for its blocks (PreTagWrapper.getObjectIds sets the event invalid and returns nothing); then it posts the
// real TagKubeEvent and runs the handler again (a handler that throws doesn't make it rerun: EventHandlerContainer
// catches the throw). So the four source tags that always exist (minecraft:impermeable from vanilla, c:glass_blocks,
// c:glass_panes and c:dyed from NeoForge) are asked for their blocks every time, which is what makes KubeJS rerun this
// on the real event; with the lookup done only for tags the event lists, the pre-run found none and the tag was never
// built. Only tags that always exist get that unconditional call: TagKubeEvent.get makes a missing tag empty and
// KubeJS writes it back, which c:glass would do here (no jar of this pack defines it; Every Compat, whose entries it
// held in the dump, is disabled), so c:glass and the tags named for stained glass are asked only when the event lists
// them. On the real event getObjectIds lists a tag's blocks with the tags it holds already resolved. A failure leaves the tag as far as it got, and says so; an empty
// result is warned about only when the event does list tags (the pre-run lists none). gasShadeBlock also treats any
// block whose ID contains stained_glass as shade, so the sky test never depends on this tag alone.
var GAS_SKY_SHADE_SOURCES = ['c:glass_blocks', 'c:glass_panes', 'c:dyed', 'minecraft:impermeable']
function gasSkyShadeTag(e) {
  var ids = {}
  var count = 0
  var take = function (list) {
    var arr = gasList(list)
    for (var i = 0; i < arr.length; i++) {
      var id = String(arr[i])
      if (id.indexOf('stained_glass') >= 0 && !ids[id]) { ids[id] = true; count++ }
    }
  }
  var listed = 0 // tags the event lists (none on KubeJS's pre-run)
  try {
    // The tags that exist, by text (a Map<ResourceLocation, ...> holds no String key, so containsKey(text) would say
    // none do): c:glass and the tags named for stained glass are asked for only if they exist, so e.get never makes an
    // empty tag of a name that isn't there. The four sources that always exist are always asked (see above).
    var named = []
    gasKeys(e.tags).forEach(k => { listed++; if ((k.indexOf('stained_glass') >= 0 || k == 'c:glass') && GAS_SKY_SHADE_SOURCES.indexOf(k) < 0) named.push(k) })
    GAS_SKY_SHADE_SOURCES.concat(named).forEach(t => { take(e.get(t).getObjectIds()) })
  } catch (err) {
    console.warn('faetouched gases: building the tag ' + GAS_SKY_SHADE_TAG + ' failed (' + err + '); stained glass may not shade the sky')
  }
  if (count > 0) e.add(GAS_SKY_SHADE_TAG, Object.keys(ids))
  else if (listed > 0) console.warn('faetouched gases: the tag ' + GAS_SKY_SHADE_TAG + ' is empty; stained glass does not shade the sky')
}

// Recipes: the vent and collector are placeholders until the gas chain is designed.
ServerEvents.recipes(e => {
  // Vermilion (R20) pressed back into cinnabar by a Create compactor: no reaction drops items (the author's call,
  // 2026-11-19). One bucket gives one cinnabar, which Create's crushing and mixing turn into about 250 mB of quicksilver,
  // a quarter of the bucket of argent the reaction took.
  e.recipes.create.compacting(Item.of(gasId('cinnabar')), Fluid.of(gasId('vermilion'), 1000)).id(gasId('gases/vermilion_compacting'))
  e.shaped(gasId('gas_vent'), ['B', 'C', 'P'], {
    B: 'minecraft:iron_bars', C: 'create:copper_casing', P: 'create:fluid_pipe'
  }).id(gasId('gases/gas_vent'))
  e.shaped(gasId('gas_collector'), [' B ', 'BCB', ' P '], {
    B: 'minecraft:iron_bars', C: 'create:copper_casing', P: 'create:mechanical_pump'
  }).id(gasId('gases/gas_collector'))
  // Gas filters (spec-fans-pumps): placeholders until the gas chain is designed, like the vent's and collector's. An imprinted
  // filter crafted alone is cleared back to a blank one (an item ingredient matches whatever custom data the stack holds).
  e.shapeless('2x ' + gasId('gas_filter'),['minecraft:paper', 'minecraft:charcoal']).id(gasId('gases/gas_filter'))
  e.shapeless(gasId('gas_filter'), [gasId('gas_filter_imprinted')]).id(gasId('gases/gas_filter_clear'))
})

// --- Test rig: /gas debug ---
// /gas debug [section] builds sealed glass chambers from the gas and reaction tables, starting GAS_DEBUG_OFFSET
// blocks along +X from the caller, floor at the caller's feet: each section's chambers along +X, wrapping into a new
// row whenever a row would run past GAS_DEBUG_ROW_LEN blocks (B-034 quest gases, slice 1), rows along +Z.
// /gas debug gas <key> builds one gas against all the others: its solo chamber, its density and side-by-side pairs,
// its permeable chambers (only the first rising and the first sinking gas have any) and the reaction and blast
// chambers it takes part in (as the reacting gas, a partner gas or a test partner gas). /gas debug rule <id> builds one
// reaction's chambers (its chain too, if it explodes). Both use the same sections, filtered (gasDebugPlan's `only`).
// Everything in the rig's box is overwritten; a box over GAS_DEBUG_MAX_CELLS is refused. /gas debug clear empties the
// last rig built in this dimension; its box is kept in server.persistentData, so clear works after /reload and
// restarts. Clear refuses while any chunk of the box isn't loaded with its entities (stand near the rig), and when the
// rig is no longer there (its corner glass is gone); /gas debug clear force clears the recorded box anyway.
// Explosion chambers (R2, the chain) break the ground under the rig and blocks outside its box, which clear doesn't
// restore: test in creative, on cleared ground (the legend and the reply say so).
// Gas in the rig is dormant: written with gasWrite and never queued, so it moves only when something wakes it.
// Every chamber starts when one red stained glass divider block (red concrete in the condition chambers) is broken: the divider block on the front face (-Z)
// has a window in front of it, a light block at level 0, which is invisible, click-through and solid to gas, so the
// player can reach the divider and the chamber stays sealed. Reaction chambers keep the gas and its partner apart
// too (spec 4): they meet only across an edge, which no reaction or move crosses, until the divider goes and the gas
// moves into its cell, beside the partner. So random ticks (about 68 s on average) can't start anything, except in the
// condition chambers flagged selfStarting (R34's sinking rime in a warm biome, R38's scalding steam), which have no partner
// to keep apart; for timing tests, /gamerule randomTickSpeed 0 still keeps the gas from waking early.
// Extending: a new gas or rule in the startup tables gets its chambers on the next restart, with no change here.
// A rule whose partner is a tag needs a test partner in GAS_DEBUG_TEST_PARTNERS, keyed by rule id; a `test` field
// on the rule in the startup table, in the same form, wins over the map. New permeable blocks go in
// GAS_DEBUG_PERMEABLE. Sizes, blocks and gaps are the constants below.
// Later rule kinds get their layouts in gasDebugReaction or a section of their own (block results, slice 3, use the
// reaction layouts with test partners, and the pair layout for R33; the condition rules of slice 4 have gasDebugCondition;
// the gear section of slice 5 holds the gas rooms for masks, detectors and damage, and the chambers of the intakes (K3) and
// the registered sensors (K2), none with a divider; /gas debug rule <id> takes an intake's or a sensor's id too):
// a new section goes in GAS_DEBUG_SECTIONS and gasDebugPlan, and takes the `only` filter there.
// Build order (spec 5: no mixing row). Explosive chambers (R2 and the chain) have a section of their own, last
// (slice 1), so only that section's rows carry the blast gap, along the row, between its rows and from the row before.
var GAS_DEBUG_SECTIONS = ['solo', 'density', 'side', 'permeable', 'reactions', 'gear', 'blasts']
var GAS_DEBUG_ROW_LEN = 64 // longest row in blocks, shells included; a section with more chambers wraps into more rows (a single wider chamber gets a row of its own)
var GAS_DEBUG_SIDE = { len: 3, w: 3, h: 2 } // side by side: two compartments 3 long, 3 deep, 2 high, a divider wall between
var GAS_DEBUG_LABEL_TAG = 'faetouched_gas_debug' // entity tag of the labels (text displays)
var GAS_DEBUG_DATA_KEY = 'faetouched_gas_debug_box/' // server.persistentData key, followed by the dimension ID
var GAS_DEBUG_FLAGS = 2 // setBlock flags while building: send to clients, no neighbour updates
var GAS_DEBUG_SHELL = 'create:framed_glass' // walls, roof and fillers (the author's call, 2026-11-18: connected texture, easier to see through)
var GAS_DEBUG_FLOOR = 'minecraft:smooth_stone'
var GAS_DEBUG_DIVIDER = 'minecraft:red_stained_glass'
var GAS_DEBUG_WINDOW = ['minecraft:light', { level: '0' }] // block and state of the window in front of a divider
var GAS_DEBUG_OFFSET = 3 // blocks along +X from the caller to the rig
var GAS_DEBUG_GAP = 2 // blocks between two chambers in a row
var GAS_DEBUG_ROW_GAP = 2 // blocks between two rows (3 before spec 5; 2 keeps the full rig under GAS_DEBUG_MAX_CELLS)
// Blocks around the blasts section's chambers, along the row and to the next rows: the largest blast reach of the reaction table
// (gasDebugBlast; R2 at strength 8 reaches about 14), at least GAS_DEBUG_ROW_GAP.
var GAS_DEBUG_BLAST_GAP = gasDebugBlastGap()
var GAS_DEBUG_HEADROOM = 2 // blocks above the tallest chamber kept in the box, for the labels
var GAS_DEBUG_MAX_CELLS = 65536 // largest box one build may fill; a bigger request is refused with each section's size (the 17 gases and 40 rules with the fluid condensates: all is 230 chambers in 64 x 14 x 167 = 149,632 cells, refused; every gas <key> build fits, at most 63 x 11 x 53 = 36,729; the stub test)
var GAS_DEBUG_COLUMN = { w: 3, d: 3, part: 3 } // solo and permeable: interior 3x3, solo compartments 3 high
// Density: 1 wide, so the broken divider opens the whole column. In a wider column two gases that meet through one
// hole can only trade cells up and down the hole's column, and the cells beside it stay put (gas of one kind never
// moves sideways into another, and the flow search looks only along straight lines), so the layering never ends.
var GAS_DEBUG_DENSITY = { w: 1, d: 1, part: 3 }
var GAS_DEBUG_PERM_PART = 2 // permeable: height of the gas and the empty compartments
var GAS_DEBUG_SETTLE_LAYERS = 7 // layers per cell of a gas that settles (gasDebugGasLayers): one short of full
// Permeable blocks: [block, state properties, thicknesses]; each is built for the first rising and the first sinking
// gas in the table. Gas passes any thickness (spec 5), so every chamber should end with all its gas past the blocks.
// Scaffolding is left out (it can fall).
var GAS_DEBUG_PERMEABLE = [
  ['minecraft:oak_leaves', { persistent: 'true' }, [1, 2, 5]],
  ['minecraft:oak_fence', {}, [1]],
  ['minecraft:iron_bars', {}, [1]],
  ['minecraft:chain', {}, [1]],
  ['minecraft:glass_pane', {}, [1]]
]
// Test partners by rule id (needed for rules whose partner is a tag): { block: id, state: {...}, floor: id } (floor
// replaces the floor block under the partner), { fluid: id } (a source block) or { gas: key, layers: n } (default 8).
// gasCells (default 1): cells of the reacting gas, stacked in a column under (rising) or over (sinking) the divider.
// R1 gets two cells, so its condensate makes one full cell, which settles into water. R5's partner holds 1 layer,
// so the gradual souring has room to fire (7 times, leaving 1 glimmermist layer when the miasma cell is full).
// Rules with a condition partner: R6 and R23 (ultrawarm) get no chamber, since the rig can't fake a dimension. The
// condition rules of quest-gas slice 4 (R34 to R36, R38) get a condition chamber (gasDebugCondition): the conditions
// are the place or time the rig stands in, named in the legend (GAS_DEBUG_SITES); a rule with a condition missing from
// that table has no chamber and is skipped, and said so only when asked for by name.
// Quest-gas slice 2: an open flame is fire on netherrack, ice is plain ice, lava a lava source; R7's reek partner holds
// 1 layer as R5's miasma does; R37 (cooling) is tested on ice.
// Slice 3, block results: the block or fluid the rule changes stands where the gas reaches it after the divider breaks
// (the reaction layouts in gasDebugReaction): fire on netherrack (R29), a lit campfire (R30), wheat on farmland (R31),
// a water source (R8, R32), plain ice (R39). R33's condensate, held at 7 layers a cell, gets the pair layout
// (gasDebugReaction), whose two cells meet as one full cell beside the rime. note (optional) is added to the legend.
var GAS_DEBUG_FIRE = { block: 'minecraft:fire', floor: 'minecraft:netherrack' }
var GAS_DEBUG_TEST_PARTNERS = {
  condensation: { block: 'minecraft:ice', gasCells: 2 },
  ignition: GAS_DEBUG_FIRE,
  dissolving: { fluid: 'minecraft:water' },
  souring: { gas: 'bog_miasma', layers: 1 },
  souring_reek: { gas: 'reek', layers: 1 },
  moonwater_ice: { block: 'minecraft:ice' },
  quicksilver_ice: { block: 'minecraft:ice' },
  thaw: GAS_DEBUG_FIRE,
  afterdamp: GAS_DEBUG_FIRE,
  burn_off: GAS_DEBUG_FIRE,
  quenching_wind: { fluid: 'minecraft:lava' },
  flash_boil: { fluid: 'minecraft:lava' },
  cooling: { block: 'minecraft:ice' },
  scorching: GAS_DEBUG_FIRE,
  vitriol_scrub: { fluid: 'minecraft:water', note: 'the water should become a vitriol source and the reek go' },
  smothering: { block: 'minecraft:fire', floor: 'minecraft:netherrack', note: 'the fire should go out; the carbon dioxide stays' },
  snuffing: { block: 'minecraft:campfire', state: { lit: 'true' }, note: 'the campfire should go out (lit false); the carbon dioxide stays' },
  fertilizing: { block: 'minecraft:wheat', floor: 'minecraft:farmland', note: 'the wheat should grow faster than wheat outside, to full height; it grows only in light 9 or more (daylight or a light source)' },
  freezing: { fluid: 'minecraft:water', note: 'the water should freeze into ice; 6 layers of rime stay' },
  ice_formation: { gas: 'rime', note: 'the full cell freezes into ice; 6 layers of condensate and 7 of rime stay' },
  ice_melt: { block: 'minecraft:ice', note: 'the ice should melt into a water source, and the water cool the rest of the steam' },
  // Condition rules (slice 4): no partner, only a note for the legend (gasDebugCondition).
  sublimation: { note: 'the rime should lose a layer to steam now and then (2% a check, about 25 s a layer)' },
  fading: { note: 'the glimmermist should fade away layer by layer (20% a check); under a stained glass roof, or at night, it should not' },
  thunder_flash: { note: 'the firedamp should flash now and then (2% a check) and leave carbon dioxide; under a glass roof, or in dry weather, it should not' },
  slow_cooling: { note: 'the scalding steam should cool into steam within a few seconds (5% a check); never in the Nether' }
}
// What each condition asks of the place or the time the rig stands in (legend text). A condition chamber is a column of
// two gas cells under a red concrete divider (concrete, not stained glass, which shades the sky) with one air cell past
// the divider, so the gas keeps its sky and sheltered roof while the divider stands; storm's roof is invisible light
// blocks (they hold gas and let rain through) instead of glass (which shelters).
var GAS_DEBUG_SITES = {
  always: 'no particular place or time',
  day: 'daylight (/time set day)',
  sky: 'open sky: build the rig outdoors with nothing above it (plain glass counts as open, stained glass does not)',
  storm: 'a thunderstorm (/weather thunder) with the rig outdoors where it rains: not a snow biome or a desert',
  warm: 'a warm biome (desert, savanna or badlands: base temperature 1.0 or more)',
  snowy: 'a snowy biome or cold high ground (cold enough to snow at the ice, height-adjusted: temperature under 0.15)'
}
var GAS_DEBUG_CONDITION_DIVIDER = 'minecraft:red_concrete'
var GAS_DEBUG_CONDITION_CELLS = 2 // gas cells in a condition chamber's column

// Signs (the author's request, 2026-11-20: prototypes/gases/specs/spec-rig-signs.md). Each chamber's floating label (a text
// display) is a short sign of three or four lines: what the chamber is, in plain words, with the rule id (`Argent + Reek (R20
// recombination)`); `Expect:` what should happen, built from the rule's data (its product and the fluid a settling product
// becomes, its block result, its effect, what each gas loses) or from the section; `Start:` how to start it (the legend's first
// clause, or what to do in the gear section); and `Warning:` the legend's warnings (a blast, a place or time the rig can't make,
// a chamber that can start by itself). Every builder sets c.sign = { what, expect, start, warn } through gasDebugSetSign; the
// chat reply keeps the label and the legend. Names are display names, never keys: a gas's `name` in the startup table, and a
// fluid's, block's, item's or effect's GAS_DEBUG_NAMES entry, else its ID's path in title case (faetouched:vermilion is
// Vermilion, as its displayName says; the stub test holds the names to the startup scripts and to vanilla's en_us.json), so a
// search for "vermilion" finds R20's chamber.
var GAS_DEBUG_SIGN_WIDTH = 200 // the text display's line_width in pixels (vanilla's default, set anyway), so long lines wrap
// The design's rule numbers, from the startup table's comments (R20 is recombination; the stub test compares the two).
var GAS_DEBUG_RULE_NUMBERS = {
  condensation: 1, ignition: 2, dissolving: 3, annihilation: 4, souring: 5, evaporation: 6, souring_reek: 7, vitriol_scrub: 8,
  moonwater_ice: 9, moonwater_rime: 10, quicksilver_ice: 11, quicksilver_rime: 12, thaw: 13, frost_condensation: 14, fouling: 15,
  afterdamp: 16, burn_off: 17, sweetening: 18, acid_mist: 19, recombination: 20, sublimate: 21, hepar: 22, thaw_ultrawarm: 23,
  bleaching: 24, grounding: 25, quenching_wind: 26, ventilation: 27, flash_boil: 28, smothering: 29, snuffing: 30, fertilizing: 31,
  freezing: 32, ice_formation: 33, sublimation: 34, fading: 35, thunder_flash: 36, cooling: 37, slow_cooling: 38, ice_melt: 39,
  scorching: 40
}
// Display names that aren't the ID's path in title case (vanilla's en_us.json, the startup scripts' displayName).
var GAS_DEBUG_NAMES = { 'minecraft:iron_block': 'Block of Iron', 'minecraft:wheat': 'Wheat Crops', 'faetouched:safety_lamp': "Sapper's Safety Lamp" }
// Expect lines for the rules whose generated text would mislead: R29's fire would be "cleared" (it goes out), R31's crop grows
// only in the light, and R37's chamber of ice melts first (R39 is tried before R37).
var GAS_DEBUG_EXPECT = {
  smothering: 'the Fire goes out; the Carbon Dioxide stays',
  fertilizing: 'the Wheat Crops grow faster than wheat outside, but only in light 9 or more (daylight or a torch)',
  cooling: 'the Ice melts into a Water source first (R39), and the Water cools the rest of the Scalding Steam into Steam'
}
// Conditions on the signs (the legends keep GAS_DEBUG_SITES): [a few words, what it needs].
var GAS_DEBUG_SIGN_SITES = {
  day: ['daylight', 'daylight (/time set day)'],
  sky: ['open sky', 'open sky (outdoors; plain glass is open)'],
  storm: ['a thunderstorm', 'a thunderstorm in the rain (/weather thunder)'],
  warm: ['a warm biome', 'a warm biome (desert, savanna, badlands)'],
  snowy: ['a snowy place', 'a snowy biome or cold high ground']
}

function gasDebugWords(path) { return String(path).split('_').map(w => w.length > 0 ? w.charAt(0).toUpperCase() + w.substring(1) : w).join(' ') }
// An ID's display name (a tag's # is dropped).
function gasDebugTitle(id) {
  var s = String(id)
  if (s.charAt(0) == '#') s = s.substring(1)
  if (GAS_DEBUG_NAMES[s] !== undefined) return GAS_DEBUG_NAMES[s]
  return gasDebugWords(s.substring(s.indexOf(':') + 1))
}
// A gas's display name: its `name` in the startup table, else its key in title case.
function gasDebugGasTitle(gi) {
  var n = gasField(gasList(global.faetouchedGases)[gi], 'name')
  return n !== undefined ? String(n) : gasDebugWords(GASES[gi].key)
}
function gasDebugPartTitle(part) { return part.gas >= 0 ? gasDebugGasTitle(part.gas) : gasDebugTitle(part.block != null ? part.block : part.fluid) }
function gasDebugLayers(n) { return n == 1 ? 'a layer' : n + ' layers' }
function gasDebugRuleName(id) { var n = GAS_DEBUG_RULE_NUMBERS[id]; return (n !== undefined ? 'R' + n + ' ' : '') + id }
function gasDebugFirstClause(legend) { return String(legend).split(';')[0] }
function gasDebugSign(what, expect, start) { return { what: what, expect: expect, start: start, warn: [] } }
// Sets c.sign from make(); a sign that fails to build (a table these helpers don't expect) is logged, and the label stands in.
function gasDebugSetSign(c, make) {
  try { c.sign = make() } catch (err) { console.warn('faetouched gases: no sign for the rig chamber ' + c.label + ' (' + err + '); its label stands in'); c.sign = null }
}
function gasDebugBlastSign(bl) {
  return (bl.breaks ? 'it explodes' : 'it flashes') + ' (strength up to ' + bl.power + (bl.fire ? ', with fire' : '') + ', about ' + bl.reach + ' blocks' + (bl.breaks ? '): test in creative, on cleared ground' : ', breaking nothing) and hurts anyone near')
}
// The places or times a list of conditions needs, as a warning, or null for none ('always').
function gasDebugSignNeeds(conditions) {
  var needs = conditions.filter(cn => cn != 'always').map(cn => GAS_DEBUG_SIGN_SITES[cn] !== undefined ? GAS_DEBUG_SIGN_SITES[cn][1] : cn)
  return needs.length > 0 ? 'needs ' + needs.join(' and ') + ': the rig can\'t make that, so build it there' : null
}
// What a rule's chamber should show, in plain words, from the rule: its product (and the fluid a settling product becomes), its
// block result, its effect and what each gas loses. P is the partner's name (null for a condition rule).
function gasDebugExpect(r, P) {
  if (GAS_DEBUG_EXPECT[r.id] !== undefined) return GAS_DEBUG_EXPECT[r.id]
  var G = 'the ' + gasDebugGasTitle(r.gas)
  var bl = gasDebugBlast(r)
  var whole = r.consume == 'all' || r.consume >= 8
  var each = whole || !(r.consume >= 1) ? '' : ', ' + gasDebugLayers(r.consume) + ' at a time'
  var other = P != null && r.consumeOther > 0 ? '; the ' + P + ' loses ' + gasDebugLayers(r.consumeOther) : ''
  var k = r.k1
  var out
  if (k != null) {
    if (k.kind == 'block' && k.at == 'self') out = G + ' becomes ' + gasDebugTitle(k.id)
    else if (k.kind == 'block') out = 'the ' + P + (k.id == 'minecraft:air' ? ' is cleared' : ' becomes ' + gasDebugTitle(k.id))
    else if (k.kind == 'fluid') out = 'the ' + P + ' becomes a ' + gasDebugTitle(k.id) + ' source'
    else if (k.kind == 'state') out = Object.keys(k.props).map(n => k.props[n] == 'false' ? 'the ' + P + ' stops being ' + n : (k.props[n] == 'true' ? 'the ' + P + ' becomes ' + n : 'the ' + P + '\'s ' + n + ' becomes ' + k.props[n])).join(', ')
    else out = 'the ' + P + ' gets extra random ticks'
    if (k.at != 'self') out += '; ' + G + (r.consume === 0 ? ' stays' : (whole ? ' is used up' : ' loses ' + gasDebugLayers(r.consume)))
  } else if (r.resultGas >= 0) {
    out = G + (bl != null ? (bl.breaks ? ' explodes and' : ' flashes and') : '') + ' turns to ' + gasDebugGasTitle(r.resultGas)
    if (r.resultRatio != null && r.resultRatio != 1) out += r.resultRatio < 1 ? ', 1 layer for every ' + Math.round(1 / r.resultRatio) : ', ' + r.resultRatio + ' layers for each'
    out += each
    var st = GASES[r.resultGas].settle
    if (st != null) out += ', which settles into a ' + gasDebugTitle(st.fluid) + ' source'
  } else if (r.resultFluid != null) out = G + ' becomes a ' + gasDebugTitle(r.resultFluid) + ' source'
  else if (bl != null) out = G + (bl.breaks ? ' explodes' : ' flashes, breaking nothing')
  else if (other != '' && r.consume == r.consumeOther) { out = G + ' and the ' + P + ' each lose ' + gasDebugLayers(r.consume); other = '' }
  else out = G + ' is used up' + each
  if (r.effect != null && r.effect.type == 'particles') out += ', with ' + gasDebugTitle(r.effect.particle).toLowerCase() + ' particles'
  return out + other
}
// The effects a gas gives, by name ('damage' for a damage entry).
function gasDebugEffectNames(gi) {
  return gasList(gasField(gasList(global.faetouchedGases)[gi], 'effects')).map(ef => gasField(ef, 'damage') !== undefined ? 'damage' : gasDebugTitle(gasField(ef, 'id')))
}
function gasDebugMaskSign(item, gi) {
  var I = gasDebugTitle(item)
  var ef = gasDebugEffectNames(gi)
  return gasDebugSign(gasDebugGasTitle(gi) + ' room for the ' + I, 'walk in wearing the ' + I + ': no ' + (ef.length > 0 ? ef.join(' or ') : 'effects') + '; without it you get ' + (ef.length > 1 ? 'them' : (ef.length > 0 ? 'it' : 'none either')), '/give yourself the ' + I + ', wear it in a Curios head slot and walk in through the doorway')
}
// A detector's signal as the sign words it ('burns blue', 'gutters, with smoke').
function gasDebugSignalText(signal) { return signal == 'blue' ? 'burns blue' : (signal == 'gutter' ? 'gutters, with smoke' : 'signals ' + signal) }
// d: the detector (GAS_DETECTOR_LIST). A detector that signals several gases names the others' signals (the lamp: blue in
// firedamp, it gutters in carbon dioxide), so the sign never says it shows nothing in a gas it does signal.
function gasDebugDetectorSign(d, gi) {
  var I = gasDebugTitle(d.item)
  var others = []
  for (var o = 0; o < d.signals.length; o++) {
    if (o != gi && d.signals[o] != null) others.push('in ' + gasDebugGasTitle(o) + ' it ' + gasDebugSignalText(d.signals[o]))
  }
  return gasDebugSign(gasDebugGasTitle(gi) + ' room for the ' + I, 'held, within a second the ' + I + ' ' + gasDebugSignalText(d.signals[gi]) + '; ' + (others.length > 0 ? others.join(', ') + ', and in any other gas it shows nothing' : 'in another gas it shows nothing'), '/give yourself the ' + I + ', hold it and walk in through the doorway')
}
function gasDebugDamageSign(gi) {
  var hits = gasList(gasField(gasList(global.faetouchedGases)[gi], 'effects')).filter(ef => gasField(ef, 'damage') !== undefined).map(ef => Number(gasField(ef, 'amount')) + ' damage at most every ' + (gasField(ef, 'every') !== undefined ? Number(gasField(ef, 'every')) : 10) + ' ticks')
  var s = gasDebugSign(gasDebugGasTitle(gi) + ' room (damage)', 'standing in it hurts: ' + hits.join(', '), 'walk in through the invisible doorway')
  s.warn.push('the gas is dormant until a random tick wakes it, within about a minute; then it may cool or change')
  return s
}
// A chamber's sign as lines (its label when it has none).
function gasDebugSignLines(c) {
  var s = c.sign
  if (s == null) return [String(c.label)]
  var lines = [String(s.what), 'Expect: ' + s.expect, 'Start: ' + s.start]
  if (s.warn.length > 0) lines.push('Warning: ' + s.warn.join('; '))
  return lines
}
// The sign's lines as the summon command's NBT text: a JSON string (the text component) inside a single-quoted SNBT string. Each
// line keeps printable ASCII only (anything else becomes ?, so no line can carry a line break or a formatting code). JSON escapes
// the backslash and the double quote, and joins the lines with its \n; then SNBT escapes the backslash and the single quote, the
// only two escapes a quoted string takes in 1.21.1 (TagParser reads quoted values with brigadier 1.3.10's
// StringReader.readStringUntil, which throws on any other backslash pair), so JSON's \n reaches SNBT as \\n. Rhino's
// JSON.stringify can't do the first step: it doesn't escape backslashes or control characters.
function gasDebugSignNbt(lines) {
  var bs = String.fromCharCode(92)
  var json = '"' + lines.map(l => String(l).replace(/[^ -~]/g, '?').split(bs).join(bs + bs).split('"').join(bs + '"')).join(bs + 'n') + '"'
  return "'" + json.split(bs).join(bs + bs).split("'").join(bs + "'") + "'"
}

function gasDebugChamber(section, label, legend, w, h, d) {
  return { section: section, label: label, legend: legend, w: w, h: h, d: d, blocks: [], gases: [], gapAfter: GAS_DEBUG_GAP, divider: null, blast: null, roof: null, selfStarting: false, ox: 0, oy: 0, oz: 0 }
}
function gasDebugBlock(c, x, y, z, spec) { c.blocks.push({ x: x, y: y, z: z, spec: spec }) }
function gasDebugSpec(id, props) { return { id: id, props: props || null, fluid: null } }
// Fills whole layers y0..y0+n-1 (all x and z) with gas index gi, full. A gas that settles (condensate) would turn
// into its fluid as soon as a random tick woke a full, still cell, before the divider breaks, so it gets only the
// row resting on its floor (the lowest row for a sinking gas, the highest for a rising one), one layer short of
// full: a stable sheet that never settles until the divider goes.
function gasDebugGasLayers(c, y0, n, gi) {
  var settles = GASES[gi].settle != null
  for (var y = y0; y < y0 + n; y++) {
    if (settles && y != (GASES[gi].dir > 0 ? y0 + n - 1 : y0)) continue
    for (var x = 0; x < c.w; x++) {
      for (var z = 0; z < c.d; z++) c.gases.push({ x: x, y: y, z: z, gi: gi, L: settles ? GAS_DEBUG_SETTLE_LAYERS : 8 })
    }
  }
}
function gasDebugBlockLayers(c, y0, n, spec) {
  for (var y = y0; y < y0 + n; y++) {
    for (var x = 0; x < c.w; x++) {
      for (var z = 0; z < c.d; z++) gasDebugBlock(c, x, y, z, spec)
    }
  }
}
// A divider layer at y, with the window in front of its middle front block (the one to break).
function gasDebugDividerLayer(c, y) {
  gasDebugBlockLayers(c, y, 1, gasDebugSpec(GAS_DEBUG_DIVIDER))
  var mx = Math.floor(c.w / 2)
  gasDebugBlock(c, mx, y, -1, gasDebugSpec(GAS_DEBUG_WINDOW[0], GAS_DEBUG_WINDOW[1]))
  c.divider = { x: mx, y: y, z: 0 }
}

function gasDebugSolo(g) {
  var C = GAS_DEBUG_COLUMN
  var c = gasDebugChamber('solo', g.key + ': solo', 'break the divider through the gap; ' + g.key + (g.dir > 0 ? ' rises' : ' sinks') + ' through the hole and settles', C.w, 2 * C.part + 1, C.d)
  gasDebugSetSign(c, () => gasDebugSign(gasDebugGasTitle(g.index) + ' on its own (solo)', 'the ' + gasDebugGasTitle(g.index) + (g.dir > 0 ? ' rises' : ' sinks') + ' through the hole into the empty compartment' + (g.settle != null ? '; full cells there may settle into ' + gasDebugTitle(g.settle.fluid) + ' sources' : ''), gasDebugFirstClause(c.legend)))
  gasDebugGasLayers(c, g.dir > 0 ? 0 : C.part + 1, C.part, g.index)
  gasDebugDividerLayer(c, C.part)
  return c
}

// The id of a rule in which one of two gases reacts with the other, or null: for the signs. gasDebugReactsWith, which the legends
// use, also answers for two partner gases of a third (steam and scalding steam, R19's partners), which don't react together.
function gasDebugPairRule(a, b) {
  var list = GAS_RULES[a.index]
  for (var e = 0; e < list.length; e++) {
    var r = list[e].rule
    if (r.gas == b.index || (r.gas == a.index && r.partners.some(p => p.kind == 'gas' && p.gas == b.index))) return r.id
  }
  return null
}

// The id of a rule between two gases, or null.
function gasDebugReactsWith(a, b) {
  var list = GAS_RULES[a.index]
  for (var e = 0; e < list.length; e++) {
    var r = list[e].rule
    if (r.gas == b.index || r.partners.some(p => p.kind == 'gas' && p.gas == b.index)) return r.id
  }
  return null
}

// Side by side (the author's request, 2026-11-19): two gases in compartments 3 long, 3 deep and 2 high, a divider wall
// between them, so the side-to-side interaction can be watched: the denser gas runs under the lighter one. One
// chamber per pair of gases next to each other in density order. A settling gas fills only its floor row, one layer
// short of full, as in the other chambers.
function gasDebugSide(a, b) {
  var M = GAS_DEBUG_SIDE
  var lo = a.density <= b.density ? a : b
  var hi = lo === a ? b : a
  var c = gasDebugChamber('side', a.key + ' / ' + b.key + ': side by side', 'break the divider through the gap; ' + hi.key + ' (denser) should run under ' + lo.key + ' and end below it', 2 * M.len + 1, M.h, M.w)
  // A pair that reacts says so, by rule number, as the density signs do (zephyr + firedamp R27, glimmermist + bog miasma R5).
  var pair = gasDebugPairRule(a, b)
  gasDebugSetSign(c, () => gasDebugSign(gasDebugGasTitle(a.index) + ' / ' + gasDebugGasTitle(b.index) + ' (side by side)', 'the denser ' + gasDebugGasTitle(hi.index) + ' runs under the ' + gasDebugGasTitle(lo.index) + ' and ends below it' + (pair != null ? '; they may also react (' + gasDebugRuleName(pair) + ')' : ''), gasDebugFirstClause(c.legend)))
  var fill = function (g, x, y, z) {
    var settles = g.settle != null
    if (settles && y != (g.dir > 0 ? M.h - 1 : 0)) return
    c.gases.push({ x: x, y: y, z: z, gi: g.index, L: settles ? GAS_DEBUG_SETTLE_LAYERS : 8 })
  }
  for (var x = 0; x < c.w; x++) {
    for (var y = 0; y < c.h; y++) {
      for (var z = 0; z < c.d; z++) {
        if (x < M.len) fill(a, x, y, z)
        else if (x > M.len) fill(b, x, y, z)
        else gasDebugBlock(c, x, y, z, gasDebugSpec(GAS_DEBUG_DIVIDER))
      }
    }
  }
  gasDebugBlock(c, M.len, 0, -1, gasDebugSpec(GAS_DEBUG_WINDOW[0], GAS_DEBUG_WINDOW[1]))
  c.divider = { x: M.len, y: 0, z: 0 }
  return c
}

// The lighter gas (lower density) below, the heavier above.
function gasDebugDensity(a, b) {
  var C = GAS_DEBUG_DENSITY
  var lo = a.density <= b.density ? a : b
  var hi = lo === a ? b : a
  var rid = gasDebugReactsWith(a, b)
  var c = gasDebugChamber('density', a.key + ' / ' + b.key + ': density', 'break the divider through the gap; ' + lo.key + ' (lighter) should end on top' + (rid != null ? '; they may also react (' + rid + ') while they touch' : ''), C.w, 2 * C.part + 1, C.d)
  var pair = gasDebugPairRule(a, b)
  gasDebugSetSign(c, () => gasDebugSign(gasDebugGasTitle(a.index) + ' / ' + gasDebugGasTitle(b.index) + ' (density)', 'the lighter gas (' + gasDebugGasTitle(lo.index) + ') ends on top' + (pair != null ? '; they may also react (' + gasDebugRuleName(pair) + ')' : ''), gasDebugFirstClause(c.legend)))
  gasDebugGasLayers(c, 0, C.part, lo.index)
  gasDebugGasLayers(c, C.part + 1, C.part, hi.index)
  gasDebugDividerLayer(c, C.part)
  return c
}

// The rules of the reaction table that loaded, in table order, each with its raw table entry (for `test`).
function gasDebugRules() {
  var out = []
  var table = gasList(global.faetouchedGasReactions)
  for (var n = 0; n < table.length; n++) {
    var id = String(gasField(table[n], 'id'))
    var gi = gasIndexOf(String(gasField(table[n], 'gas')))
    if (gi < 0) continue
    var list = GAS_RULES[gi]
    for (var e = 0; e < list.length; e++) {
      if (!list[e].asOther && list[e].rule.id == id) { out.push({ rule: list[e].rule, raw: table[n] }); break }
    }
  }
  return out
}

// A rule's test partner: { gas, block, props, fluid, floor, name, layers, gasCells }, or null when its partner is a
// tag and no test partner is known. A `test` field on the rule wins over GAS_DEBUG_TEST_PARTNERS; otherwise the
// first partner.
function gasDebugPartner(r, raw) {
  var test = gasField(raw, 'test')
  if (test === undefined) test = GAS_DEBUG_TEST_PARTNERS[r.id]
  var out = { gas: -1, block: null, props: {}, fluid: null, floor: null, name: '', layers: 8, gasCells: 1, note: null }
  if (test !== undefined && test !== null) {
    var tn = gasField(test, 'note')
    if (tn !== undefined) out.note = String(tn)
    var tg = gasField(test, 'gas')
    var tb = gasField(test, 'block')
    var tf = gasField(test, 'fluid')
    var ts = gasField(test, 'state')
    gasKeys(ts).forEach(k => { out.props[k] = String(gasField(ts, k)) })
    var tly = gasField(test, 'layers')
    if (tly !== undefined) out.layers = Math.max(1, Math.min(8, Number(tly)))
    var tgc = gasField(test, 'gasCells')
    if (tgc !== undefined) out.gasCells = Math.max(1, Math.floor(Number(tgc)))
    var tfl = gasField(test, 'floor')
    if (tfl !== undefined) out.floor = String(tfl)
    if (tg !== undefined) out.gas = gasIndexOf(String(tg))
    else if (tb !== undefined) out.block = String(tb)
    else if (tf !== undefined) out.fluid = String(tf)
    if (out.gas < 0 && out.block == null && out.fluid == null) return null
  } else {
    var p = r.partners.length > 0 ? r.partners[0] : null
    if (p == null || p.tag != null) return null
    if (p.kind == 'gas') out.gas = p.gas
    else if (p.kind == 'block') { out.block = p.id; out.props = p.state }
    else out.fluid = p.id
  }
  out.name = out.gas >= 0 ? GASES[out.gas].key : (out.block != null ? out.block : out.fluid)
  return out
}

// Puts a partner into chamber c at (x, y, z): a gas cell, a block or a fluid source, and its floor block.
function gasDebugPartnerAt(c, part, x, y, z) {
  if (part.floor != null) gasDebugBlock(c, x, y - 1, z, gasDebugSpec(part.floor))
  if (part.gas >= 0) c.gases.push({ x: x, y: y, z: z, gi: part.gas, L: part.layers })
  else if (part.block != null) gasDebugBlock(c, x, y, z, gasDebugSpec(part.block, part.props))
  else gasDebugBlock(c, x, y, z, { id: null, props: null, fluid: part.fluid })
}

// A rule that explodes: { power, fire, reach }, else null. Reach: vanilla explosion rays start at up to 1.3 times the
// strength and lose 0.225 per 0.3-block step through air, so strength 8 breaks blocks up to about 14 blocks away.
function gasDebugBlast(r) {
  if (r.effect == null || r.effect.type != 'explode') return null
  return { power: r.effect.maxPower, fire: r.effect.fire, breaks: String(r.effect.mode).toLowerCase() != 'none', reach: Math.round(r.effect.maxPower * 1.3 / 0.75) }
}
// The gap around reaction chambers: the largest blast reach in the reaction table, at least GAS_DEBUG_ROW_GAP.
function gasDebugBlastGap() {
  var gap = GAS_DEBUG_ROW_GAP
  for (var i = 0; i < GAS_RULES.length; i++) {
    for (var e = 0; e < GAS_RULES[i].length; e++) {
      var bl = gasDebugBlast(GAS_RULES[i][e].rule)
      if (bl != null) gap = Math.max(gap, bl.reach)
    }
  }
  return gap
}
// A blast with mode 'none' (R16's flash) breaks no blocks and sets no fire, so it only warns about the damage.
function gasDebugBlastText(bl) {
  if (!bl.breaks) return 'it flashes (strength up to ' + bl.power + (bl.fire ? ', with fire' : '') + ', reaching about ' + bl.reach + ' blocks, breaking nothing): it hurts anyone that close'
  return 'it explodes (strength up to ' + bl.power + (bl.fire ? ', with fire' : '') + ', reaching about ' + bl.reach + ' blocks, into the ground under the rig and outside its box, which clear does not restore): test in creative, on cleared ground'
}

// A single divider block at (x, y) on the front row (z 0), with the window in front of it.
function gasDebugDividerAt(c, x, y, block) {
  gasDebugBlock(c, x, y, 0, gasDebugSpec(block || GAS_DEBUG_DIVIDER))
  gasDebugBlock(c, x, y, -1, gasDebugSpec(GAS_DEBUG_WINDOW[0], GAS_DEBUG_WINDOW[1]))
  c.divider = { x: x, y: y, z: 0 }
}

// A reaction chamber (spec 4): the gas G (full) and its partner P meet only across an edge, which no reaction (face
// neighbours only) or move (a diagonal needs a passable side cell) crosses, until the divider D goes. n is the test
// partner's gasCells (default 1): G is a column of n cells.
//   Rising gas, inside 2 wide x (n + 1) high x 1 deep: G at (0,0) to (0,n-1), D above them, P at (1,n) beside D,
//   standing on its floor block (or shell glass) at (1,n-1); every other cell of column 1 is shell glass. R1 (n 2):
//   each steam cell rises in turn into D's cell beside the ice and becomes 4 layers of condensate, which sinks
//   through the steam by density swap; the halves meet as one full cell at the bottom, which settles into water.
//   With (1,0) left as air the condensate would split 4 and 4 and never settle (the analyst's check, spec 5).
//   Sinking gas, mirrored: D at (0,0), G at (0,1) to (0,n), P at (1,0), shell glass above P.
//   A gas held one short of full whose rule needs a full cell (slice 3, R33): the pair layout, in the code below.
//   Sinking gas with a fluid partner (R3), one column 1 x (n + 2) x 1: the fluid source at the bottom, D, then G on
//   top, since a fluid never flows up into D's cell.
//   Rising gas with a fluid partner (quest-gas slice 2, R26), inside 2 x (n + 2) x 1: as the rising layout, the fluid
//   source at (1,n) on shell glass with shell glass above it at (1,n+1), and an air cell at (0,n+1) above D. Lava
//   never flows up, and the product (steam) rises out of D's cell into that air, so the lava can flow into D's
//   emptied cell and down the gas's column only after the gas has left it.
// Breaking D: the G cell next to it moves all its layers into D's cell (8, so R1's threshold is met), beside P.
// A gas that settles (condensate, R28) gets GAS_DEBUG_SETTLE_LAYERS a cell, so a full cell can't turn to water first.
// The label names a rule's other partner gases too (R19: steam or scalding steam), so every gas a chamber is built for
// appears in it.
function gasDebugReaction(r, part) {
  var g = GASES[r.gas]
  var blast = gasDebugBlast(r)
  var others = r.partners.filter(p => p.kind == 'gas' && p.gas != part.gas).map(p => GASES[p.gas].key)
  var label = r.id + ': ' + g.key + ' + ' + part.name + (others.length > 0 ? ' (or ' + others.join(', ') + ')' : '')
  var legend = 'break the red glass divider through the gap' + (blast != null ? '; ' + gasDebugBlastText(blast) : '')
  var shell = gasDebugSpec(GAS_DEBUG_SHELL)
  var n = part.gasCells || 1
  var gL = g.settle != null ? GAS_DEBUG_SETTLE_LAYERS : 8
  var c, y
  if (part.fluid == null && gL < r.minLayers) {
    // The pair layout (slice 3, R33): the gas is held one short of full (a settling gas), but the rule needs a full
    // cell. Two short cells stand side by side, where neither can move into the other, and meet only after the divider
    // breaks: one falls (rises) into the divider's cell beside the partner, the other tops it up diagonally.
    //   Sinking, inside 3 x 2 x 1: gas at (0,1) and (1,1), glass at (2,1); glass at (0,0), the divider at (1,0), the
    //   partner at (2,0) (on its floor block, if any). Rising, mirrored: gas at (0,0) and (1,0), glass at (2,0) unless
    //   the partner's floor goes there; glass at (0,1), the divider at (1,1), the partner at (2,1).
    c = gasDebugChamber('reactions', label, legend, 3, 2, 1)
    var gy = g.dir < 0 ? 1 : 0
    var dy = 1 - gy
    c.gases.push({ x: 0, y: gy, z: 0, gi: r.gas, L: gL })
    c.gases.push({ x: 1, y: gy, z: 0, gi: r.gas, L: gL })
    if (!(part.floor != null && gy == 0)) gasDebugBlock(c, 2, gy, 0, shell)
    gasDebugBlock(c, 0, dy, 0, shell)
    gasDebugDividerAt(c, 1, dy)
    gasDebugPartnerAt(c, part, 2, dy, 0)
    c.legend += '; two cells of ' + g.key + ', each one layer short of full, meet as one full cell beside the ' + part.name
  } else if (part.fluid != null && g.dir < 0) {
    c = gasDebugChamber('reactions', label, legend, 1, n + 2, 1)
    gasDebugPartnerAt(c, part, 0, 0, 0)
    gasDebugDividerAt(c, 0, 1)
    for (y = 2; y < n + 2; y++) c.gases.push({ x: 0, y: y, z: 0, gi: r.gas, L: gL })
  } else if (part.fluid != null) {
    c = gasDebugChamber('reactions', label, legend, 2, n + 2, 1)
    for (y = 0; y < n; y++) c.gases.push({ x: 0, y: y, z: 0, gi: r.gas, L: gL })
    gasDebugDividerAt(c, 0, n)
    for (y = 0; y < n; y++) gasDebugBlock(c, 1, y, 0, shell)
    gasDebugPartnerAt(c, part, 1, n, 0)
    gasDebugBlock(c, 1, n + 1, 0, shell)
  } else if (g.dir > 0) {
    c = gasDebugChamber('reactions', label, legend, 2, n + 1, 1)
    for (y = 0; y < n; y++) c.gases.push({ x: 0, y: y, z: 0, gi: r.gas, L: gL })
    gasDebugDividerAt(c, 0, n)
    for (y = 0; y < n; y++) if (!(part.floor != null && y == n - 1)) gasDebugBlock(c, 1, y, 0, shell)
    gasDebugPartnerAt(c, part, 1, n, 0)
  } else {
    c = gasDebugChamber('reactions', label, legend, 2, n + 1, 1)
    for (y = 1; y <= n; y++) c.gases.push({ x: 0, y: y, z: 0, gi: r.gas, L: gL })
    gasDebugDividerAt(c, 0, 0)
    gasDebugPartnerAt(c, part, 1, 0, 0)
    for (y = 1; y <= n; y++) gasDebugBlock(c, 1, y, 0, shell)
  }
  if (n > 1) c.legend += '; the ' + n + ' cells of ' + g.key + ' reach the ' + part.name + ' one after another'
  if (part.note != null) c.legend += '; ' + part.note
  // The sign names the rule's other partner gases too (R19: Reek + Steam or Scalding Steam).
  gasDebugSetSign(c, () => {
    var P = gasDebugPartTitle(part)
    var all = [P].concat(r.partners.filter(p => p.kind == 'gas' && p.gas != part.gas).map(p => gasDebugGasTitle(p.gas)))
    var names = all.length > 1 ? all.slice(0, -1).join(', ') + ' or ' + all[all.length - 1] : P
    var sign = gasDebugSign(gasDebugGasTitle(r.gas) + ' + ' + names + ' (' + gasDebugRuleName(r.id) + ')', gasDebugExpect(r, P), gasDebugFirstClause(c.legend))
    if (blast != null) sign.warn.push(gasDebugBlastSign(blast))
    return sign
  })
  c.blast = blast
  // An explosive chamber goes in the blasts section, with the blast gap after it.
  if (blast != null) { c.section = 'blasts'; c.gapAfter = GAS_DEBUG_BLAST_GAP }
  return c
}

// The chain chamber, inside 4 wide x 2 high x 3 deep: the gas fills a 3x3 pocket at y 0 (x 1..3); the partner sits at
// (0,1,0) on its floor block at (0,0,0); D at (1,1,0), above the pocket's corner cell and beside the partner; every
// other cell is shell glass, so the woken pocket can't spread anywhere. Breaking D: the cell under it rises into D's
// cell, touches the partner and goes off, and the blast primes the rest (expect 1 + 8 ignitions). Only for a rising
// gas with a block partner; null otherwise (the plan warns).
function gasDebugChain(r, part) {
  var g = GASES[r.gas]
  if (g.dir <= 0 || part.block == null) return null
  var blast = gasDebugBlast(r)
  // A flash (R16, at most 1.2) primes only the cells it reaches, and a thin cell's flash (the cell under the divider
  // refills with 2 or 3 layers) reaches none, so that pocket may stop short (the stub test: 2 flashes, then it stops).
  var expect = blast.breaks ? 'the whole pocket should go off, at most ' + GAS_IGNITIONS_PER_TICK + ' cells per tick' : 'each flash sets off the gas it reaches, at most ' + GAS_IGNITIONS_PER_TICK + ' cells per tick, but a thin cell\'s flash reaches nothing, so the pocket may stop short'
  var c = gasDebugChamber('blasts', r.id + ' chain: ' + g.key + ' + ' + part.name, 'break the red glass divider through the gap; ' + expect + '; each cell ' + gasDebugBlastText(blast).substring(3), 4, 2, 3)
  gasDebugSetSign(c, () => {
    var sign = gasDebugSign(gasDebugGasTitle(r.gas) + ' pocket + ' + gasDebugPartTitle(part) + ' (' + gasDebugRuleName(r.id) + ' chain)', blast.breaks ? 'the whole pocket goes off, at most ' + GAS_IGNITIONS_PER_TICK + ' cells a tick' : 'each flash sets off the gas it reaches, but a thin cell\'s flash reaches nothing, so the pocket may stop short', gasDebugFirstClause(c.legend))
    sign.warn.push(gasDebugBlastSign(blast))
    return sign
  })
  var shell = gasDebugSpec(GAS_DEBUG_SHELL)
  for (var x = 0; x < 4; x++) {
    for (var z = 0; z < 3; z++) {
      if (x >= 1) c.gases.push({ x: x, y: 0, z: z, gi: r.gas })
      else if (z > 0) gasDebugBlock(c, 0, 0, z, shell)
      if (z > 0 || x >= 2) gasDebugBlock(c, x, 1, z, shell)
    }
  }
  if (part.floor == null) gasDebugBlock(c, 0, 0, 0, shell)
  gasDebugPartnerAt(c, part, 0, 1, 0)
  gasDebugDividerAt(c, 1, 1)
  c.blast = blast
  c.gapAfter = GAS_DEBUG_BLAST_GAP
  return c
}

// A condition chamber (slice 4, K6) for a rule whose partners are all conditions the rig has a site text for
// (GAS_DEBUG_SITES): a column 1 x (n + 2) x 1 with n gas cells (GAS_DEBUG_CONDITION_CELLS) at one end, a red concrete
// divider and one air cell for the gas to move into. Rising gas: cells 0 to n - 1, D at n, air at n + 1 (the roof above).
// Sinking gas, mirrored: air at 0, D at 1, cells 2 to n + 1 (the floor below). The rig can't make the condition: the
// legend names the place or time to build and break it in. Its gas isn't dormant behind the divider where the rule needs
// no partner or the sky: a rule with the conditions true at the gas's own cells (warm, always) can start on a random tick
// (selfStarting). A storm chamber's roof is invisible light blocks, so rain reaches the cells and gas still can't leave.
// Returns null when the rule has no layout here (a condition without a site text, such as ultrawarm, or a partner).
function gasDebugCondition(r, raw) {
  if (!r.condOnly || r.conditions.some(cn => GAS_DEBUG_SITES[cn] === undefined)) return null
  var g = GASES[r.gas]
  var blast = gasDebugBlast(r)
  var n = GAS_DEBUG_CONDITION_CELLS
  var needs = r.conditions.filter(cn => cn != 'always').map(cn => GAS_DEBUG_SITES[cn])
  var test = gasField(raw, 'test')
  if (test === undefined) test = GAS_DEBUG_TEST_PARTNERS[r.id]
  var note = test !== undefined && test !== null ? gasField(test, 'note') : undefined
  var legend = 'break the red concrete divider through the gap; ' + (needs.length > 0 ? 'this rule needs ' + needs.join(' and ') + ', which the rig can\'t make: build and break it there' : 'this rule needs no particular place or time') + (r.skipUltraWarm ? ', and never fires in the Nether' : '')
  if (blast != null) legend += '; ' + gasDebugBlastText(blast)
  var c = gasDebugChamber('reactions', r.id + ': ' + g.key + ' + ' + (r.conditions.join(' and ')), legend, 1, n + 2, 1)
  var y
  if (g.dir > 0) {
    for (y = 0; y < n; y++) c.gases.push({ x: 0, y: y, z: 0, gi: r.gas, L: 8 })
    gasDebugDividerAt(c, 0, n, GAS_DEBUG_CONDITION_DIVIDER)
  } else {
    gasDebugDividerAt(c, 0, 1, GAS_DEBUG_CONDITION_DIVIDER)
    for (y = 2; y < n + 2; y++) c.gases.push({ x: 0, y: y, z: 0, gi: r.gas, L: 8 })
  }
  if (r.conditions.indexOf('storm') >= 0) {
    c.roof = gasDebugSpec(GAS_DEBUG_WINDOW[0], GAS_DEBUG_WINDOW[1])
    c.legend += '; its roof is invisible light blocks, which hold the gas and let the rain in'
  }
  // The gas behind a divider is shut away from a sky or weather condition only if it sits under the divider (rising gas).
  c.selfStarting = g.dir < 0 || r.conditions.every(cn => cn == 'always' || cn == 'warm')
  if (c.selfStarting) c.legend += '; the divider doesn\'t keep the condition from this gas, so the rule can also start on a random tick (/gamerule randomTickSpeed 0 stops that)'
  if (note !== undefined) c.legend += '; ' + note
  gasDebugSetSign(c, () => {
    var names = r.conditions.filter(cn => cn != 'always').map(cn => GAS_DEBUG_SIGN_SITES[cn] !== undefined ? GAS_DEBUG_SIGN_SITES[cn][0] : cn)
    var sign = gasDebugSign(gasDebugGasTitle(r.gas) + (names.length > 0 ? ' + ' + names.join(' and ') : ' alone') + ' (' + gasDebugRuleName(r.id) + ')', gasDebugExpect(r, null), gasDebugFirstClause(c.legend))
    var needs = gasDebugSignNeeds(r.conditions)
    if (needs != null) sign.warn.push(needs)
    if (r.skipUltraWarm) sign.warn.push('never in the Nether')
    if (c.selfStarting) sign.warn.push('it may start by itself (/gamerule randomTickSpeed 0 stops that)')
    if (blast != null) sign.warn.push(gasDebugBlastSign(blast))
    return sign
  })
  c.blast = blast
  if (blast != null) { c.section = 'blasts'; c.gapAfter = GAS_DEBUG_BLAST_GAP }
  c.divider.block = GAS_DEBUG_CONDITION_DIVIDER
  return c
}

// A permeable chamber: gas compartment, divider, k layers of the block, empty compartment (mirrored for sinking).
function gasDebugPermeable(entry, g, k) {
  var C = GAS_DEBUG_COLUMN
  var P = GAS_DEBUG_PERM_PART
  var c = gasDebugChamber('permeable', g.key + ': ' + entry[0] + ' x' + k, 'break the divider through the gap; ' + g.key + ' should pass through all ' + k + ' and end in the far compartment', C.w, 2 * P + 1 + k, C.d)
  gasDebugSetSign(c, () => gasDebugSign(gasDebugGasTitle(g.index) + ' through ' + gasDebugLayers(k) + ' of ' + gasDebugTitle(entry[0]) + ' (permeable)', 'all the ' + gasDebugGasTitle(g.index) + ' passes the ' + gasDebugTitle(entry[0]) + ' into the far compartment', gasDebugFirstClause(c.legend)))
  var spec = gasDebugSpec(entry[0], entry[1])
  if (g.dir > 0) {
    gasDebugGasLayers(c, 0, P, g.index)
    gasDebugDividerLayer(c, P)
    gasDebugBlockLayers(c, P + 1, k, spec)
  } else {
    gasDebugBlockLayers(c, P, k, spec)
    gasDebugDividerLayer(c, P + k)
    gasDebugGasLayers(c, P + k + 1, P, g.index)
  }
  return c
}

// The gas indexes a reaction's chambers involve: the reacting gas, every partner gas, and the test partner's gas.
function gasDebugRuleGases(r, part) {
  var out = [r.gas]
  r.partners.forEach(p => { if (p.kind == 'gas' && out.indexOf(p.gas) < 0) out.push(p.gas) })
  if (part != null && part.gas >= 0 && out.indexOf(part.gas) < 0) out.push(part.gas)
  return out
}

// --- The gear section (quest-gas slice 5): rooms for the mask, the lamp and the damage gases, and the K3 and K2 chambers ---
// Gear rooms hold a player: interior 3 x 3 x 3 full of one gas (8 layers in every cell, so it stays put), a doorway in the
// front wall made of the rig's window block (invisible, no collision, holds no gas), and no divider: there is nothing to
// start. Walk in with the item (/give), or without it.
//   mask rooms: one per gas a mask protects from (GAS_MASKS): the wearer takes none of its effects.
//   detector rooms: one per gas a detector signals (GAS_DETECTORS).
//   damage rooms: one per gas whose effects include damage (the scald).
// The K3 and K2 chambers are in this section too (they have no gas to start): an intake chamber is a collector with the ice
// against it (the legend names the biome it needs), a sensor chamber the registered block with a cell of its gas against each
// listed face, the other cells glass. No divider anywhere in the section.
var GAS_DEBUG_ROOM = { w: 3, h: 3, d: 3 }
// sign: a function that makes the room's sign (gasDebugMaskSign and the others).
function gasDebugRoom(label, legend, gi, sign) {
  var R = GAS_DEBUG_ROOM
  var c = gasDebugChamber('gear', label, legend, R.w, R.h, R.d)
  if (sign != null) gasDebugSetSign(c, sign)
  gasDebugGasLayers(c, 0, R.h, gi)
  var mx = Math.floor(R.w / 2)
  for (var y = 0; y < 2; y++) gasDebugBlock(c, mx, y, -1, gasDebugSpec(GAS_DEBUG_WINDOW[0], GAS_DEBUG_WINDOW[1]))
  c.legend += '; walk in through the invisible doorway in the front wall (the gas stays: the doorway is not air)'
  return c
}
function gasDebugGasName(gi) { return GASES[gi].key.split('_').join(' ') }

// The site texts of a list of condition names (legend text), without 'always'.
function gasDebugNeeds(conditions) { return conditions.filter(cn => cn != 'always').map(cn => GAS_DEBUG_SITES[cn] !== undefined ? GAS_DEBUG_SITES[cn] : cn) }

// An intake chamber (K3), inside 2 x 1 x 1: the collector at (0,0,0), the intake's block at (1,0,0), glass round them. Null
// for an intake whose block is a tag (no single block to place).
function gasDebugIntake(it) {
  if (it.part.tag != null) return null
  var needs = gasDebugNeeds(it.conditions)
  var c = gasDebugChamber('gear', it.id + ': collector + ' + it.part.id, 'no divider: the collector acts every ' + GAS_COLLECTOR_ACTION_TICKS + ' ticks from the start; its tank should gain a layer of ' + gasDebugGasName(it.gas) + ' about every ' + (it.every / 20) + ' s (read the tank with a Create pipe and tank, or /data get block on the collector)' + (needs.length > 0 ? '; it needs ' + needs.join(' and ') + ', which the rig can\'t make: build it there, and in a mild or warm biome the tank stays empty' : '') + '; the ice is not used up', 2, 1, 1)
  gasDebugBlock(c, 0, 0, 0, gasDebugSpec(gasId('gas_collector')))
  gasDebugBlock(c, 1, 0, 0, gasDebugSpec(it.part.id))
  gasDebugSetSign(c, () => {
    var B = gasDebugTitle(it.part.id)
    var sign = gasDebugSign(gasDebugTitle(gasId('gas_collector')) + ' + ' + B + ' (' + it.id + ' intake)', 'the collector\'s tank gains a layer of ' + gasDebugGasTitle(it.gas) + ' about every ' + (it.every / 20) + ' s; the ' + B + ' stays', 'nothing to break: it runs from the start (read the tank with /data get block)')
    var needs = gasDebugSignNeeds(it.conditions)
    if (needs != null) sign.warn.push(needs)
    return sign
  })
  return c
}

// A sensor chamber (K2), inside 3 x 3 x 3: the registered block in the middle, a cell of the sensor's first gas (8 layers)
// against each listed face, the rest glass.
function gasDebugSensor(s) {
  var c = gasDebugChamber('gear', 'sensor ' + s.id + ': ' + s.block + ' + ' + s.gases.map(gi => GASES[gi].key).join(' or '), 'no divider: the block reads its ' + s.faces.map(fi => ['up', 'down', 'north', 'east', 'south', 'west'][fi]).join(', ') + ' faces every ' + (s.every / 20) + ' s' + ' (' + s.minFaces + ' face(s) of at least ' + s.minLayers + ' layer(s) to be met' + (s.spend > 0 ? ', spending ' + s.spend + ' layer(s) of the gas it reads' : '') + (s.property != null ? '; it sets its property ' + s.property : '') + '); the reading is in the block entity data (' + GAS_SENSE_DATA + s.id + ') (/data get block)', 3, 3, 3)
  gasDebugSetSign(c, () => gasDebugSign(gasDebugTitle(s.block) + ' + ' + s.gases.map(gi => gasDebugGasTitle(gi)).join(' or ') + ' (sensor ' + s.id + ')', 'its reading is met (' + s.minFaces + ' face(s) with ' + s.minLayers + ' layer(s) or more' + (s.spend > 0 ? ', spending ' + gasDebugLayers(s.spend) : '') + ')' + (s.property != null ? ' and its ' + s.property + ' property turns true' : ''), 'nothing to break: it reads every ' + (s.every / 20) + ' s (/data get block)'))
  var shell = gasDebugSpec(GAS_DEBUG_SHELL)
  var wanted = {}
  s.faces.forEach(fi => { var st = GAS_ALL_STEPS[fi]; wanted[(1 + st[0]) + ',' + (1 + st[1]) + ',' + (1 + st[2])] = true })
  for (var x = 0; x < 3; x++) {
    for (var y = 0; y < 3; y++) {
      for (var z = 0; z < 3; z++) {
        var key = x + ',' + y + ',' + z
        if (x == 1 && y == 1 && z == 1) gasDebugBlock(c, x, y, z, gasDebugSpec(s.block))
        else if (wanted[key]) c.gases.push({ x: x, y: y, z: z, gi: s.gases[0], L: 8 })
        else gasDebugBlock(c, x, y, z, shell)
      }
    }
  }
  return c
}

// The gear section's chambers, from the tables. keep(gas indexes) and keepRule(id, gas indexes) are the plan's filters; a rule
// asked for by name (focusRule) builds only its own intake or sensor chamber (a warning in plan.warnings when it has none).
function gasDebugGear(keep, keepRule, focusRule, plan) {
  var out = []
  if (focusRule == null) {
    var masks = global.faetouchedGasMasks
    gasKeys(masks).forEach(item => {
      gasList(gasField(masks, item)).forEach(gk => {
        var gi = gasIndexOf(String(gk))
        if (gi < 0 || !keep([gi])) return
        out.push(gasDebugRoom('mask ' + item.split(':')[1] + ': ' + GASES[gi].key, 'a gas room for the mask: without ' + item + ' (give it with /give; it wears in a Curios head slot) the ' + gasDebugGasName(gi) + ' gives its effects; wearing it gives none (effects you already have run out)', gi, () => gasDebugMaskSign(item, gi)))
      })
    })
    GAS_DETECTOR_LIST.forEach(d => {
      for (var gi = 0; gi < GASES.length; gi++) {
        if (d.signals[gi] == null || !keep([gi])) continue
        out.push(gasDebugRoom('detector ' + d.item.split(':')[1] + ': ' + GASES[gi].key, 'a gas room for the detector: hold ' + d.item + ' (give it with /give), in either hand; within a second it signals ' + d.signals[gi] + ' (' + (d.signals[gi] == 'blue' ? 'its model turns blue' : d.signals[gi] == 'gutter' ? 'smoke, and the action bar says it gutters' : 'the action bar says so') + ') for ' + gasDebugGasName(gi) + ', and nothing in a gas it does not detect', gi, () => gasDebugDetectorSign(d, gi)))
      }
    })
    gasList(global.faetouchedGases).forEach((t, gi) => {
      if (!gasList(gasField(t, 'effects')).some(ef => gasField(ef, 'damage') !== undefined) || !keep([gi])) return
      out.push(gasDebugRoom('damage: ' + GASES[gi].key, 'a gas room for the damage effect: standing in the ' + gasDebugGasName(gi) + ' hurts (1 damage a hit, at most every 10 ticks; Fire Resistance stops it); the gas is dormant and cools or changes when something wakes it, as a random tick does within about a minute', gi, () => gasDebugDamageSign(gi)))
    })
  }
  GAS_INTAKE_LIST.forEach(it => {
    if (!keepRule(it.id, [it.gas])) return
    var c = gasDebugIntake(it)
    if (c == null) { if (focusRule != null && it.id == focusRule) plan.warnings.push('No chamber for intake ' + it.id + ': its block is a tag, so no single block can stand in the rig'); return }
    out.push(c)
  })
  GAS_SENSOR_LIST.forEach(s => {
    if (!keepRule(s.id, s.gases)) return
    out.push(gasDebugSensor(s))
  })
  return out
}

// The fan chambers (spec-fans-pumps), /gas debug fans only: a creative motor drives each fan, and the gas is dormant until a fan
// step moves it, which starts at once (no divider). Create sets a fan's flow by its spin, so a fan that blows the wrong way
// needs its motor's speed scrolled to the other sign. A shaft (inside 1 x h x 1): the motor on top, the fan below it facing
// down, the gas below. The nozzle chamber (inside 5 x 4 x 3): the motor in the floor, the fan on it facing up, the nozzle on the
// fan, collectors on two of the fan's sides (the west one filtered to steam), the north side open and the south side glass;
// steam along the top, carbon dioxide in two floor corners.
var GAS_DEBUG_FANS_SECTION = 'fans'
var GAS_DEBUG_MOTOR = 'create:creative_motor'
function gasDebugFanShaft(label, key, h, gasY, pushing) {
  var gi = gasIndexOf(key)
  var name = gasDebugGasTitle(gi)
  var c = gasDebugChamber(GAS_DEBUG_FANS_SECTION, label, 'no divider: the motor turns the fan at once; the fan ' + (pushing ? 'blows the ' + gasDebugGasName(gi) + ' down its shaft, against its rise, to the end of its reach, where it spreads and rises back' : 'pulls the ' + gasDebugGasName(gi) + ' up its shaft toward the fan, against its sinking') + '; if it blows the other way, scroll the motor\'s speed to the other sign; faster turns move it sooner (12 ticks a cell at the slowest, 2 at 256 RPM)', 1, h, 1)
  gasDebugBlock(c, 0, h - 1, 0, gasDebugSpec(GAS_DEBUG_MOTOR, { facing: 'down' }))
  gasDebugBlock(c, 0, h - 2, 0, gasDebugSpec(GAS_FAN_ID, { facing: 'down' }))
  for (var i = 0; i < gasY.length; i++) c.gases.push({ x: 0, y: gasY[i], z: 0, gi: gi, L: 8 })
  gasDebugSetSign(c, () => gasDebugSign('Fan ' + (pushing ? 'pushing ' : 'pulling ') + name + (pushing ? ' down' : ' up'), (pushing ? name + ' is blown down the shaft and held there; past the reach it rises again' : name + ' is drawn up toward the fan and held there'), 'it runs at once; if the gas goes the wrong way, scroll the motor to the other sign'))
  return c
}
function gasDebugFans() {
  var out = [gasDebugFanShaft('fan: steam pushed down', 'steam', 8, [5, 4], true), gasDebugFanShaft('fan: carbon dioxide pulled up', 'carbon_dioxide', 6, [0, 1], false)]
  var steam = gasIndexOf('steam')
  var co2 = gasIndexOf('carbon_dioxide')
  var c = gasDebugChamber(GAS_DEBUG_FANS_SECTION, 'nozzle: steam and carbon dioxide to two collectors', 'no divider: the motor turns the fan at once; the nozzle on it draws the gas in (2 layers a step at most), the west collector (filtered to steam) takes only steam, the east one (no filter) takes the first gas it gets, and what neither can take comes out of the open north side; if the nozzle blows the gas away instead, scroll the motor to the other sign; read the tanks with Jade or /data get block', 5, 4, 3)
  gasDebugBlock(c, 2, -1, 1, gasDebugSpec(GAS_DEBUG_MOTOR, { facing: 'up' }))
  gasDebugBlock(c, 2, 0, 1, gasDebugSpec(GAS_FAN_ID, { facing: 'up' }))
  gasDebugBlock(c, 2, 1, 1, gasDebugSpec(GAS_NOZZLE_ID, { facing: 'up' }))
  gasDebugBlock(c, 1, 0, 1, gasDebugSpec(gasId('gas_collector')))
  gasDebugBlock(c, 3, 0, 1, gasDebugSpec(gasId('gas_collector')))
  gasDebugBlock(c, 2, 0, 2, gasDebugSpec(GAS_DEBUG_SHELL))
  c.filters = [{ x: 1, y: 0, z: 1, key: 'steam' }]
  for (var x = 0; x < 5; x++) for (var z = 0; z < 3; z++) c.gases.push({ x: x, y: 3, z: z, gi: steam, L: 8 })
  c.gases.push({ x: 0, y: 0, z: 0, gi: co2, L: 8 })
  c.gases.push({ x: 4, y: 0, z: 2, gi: co2, L: 8 })
  gasDebugSetSign(c, () => gasDebugSign('Nozzle: ' + gasDebugGasTitle(steam) + ' and ' + gasDebugGasTitle(co2) + ' to two collectors', 'the west collector (steam filter) fills with steam only; the east one takes the first gas it gets; the rest leaves the open north side', 'it runs at once; if the nozzle blows instead, scroll the motor to the other sign'))
  out.push(c)
  return out
}

// The chambers of the chosen sections, one group per section in GAS_DEBUG_SECTIONS order, from the tables (no world
// access). `only` (optional) filters them: { gas: index } keeps the chambers that involve that gas, { rule: id } keeps
// that reaction's chambers (its chain too) and nothing else. Rows are made by gasDebugPlace.
function gasDebugPlan(sections, only) {
  var plan = { rows: [], lines: [], warnings: [], box: null, count: 0 }
  var want = {}
  sections.forEach(s => { want[s] = true })
  var focusGas = only != null && only.gas !== undefined ? only.gas : -1
  var focusRule = only != null && only.rule !== undefined ? String(only.rule) : null
  // Gas chambers (no rule filter, and the focus gas among their gases).
  var keep = function (gis) { return focusRule == null && (focusGas < 0 || gis.indexOf(focusGas) >= 0) }
  // Reaction chambers.
  var keepRule = function (id, gis) { return focusRule != null ? String(id) == focusRule : focusGas < 0 || gis.indexOf(focusGas) >= 0 }
  var row = function (name, chambers) {
    if (chambers.length > 0) { plan.rows.push({ name: name, chambers: chambers }); plan.count += chambers.length }
  }
  var i, j
  if (want.solo) row('solo', GASES.filter(g => keep([g.index])).map(g => gasDebugSolo(g)))
  if (want.density) {
    var dens = []
    for (i = 0; i < GASES.length; i++) for (j = i + 1; j < GASES.length; j++) if (keep([i, j])) dens.push(gasDebugDensity(GASES[i], GASES[j]))
    row('density', dens)
  }
  if (want.side) {
    var byDensity = GASES.slice().sort((p, q) => p.density - q.density)
    var side = []
    for (i = 0; i + 1 < byDensity.length; i++) if (keep([byDensity[i].index, byDensity[i + 1].index])) side.push(gasDebugSide(byDensity[i], byDensity[i + 1]))
    row('side', side)
  }
  if (want.permeable) {
    var perm = []
    var firsts = []
    var up = GASES.filter(g => g.dir > 0)
    var down = GASES.filter(g => g.dir < 0)
    if (up.length > 0) firsts.push(up[0])
    if (down.length > 0) firsts.push(down[0])
    firsts = firsts.filter(g => keep([g.index]))
    GAS_DEBUG_PERMEABLE.forEach(entry => {
      firsts.forEach(g => { entry[2].forEach(k => { perm.push(gasDebugPermeable(entry, g, k)) }) })
    })
    row('permeable', perm)
  }
  // Fans (spec-fans-pumps): only when asked for by name (/gas debug fans), never in 'all'.
  if (want.fans) row('fans', gasDebugFans())
  // Reactions, then blasts (the explosive chambers, last, so their gap pads the box on one side only). One chain per
  // gas, for its first explosive rule, after the blast chambers.
  var gearRow = want.gear ? gasDebugGear(keep, keepRule, focusRule, plan) : []
  if (want.reactions || want.blasts) {
    var reac = []
    var blasts = []
    var chains = []
    var chained = {}
    gasDebugRules().forEach(e => {
      var r = e.rule
      // A condition rule: a condition chamber when every condition has a site text (slice 4: sky, day, storm, warm,
      // always); otherwise (R6 and R23: an ultrawarm dimension) it can't be faked in a chamber and is skipped, with no
      // warning unless it was asked for by name.
      if (r.condition) {
        var cc = gasDebugCondition(r, e.raw)
        if (cc == null) {
          if (focusRule != null && String(r.id) == focusRule) plan.warnings.push('No chamber for reaction ' + r.id + ': it needs a condition (' + r.partners.filter(p => p.kind == 'condition').map(p => p.condition).join(', ') + '), which the rig can\'t fake')
          return
        }
        if (!keepRule(r.id, [r.gas]) || !want[cc.section]) return
        if (cc.section == 'blasts') blasts.push(cc)
        else reac.push(cc)
        return
      }
      var part = gasDebugPartner(r, e.raw)
      if (!keepRule(r.id, gasDebugRuleGases(r, part))) return
      var sec = gasDebugBlast(r) != null ? 'blasts' : 'reactions'
      if (!want[sec]) return
      if (part == null) { plan.warnings.push('No chamber for reaction ' + r.id + ': its partner is a tag with no test partner (GAS_DEBUG_TEST_PARTNERS or a test field)'); return }
      var rc = gasDebugReaction(r, part)
      if (rc.section == 'blasts') blasts.push(rc)
      else reac.push(rc)
      if (rc.blast != null && !chained[r.gas]) {
        chained[r.gas] = true
        var ch = gasDebugChain(r, part)
        if (ch == null) plan.warnings.push('No chain chamber for reaction ' + r.id + ': the chain layout needs a rising gas and a block partner')
        else chains.push(ch)
      }
    })
    if (want.reactions) row('reactions', reac)
    if (want.gear) row('gear', gearRow)
    if (want.blasts) row('blasts', blasts.concat(chains))
  } else if (want.gear) row('gear', gearRow)
  return plan
}

// Places the sections from (x0, y0, z0) and sets plan.box: { x1, y1, z1, x2, y2, z2 }, inclusive. Each section's
// chambers run along +X and wrap into a new row (along +Z) before a row would be longer than GAS_DEBUG_ROW_LEN blocks.
// plan.lines lists the rows: { name, chambers, z, depth, len } (len: blocks from the row's start to the last shell).
// Rows stand GAS_DEBUG_ROW_GAP apart, or GAS_DEBUG_BLAST_GAP next to a blasts row.
function gasDebugPlace(plan, x0, y0, z0) {
  var box = { x1: x0, y1: y0, z1: z0, x2: x0, y2: y0, z2: z0 }
  var z = z0
  var prev = null
  plan.lines = []
  plan.rows.forEach(row => {
    var blast = row.name == 'blasts'
    var line = null
    var x = x0
    row.chambers.forEach(c => {
      if (line == null || (line.chambers.length > 0 && x - x0 + c.w + 2 > GAS_DEBUG_ROW_LEN)) {
        if (prev != null) z += prev.depth + (prev.blast || blast ? GAS_DEBUG_BLAST_GAP : GAS_DEBUG_ROW_GAP)
        line = { name: row.name, chambers: [], z: z, depth: 0, len: 0, blast: blast }
        plan.lines.push(line)
        prev = line
        x = x0
      }
      c.ox = x; c.oy = y0; c.oz = z
      x += c.w + 2 + c.gapAfter
      line.chambers.push(c)
      line.len = c.ox + c.w + 2 - x0
      line.depth = Math.max(line.depth, c.d + 2)
      box.x2 = Math.max(box.x2, c.ox + c.w + 1)
      box.y2 = Math.max(box.y2, c.oy + c.h + 1 + GAS_DEBUG_HEADROOM)
      box.z2 = Math.max(box.z2, z + line.depth - 1)
    })
  })
  plan.box = box
}

function gasDebugInside(b, p) {
  var x = p.getX()
  var y = p.getY()
  var z = p.getZ()
  return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2 && z >= b.z1 && z <= b.z2
}

// Takes every queued or primed position inside the box out of this level's queue, so a rig built over gas that was
// moving starts dormant.
function gasDebugUnqueue(level, b) {
  var dim = level.getDimension()
  var tree = GAS_QUEUES.get(dim)
  var members = GAS_MEMBERS.get(dim)
  if (tree != null) {
    var et = tree.entrySet().iterator()
    while (et.hasNext()) {
      var dq = et.next().getValue()
      var it = dq.iterator()
      while (it.hasNext()) {
        var p = it.next()
        if (gasDebugInside(b, p)) {
          it.remove()
          if (members != null) members.remove(p)
        }
      }
      if (dq.isEmpty()) et.remove()
    }
  }
  var primed = GAS_PRIMED.get(dim)
  if (primed != null) {
    var pit = primed.iterator()
    while (pit.hasNext()) if (gasDebugInside(b, pit.next())) pit.remove()
  }
}

// Fills the box with air (flags GAS_DEBUG_FLAGS), skipping cells already air.
function gasDebugAir(level, b) {
  var o = BlockPos.containing(b.x1, b.y1, b.z1)
  for (var x = 0; x <= b.x2 - b.x1; x++) {
    for (var y = 0; y <= b.y2 - b.y1; y++) {
      for (var z = 0; z <= b.z2 - b.z1; z++) {
        var p = o.offset(x, y, z)
        if (!level.getBlockState(p).isAir()) level.setBlock(p, GAS_AIR_STATE, GAS_DEBUG_FLAGS)
      }
    }
  }
}

function gasDebugVolume(b) { return (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1) }
function gasDebugSize(b) { return (b.x2 - b.x1 + 1) + ' x ' + (b.y2 - b.y1 + 1) + ' x ' + (b.z2 - b.z1 + 1) + ' = ' + gasDebugVolume(b) + ' cells' }

// Is every chunk column of the box loaded, with its entities? Otherwise reading its blocks would load or generate
// chunks, and the label kill would miss labels whose entities aren't loaded. Level.isLoaded(BlockPos) and
// ServerLevel.isPositionEntityTicking(BlockPos) have one signature each, and KubeJS's LevelMixin doesn't shadow them;
// isLoaded is false outside the build height, so ask at the box's floor.
function gasDebugLoaded(level, b) {
  for (var cx = Math.floor(b.x1 / 16); cx <= Math.floor(b.x2 / 16); cx++) {
    for (var cz = Math.floor(b.z1 / 16); cz <= Math.floor(b.z2 / 16); cz++) {
      var p = BlockPos.containing(cx * 16, b.y1, cz * 16)
      if (!level.isLoaded(p) || !level.isPositionEntityTicking(p)) return false
    }
  }
  return true
}

// Is the recorded rig still there? The first chamber always starts at the box's corner, and its wall edge one block
// above the floor there is shell glass (no window or divider sits on that edge).
function gasDebugPresent(level, b) {
  return gasSameState(level.getBlockState(BlockPos.containing(b.x1, b.y1 + 1, b.z1)), Block.getBlock(GAS_DEBUG_SHELL).defaultBlockState())
}

// Commands run as the server, in the level's dimension (level.runCommandSilent would run them once per player in
// the level, as that player).
function gasDebugKillLabels(server, dim, b) {
  server.runCommandSilent('execute in ' + dim + ' run kill @e[type=minecraft:text_display,tag=' + GAS_DEBUG_LABEL_TAG + ',x=' + b.x1 + ',y=' + b.y1 + ',z=' + b.z1 + ',dx=' + (b.x2 - b.x1) + ',dy=' + (b.y2 - b.y1) + ',dz=' + (b.z2 - b.z1) + ']')
}
// The chamber's sign (gasDebugSignLines), centred above it, its lines wrapping at GAS_DEBUG_SIGN_WIDTH pixels.
function gasDebugLabel(server, dim, c) {
  var x = c.ox + (c.w + 2) / 2
  var y = c.oy + c.h + 2.2
  var z = c.oz + (c.d + 2) / 2
  server.runCommandSilent('execute in ' + dim + ' run summon minecraft:text_display ' + x + ' ' + y + ' ' + z + ' {Tags:["' + GAS_DEBUG_LABEL_TAG + '"],billboard:"center",line_width:' + GAS_DEBUG_SIGN_WIDTH + ',text:' + gasDebugSignNbt(gasDebugSignLines(c)) + '}')
}

// Writes one block spec at pos with flags GAS_DEBUG_FLAGS. Blocks with state properties go through KubeJS's
// LevelBlock.set(Block, Map, int), never setValue from a script; other states are looked up once per build.
function gasDebugSet(level, pos, spec, cache) {
  if (spec.fluid != null) {
    var fk = 'fluid ' + spec.fluid
    if (cache[fk] === undefined) cache[fk] = Fluid.getType(spec.fluid).defaultFluidState().createLegacyBlock()
    level.setBlock(pos, cache[fk], GAS_DEBUG_FLAGS)
  } else if (spec.props != null && Object.keys(spec.props).length > 0) {
    level.getBlock(pos).set(Block.getBlock(spec.id), spec.props, GAS_DEBUG_FLAGS)
  } else {
    if (cache[spec.id] === undefined) cache[spec.id] = Block.getBlock(spec.id).defaultBlockState()
    level.setBlock(pos, cache[spec.id], GAS_DEBUG_FLAGS)
  }
}

// What a request builds, for the replies: the sections, or the gas or rule it is filtered to.
function gasDebugWhat(sections, only) {
  if (only != null && only.gas !== undefined) return 'gas ' + GASES[only.gas].key
  if (only != null && only.rule !== undefined) return 'rule ' + only.rule
  return sections.join(', ')
}

// Builds the rig for the chosen sections (filtered by `only`, as in gasDebugPlan) with `origin` (a BlockPos) as the
// caller's position. Returns { plan, lines, built }; nothing is built when the box would be over GAS_DEBUG_MAX_CELLS.
function gasDebugBuild(level, server, origin, sections, only) {
  only = only || null
  var plan = gasDebugPlan(sections, only)
  var what = gasDebugWhat(sections, only)
  var lines = []
  if (plan.count == 0) {
    lines.push('Gas test rig: nothing to build for ' + what + '.')
    plan.warnings.forEach(w => { lines.push('Warning: ' + w) })
    return { plan: plan, lines: lines, built: false }
  }
  var x0 = origin.getX() + GAS_DEBUG_OFFSET
  gasDebugPlace(plan, x0, origin.getY(), origin.getZ())
  var b = plan.box
  if (gasDebugVolume(b) > GAS_DEBUG_MAX_CELLS) {
    lines.push('Gas test rig: not built. The box for ' + what + ' would be ' + gasDebugSize(b) + ', over the limit of ' + GAS_DEBUG_MAX_CELLS + '. Build the sections one at a time, from different spots (each build replaces the record that /gas debug clear uses):')
    sections.forEach(s => {
      var one = gasDebugPlan([s], only)
      if (one.count == 0) return
      gasDebugPlace(one, x0, origin.getY(), origin.getZ())
      lines.push(s + ': ' + one.count + ' chambers, ' + gasDebugSize(one.box) + (gasDebugVolume(one.box) > GAS_DEBUG_MAX_CELLS ? ' (over the limit on its own: raise GAS_DEBUG_MAX_CELLS or shrink the section)' : ''))
    })
    return { plan: plan, lines: lines, built: false }
  }
  var dim = String(level.getDimension())
  gasDebugUnqueue(level, b)
  gasDebugAir(level, b)
  gasDebugKillLabels(server, dim, b)
  var at = function (x, y, z) { return origin.offset(x - origin.getX(), y - origin.getY(), z - origin.getZ()) }
  var cache = {}
  var shell = gasDebugSpec(GAS_DEBUG_SHELL)
  var floor = gasDebugSpec(GAS_DEBUG_FLOOR)
  var all = []
  plan.rows.forEach(row => { row.chambers.forEach(c => { all.push(c) }) })
  // Shells, then the chambers' blocks (floor blocks before what stands on them), then the gas, dormant.
  all.forEach(c => {
    for (var x = -1; x <= c.w; x++) {
      for (var y = -1; y <= c.h; y++) {
        for (var z = -1; z <= c.d; z++) {
          if (x >= 0 && x < c.w && y >= 0 && y < c.h && z >= 0 && z < c.d) continue
          // A chamber's own roof (a storm chamber's light blocks) replaces the glass over its interior columns only.
          var wall = y < 0 ? floor : (y == c.h && c.roof != null && x >= 0 && x < c.w && z >= 0 && z < c.d ? c.roof : shell)
          gasDebugSet(level, at(c.ox + 1 + x, c.oy + 1 + y, c.oz + 1 + z), wall, cache)
        }
      }
    }
    c.blocks.forEach(e => { gasDebugSet(level, at(c.ox + 1 + e.x, c.oy + 1 + e.y, c.oz + 1 + e.z), e.spec, cache) })
    // A rig fan is placed by setBlock, which fires no placed event: register it at once (else the scan finds it within ~100 ticks).
    c.blocks.forEach(e => { if (e.spec.id == GAS_FAN_ID) gasFanBlockChanged(level, at(c.ox + 1 + e.x, c.oy + 1 + e.y, c.oz + 1 + e.z)) })
    // A fan chamber's filtered collector (spec-fans-pumps): an imprinted filter in the collector's filter slot (spec-tank-view).
    if (c.filters != null) c.filters.forEach(e => {
      var fbe = level.getBlockEntity(at(c.ox + 1 + e.x, c.oy + 1 + e.y, c.oz + 1 + e.z))
      var inv = fbe == null ? null : gasCollectorSlot(fbe)
      if (inv == null) { gasWarnOnce('rig filter', 'a rig collector got no filter: no filter slot'); return }
      gasSlotSet(fbe, inv, gasFilterStack(e.key))
    })
  })
  all.forEach(c => {
    c.gases.forEach(e => { gasWrite(level, at(c.ox + 1 + e.x, c.oy + 1 + e.y, c.oz + 1 + e.z), GASES[e.gi], e.L || 8, 0) })
  })
  all.forEach(c => { gasDebugLabel(server, dim, c) })
  server.persistentData.putString(GAS_DEBUG_DATA_KEY + dim, [b.x1, b.y1, b.z1, b.x2, b.y2, b.z2].join(' '))
  lines.push('Gas test rig: ' + plan.count + ' chambers (' + what + ') in the box' + b.x1 + ' ' + b.y1 + ' ' + b.z1 + ' to ' + b.x2 + ' ' + b.y2 + ' ' + b.z2 + ' (' + gasDebugSize(b) + '). Everything that was in that box is gone. Building or clearing a rig this size can freeze the game for a moment.')
  lines.push('The gas is dormant until you break a red block. Random ticks wake it too (about 68 s on average): for timing tests run /gamerule randomTickSpeed 0. /gas debug clear removes the rig.')
  var blasts = all.filter(c => c.blast != null && c.blast.breaks) // flashes (mode 'none') warn in their legends only
  if (blasts.length > 0) {
    var most = blasts.reduce((m, c) => c.blast.reach > m.blast.reach ? c : m, blasts[0]).blast
    lines.push('Warning: ' + blasts.map(c => c.label).join(', ') + ' explode (strength up to ' + most.power + (most.fire ? ', with fire' : '') + ') and reach about ' + most.reach + ' blocks, into the ground under the rig and outside its box, which /gas debug clear does not restore: test in creative, on cleared ground.')
  }
  plan.warnings.forEach(w => { lines.push('Warning: ' + w) })
  gasDebugConditionNotes(all).forEach(t => { lines.push('Note: ' + t) })
  var n = 0
  plan.rows.forEach(row => {
    row.chambers.forEach(c => { n++; lines.push(n + '. ' + c.label + ': ' + c.legend) })
  })
  return { plan: plan, lines: lines, built: true }
}

// The condition rules that act on gas anywhere in this rig, not only in their own chamber (slice 4): a rule with nothing but
// conditions the rig has site texts for, whose gas is in some chamber. Where the place or time holds, that gas changes by
// itself on any wake, and chambers are woken by random ticks (about 68 s), so the build says so once per rule.
function gasDebugConditionNotes(all) {
  var present = {}
  all.forEach(c => { c.gases.forEach(e => { present[e.gi] = true }) })
  var out = []
  gasDebugRules().forEach(e => {
    var r = e.rule
    if (!r.condOnly || r.conditions.some(cn => GAS_DEBUG_SITES[cn] === undefined) || !present[r.gas]) return
    var needs = r.conditions.filter(cn => cn != 'always').map(cn => GAS_DEBUG_SITES[cn])
    out.push(r.id + ' acts on ' + GASES[r.gas].key + ' in every chamber of the rig, not only its own (' + (needs.length > 0 ? 'it needs ' + needs.join(' and ') : 'it needs no particular place or time') + (r.skipUltraWarm ? ', and never fires in the Nether' : '') + '): where that holds, the gas changes by itself on a random tick (about 68 s), so break the dividers soon after building, or run /gamerule randomTickSpeed 0 first')
  })
  return out
}

// Removes the last rig built in this dimension. Returns { status, box }: 'none' (no rig recorded), 'unloaded' (a chunk
// of the box, or its entities, isn't loaded), 'gone' (the rig isn't there any more and force is off) or 'cleared'.
function gasDebugClear(level, server, force) {
  var dim = String(level.getDimension())
  var pd = server.persistentData
  var saved = String(pd.getString(GAS_DEBUG_DATA_KEY + dim))
  if (saved == '') return { status: 'none', box: null }
  var n = saved.split(' ').map(s => Number(s))
  var b = { x1: n[0], y1: n[1], z1: n[2], x2: n[3], y2: n[4], z2: n[5] }
  if (!gasDebugLoaded(level, b)) return { status: 'unloaded', box: b }
  if (!force && !gasDebugPresent(level, b)) return { status: 'gone', box: b }
  gasDebugUnqueue(level, b)
  gasDebugAir(level, b)
  gasDebugKillLabels(server, dim, b)
  pd.remove(GAS_DEBUG_DATA_KEY + dim)
  return { status: 'cleared', box: b }
}

// The sections a /gas debug argument names, or null.
function gasDebugSections(arg) {
  if (arg == 'all') return GAS_DEBUG_SECTIONS.slice()
  if (arg == GAS_DEBUG_FANS_SECTION) return [GAS_DEBUG_FANS_SECTION]
  return GAS_DEBUG_SECTIONS.indexOf(arg) >= 0 ? [arg] : null
}

// The `only` filter for /gas debug gas <key> or rule <id> (kind 'gas' or 'rule'; arg null when none was given):
// { only } or { error }, the error naming every valid key or id.
function gasDebugFocus(kind, arg) {
  var valid = kind == 'gas' ? GASES.map(g => String(g.key)) : gasDebugRules().map(e => String(e.rule.id)).concat(GAS_INTAKE_LIST.map(it => String(it.id))).concat(GAS_SENSOR_LIST.map(s => String(s.id)))
  if (arg == null) return { error: 'Name a ' + kind + ': ' + valid.join(', ') }
  var i = valid.indexOf(String(arg))
  if (i < 0) return { error: 'Unknown ' + kind + ': ' + arg + ' (' + valid.join(', ') + ')' }
  return { only: kind == 'gas' ? { gas: gasIndexOf(valid[i]) } : { rule: valid[i] } }
}

// --- Test command ---
// /gas <layers> [gas] (1 to 48: gasAdd fills the cell, the one ahead and the four sides): puts gas 3 blocks above where the command runs, through gasAdd, so it is queued at once.
// (/setblock fires no KubeJS event, so a cloud placed that way waits for a random tick before it moves.)
var GasCommands = Java.loadClass('net.minecraft.commands.Commands')
var GasInt = Java.loadClass('com.mojang.brigadier.arguments.IntegerArgumentType')
var GasWord = Java.loadClass('com.mojang.brigadier.arguments.StringArgumentType')

ServerEvents.commandRegistry(function (event) {
  var place = function (ctx, layers, key) {
    var gi = gasIndexOf(key)
    if (gi < 0) { ctx.source.sendFailure(Text.of('Unknown gas: ' + key)); return 0 }
    var level = ctx.source.getLevel()
    var v = ctx.source.getPosition()
    var pos = BlockPos.containing(v.x(), v.y() + 3, v.z())
    var left = gasAdd(level, pos, gi, layers)
    ctx.source.sendSystemMessage(Text.of('Placed ' + (layers - left) + ' layer(s) of ' + key + ' at ' + pos.toShortString() + (left > 0 ? ' (' + left + ' had no room)' : '')))
    return 1
  }
  // /gas debug [section], /gas debug gas <key>, /gas debug rule <id> and /gas debug clear: the test rig (see "Test
  // rig" above).
  var build = function (ctx, sections, only) {
    var v = ctx.source.getPosition()
    var res = gasDebugBuild(ctx.source.getLevel(), ctx.source.getServer(), BlockPos.containing(v.x(), v.y(), v.z()), sections, only)
    res.lines.forEach((line, i) => {
      if (!res.built && i == 0) ctx.source.sendFailure(Text.of(line))
      else ctx.source.sendSystemMessage(Text.of(line))
    })
    return res.built ? 1 : 0
  }
  var debug = function (ctx, arg) {
    var sections = gasDebugSections(arg)
    if (sections == null) { ctx.source.sendFailure(Text.of('Unknown section: ' + arg + ' (' + GAS_DEBUG_SECTIONS.join(', ') + ', all, ' + GAS_DEBUG_FANS_SECTION + ', clear, gas <key> or rule <id>)')); return 0 }
    return build(ctx, sections, null)
  }
  // kind 'gas' or 'rule'; arg null when the key or id is missing, which fails with the list.
  var focus = function (ctx, kind, arg) {
    var f = gasDebugFocus(kind, arg)
    if (f.error) { ctx.source.sendFailure(Text.of(f.error)); return 0 }
    return build(ctx, GAS_DEBUG_SECTIONS.slice(), f.only)
  }
  var clear = function (ctx, force) {
    var res = gasDebugClear(ctx.source.getLevel(), ctx.source.getServer(), force)
    var b = res.box
    var where = b == null ? '' : b.x1 + ' ' + b.y1 + ' ' + b.z1 + ' to ' + b.x2 + ' ' + b.y2 + ' ' + b.z2
    if (res.status == 'none') { ctx.source.sendFailure(Text.of('No gas test rig is recorded in this dimension.')); return 0 }
    if (res.status == 'unloaded') { ctx.source.sendFailure(Text.of('Not cleared: part of the rig (' + where + ') is not loaded, or its entities are not. Stand near the rig and try again.')); return 0 }
    if (res.status == 'gone') { ctx.source.sendFailure(Text.of('Not cleared: the recorded rig (' + where + ') is not there any more (the glass at ' + b.x1 + ' ' + (b.y1 + 1) + ' ' + b.z1 + ' is gone). /gas debug clear force empties that box anyway.')); return 0 }
    ctx.source.sendSystemMessage(Text.of('Gas test rig cleared: ' + where + ' is air.'))
    return 1
  }
  event.register(GasCommands.literal('gas')
    .requires(function (src) { return src.hasPermission(2) })
    .then(GasCommands.literal('debug')
      .executes(function (ctx) { return debug(ctx, 'all') })
      .then(GasCommands.literal('clear')
        .executes(function (ctx) { return clear(ctx, false) })
        .then(GasCommands.literal('force').executes(function (ctx) { return clear(ctx, true) })))
      .then(GasCommands.literal('gas')
        .executes(function (ctx) { return focus(ctx, 'gas', null) })
        .then(GasCommands.argument('key', GasWord.word())
          .executes(function (ctx) { return focus(ctx, 'gas', String(GasWord.getString(ctx, 'key'))) })))
      .then(GasCommands.literal('rule')
        .executes(function (ctx) { return focus(ctx, 'rule', null) })
        .then(GasCommands.argument('id', GasWord.word())
          .executes(function (ctx) { return focus(ctx, 'rule', String(GasWord.getString(ctx, 'id'))) })))
      .then(GasCommands.argument('section', GasWord.word())
        .executes(function (ctx) { return debug(ctx, String(GasWord.getString(ctx, 'section'))) })))
    .then(GasCommands.argument('layers', GasInt.integer(1, 48))
      .executes(function (ctx) { return place(ctx, GasInt.getInteger(ctx, 'layers'), 'steam') })
      .then(GasCommands.argument('gas', GasWord.word())
        .executes(function (ctx) { return place(ctx, GasInt.getInteger(ctx, 'layers'), String(GasWord.getString(ctx, 'gas'))) }))))
})
