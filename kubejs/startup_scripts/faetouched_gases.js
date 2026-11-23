// Faetouched gases (B-034, knowledge/systems/gases.md): gases are KubeJS fluids in pipes and tanks, and layered
// cloud blocks in the world that rise or sink, spread, layer by density, react and dissipate.
// This file: the gas table and the reaction table (the single sources of truth), the Java collections the server
// script shares through `global`, the fluids (the gases, and the fluids reactions make), the cloud blocks (with their
// effects on entities inside, which a mask ends), the gas collector, the mask, lamp and gas filter items, the fans'
// shared maps, Create's open-pipe handler, and (quest-gas slice 5) the tables of intakes (K3), gas-reading blocks (K2),
// masks and detectors (K5). The gas vent is an MBD2 machine, not registered here: mbd2/machines/gas_vent.json.
// Simulation, reactions, block entity ticks, tags and recipes: server_scripts/faetouched_gases.js.
// Cloud look: kubejs/assets/faetouched/blockstates/<gas>_cloud.json and models/block/gas_layer_up_1..8.json
// (rising gases, layers hang from the top) and gas_layer_down_1..8.json (sinking gases, layers sit on the floor).
// Only startup scripts may assign to `global` (KubeJS 7). Rhino rejects const/let redeclared inside loop bodies,
// so this file uses var and forEach.

var GasHashMap = Java.loadClass('java.util.HashMap')
var GasArrayDeque = Java.loadClass('java.util.ArrayDeque')
var GasEntry = Java.loadClass('java.util.AbstractMap$SimpleImmutableEntry')
var GasHashSet = Java.loadClass('java.util.HashSet')

// A side set for an inventory attachment (spec-tank-view): a HashSet filled with add (one signature), not EnumSet.of, whose
// overloads Rhino might find ambiguous.
function gasSides(dirs) {
  var s = new GasHashSet()
  dirs.forEach(d => { s.add(d) })
  return s
}

// One entry per gas.
// density: the fluid's FluidType density and the gas's behaviour in one number. Its sign is the direction
//   (negative rises, positive sinks); a gas passes through a gas it is lighter (rising) or heavier (sinking) than,
//   so gases layer by density: the denser gas always ends below. Gases don't mix sideways (mixing was removed,
//   the author's call, 2026-11-18): two gases that should combine get a rule in GAS_REACTIONS.
// dir: +1 rises, -1 sinks (follows density's sign; written out for the server script).
// interval: the relative flow rate, the author-facing speed: the server script updates a cloud cell every
//   interval x GAS_INTERVAL_SCALE ticks (3 since 2026-11-18). Roughly max(1, round(3000 / |density|)) clamped to
//   1..8, but set by hand.
// ceiling: rising gases only, where the gas loses a layer per update, at and above it: 'top' (the author's call,
//   2026-11-20, prototypes/gases/specs/spec-top-split.md) is the top cell of the world the gas is in (the server script
//   reads level.getMaxBuildHeight() - 1: overworld 319, the End 255); a number is that Y; anything else warns at load
//   and uses the top. ceilings: per-dimension overrides, a Y each: the Nether keeps Y 120, below its bedrock roof at
//   128, since its top (255) is above the roof and out of reach (without it Nether gas would pool under the roof for
//   ever). Sinking gases have no floor limit: they pool forever and are lost only when they fall out of the world
//   (server script, the failsafe).
// light: 0 to 1, a fraction of full brightness (KubeJS 2101.7's lightLevel multiplies by 15: 0.5 gives block light 7).
// effects: applied to living entities inside the cloud. A mob effect: { id, seconds, amplifier } (amplifier 0 = level
//   I, 1 = level II). Damage (quest-gas slice 2): { damage: damage type ID, amount, every: ticks }, at most one hit
//   every `every` ticks per entity (scalding steam: minecraft:hot_floor, which is in #minecraft:is_fire, so Fire
//   Resistance and fire-immune mobs take none).
// settles (optional): { into: { fluid: id }, after: ticks }: a cell of the gas that is full (8 layers) and hasn't
//   moved for `after` ticks becomes a source of that fluid (server script). `after` is real time (20 = 1 s), not
//   scaled with the intervals.
// drift (optional, 0 to 1): the chance that a straight move ahead (up or down, not through a permeable run) splits the
//   cell: half its layers (rounded down, at least 1) to an open diagonal, the rest straight, so a rising or sinking plume
//   spreads and thins into a cone (prototypes/gases/specs/spec-drift.md, spec-top-split.md). Default
//   0.33 for rising gases and 0.2 for sinking ones (the author's call, 2026-11-20: lighter gases drift more); 0 for none.
//   A value outside 0..1 or not a number warns at load and keeps the default. No gas sets it yet.
// Look: a gas's cloud blockstate (kubejs/assets/faetouched/blockstates/<key>_cloud.json) picks its layer models;
//   condensate's are children of gas_layer_down_1..8 with the water texture (condensate_layer_down_1..8), and each
//   other condensate's (<key>_layer_down_1..8) with its fluid's still texture.
var GAS_RISING_CEILINGS = { 'minecraft:the_nether': 120 } // below the Nether's bedrock roof (logical height 128)
var GAS_TABLE = [
  {
    key: 'steam', name: 'Steam', density: -1000, dir: 1, interval: 2, tint: 0xE8EEF2, light: 0,
    temperature: 373, ceiling: 'top', ceilings: GAS_RISING_CEILINGS, effects: []
  },
  {
    key: 'hydrogen', name: 'Hydrogen', density: -3000, dir: 1, interval: 1, tint: 0xF4F8FF, light: 0,
    temperature: 293, ceiling: 'top', ceilings: GAS_RISING_CEILINGS, effects: []
  },
  {
    key: 'glimmermist', name: 'Glimmermist', density: -300, dir: 1, interval: 4, tint: 0xC9A7FF, light: 0.5,
    temperature: 293, ceiling: 'top', ceilings: GAS_RISING_CEILINGS,
    effects: [{ id: 'minecraft:glowing', seconds: 10, amplifier: 0 }]
  },
  {
    key: 'bog_miasma', name: 'Bog Miasma', density: 400, dir: -1, interval: 4, tint: 0x6B8F3A, light: 0,
    temperature: 293,
    effects: [{ id: 'minecraft:nausea', seconds: 8, amplifier: 0 }, { id: 'minecraft:poison', seconds: 4, amplifier: 0 }]
  },
  {
    key: 'carbon_dioxide', name: 'Carbon Dioxide', density: 1500, dir: -1, interval: 2, tint: 0xB8BCC0, light: 0,
    temperature: 293,
    effects: [{ id: 'minecraft:slowness', seconds: 6, amplifier: 0 }, { id: 'minecraft:weakness', seconds: 6, amplifier: 0 }]
  },
  {
    key: 'chlorine', name: 'Chlorine', density: 3000, dir: -1, interval: 1, tint: 0xD8E85A, light: 0,
    temperature: 293,
    effects: [{ id: 'minecraft:poison', seconds: 4, amplifier: 1 }]
  },
  // Condensate (the author's call, 2026-11-18): what condensing steam makes (R1), a heavy gas that looks like water
  // and settles into water. Density 5000: below every gas but argent and the four fluid condensates (below). In an ultrawarm dimension it
  // evaporates back into steam (R6) and never settles.
  {
    key: 'condensate', name: 'Condensate', density: 5000, dir: -1, interval: 1, tint: 0x3F76E4, light: 0,
    temperature: 293, effects: [], settles: { into: { fluid: 'minecraft:water' }, after: 20 }
  },
  // The quest gases (B-034 quest-gas design, adopted 2026-11-19; knowledge/proposals/quest-gases.md), slice 2. Engine
  // gases keep their table positions, so the six are appended. Condensate is no longer the heaviest (argent and the fluid condensates below are heavier).
  // Zephyr: lift for nets, lofts and launch towers; takes the roof from firedamp and steam.
  {
    key: 'zephyr', name: 'Zephyr', density: -2000, dir: 1, interval: 1, tint: 0xB8F0E0, light: 0,
    temperature: 293, ceiling: 'top', ceilings: GAS_RISING_CEILINGS,
    effects: [{ id: 'minecraft:slow_falling', seconds: 4, amplifier: 0 }]
  },
  // Firedamp: seep, oven and gasworks gas; flashes at an open flame (R16) and leaves carbon dioxide.
  {
    key: 'firedamp', name: 'Firedamp', density: -1400, dir: 1, interval: 2, tint: 0xE3D9A6, light: 0,
    temperature: 293, ceiling: 'top', ceilings: GAS_RISING_CEILINGS, effects: []
  },
  // Scalding steam (the author's call, 2026-11-19: two steams): steam that met an open flame (R40) or a quench; cools
  // back to steam beside water, ice, rime or condensate (R37). Scalds: 1 damage, at most every 10 ticks.
  {
    key: 'scalding_steam', name: 'Scalding Steam', density: -1200, dir: 1, interval: 1, tint: 0xFFE4D6, light: 0,
    temperature: 473, ceiling: 'top', ceilings: GAS_RISING_CEILINGS,
    effects: [{ damage: 'minecraft:hot_floor', amount: 1, every: 10 }]
  },
  // Reek: roasting fumes. Floats on carbon dioxide, rime and chlorine.
  {
    key: 'reek', name: 'Reek', density: 900, dir: -1, interval: 3, tint: 0xA8843A, light: 0,
    temperature: 293,
    effects: [{ id: 'minecraft:blindness', seconds: 6, amplifier: 0 }, { id: 'minecraft:hunger', seconds: 10, amplifier: 0 }]
  },
  // Rime: cold-heat supply, drawn from ice. Lies under carbon dioxide and reek.
  {
    key: 'rime', name: 'Rime', density: 2200, dir: -1, interval: 2, tint: 0xCFEFFF, light: 0,
    temperature: 263,
    effects: [{ id: 'minecraft:slowness', seconds: 6, amplifier: 0 }]
  },
  // Argent: retort losses, the heaviest of the original gases.
  {
    key: 'argent', name: 'Argent', density: 8000, dir: -1, interval: 1, tint: 0x9AA4B4, light: 0,
    temperature: 293,
    effects: [{ id: 'minecraft:mining_fatigue', seconds: 8, amplifier: 0 }, { id: 'minecraft:nausea', seconds: 8, amplifier: 0 }]
  },
  // The condensates (the author's call, 2026-11-20: "moonwater conversion from glimmermist should be a condensation
  // reaction, like steam is ... apply this logic to anything that is a fluid conversion type"). Every reaction that made a
  // fluid source straight from gas (R9 to R12, R19, R20) now makes one of these instead, 8 layers for the 8 it used: a
  // heavy gas that looks like its fluid (same still texture and tint) and settles into that fluid's source once a full
  // cell has sat still for 20 ticks, as condensate does into water. Appended, so no earlier gas moves in the table.
  // Their densities are above condensate's 5000, which the water condensate keeps for the lightest liquid; heavier
  // liquids sink below lighter ones. Lightest first: moonwater 5500 (thin, water-like), vitriol 6500 (an acid, about
  // 1.8 times water), argent 8000, vermilion 9000, quicksilver 10000 (the heaviest, 13.5 times water). All interval 1,
  // as condensate (3000 / density rounds to 1 for each). None evaporates in the Nether (R6 is water's own) and none
  // reacts as condensate does at lava, rime or scalding steam (R28, R33, R37): see the proposal for each. In an ultrawarm
  // dimension the settle rule is off for every settling gas, so they stay gas there.
  {
    key: 'moonwater_condensate', name: 'Moonwater Condensate', density: 5500, dir: -1, interval: 1, tint: 0xD8D0FF, light: 0,
    temperature: 293, effects: [], settles: { into: { fluid: 'faetouched:moonwater' }, after: 20 }
  },
  {
    key: 'vitriol_condensate', name: 'Vitriol Condensate', density: 6500, dir: -1, interval: 1, tint: 0xC8D86A, light: 0,
    temperature: 293, effects: [], settles: { into: { fluid: 'faetouched:vitriol' }, after: 20 }
  },
  {
    key: 'vermilion_condensate', name: 'Vermilion Condensate', density: 9000, dir: -1, interval: 1, tint: 0xC8302C, light: 0,
    temperature: 293, effects: [], settles: { into: { fluid: 'faetouched:vermilion' }, after: 20 }
  },
  {
    key: 'quicksilver_condensate', name: 'Quicksilver Condensate', density: 10000, dir: -1, interval: 1, tint: 0xC8CED6, light: 0,
    temperature: 293, effects: [], settles: { into: { fluid: 'faetouched:quicksilver' }, after: 20 }
  }
]

// Open flame, one list for every rule that needs a flame (the author's call, 2026-11-19): fire, lit campfires, lit
// candles and lava. Never torches, lanterns, furnaces or blaze burners (heated mixers make hydrogen). The rules that put
// flames out (R29 fire, R30 campfires and candles; quest-gas slice 3) take their partners from the same pieces.
var GAS_FLAME_FIRE = { block: '#minecraft:fire' }
var GAS_FLAME_LIT = [
  { block: '#minecraft:campfires', state: { lit: true } },
  { block: '#minecraft:candles', state: { lit: true } }
]
var GAS_OPEN_FLAME = [GAS_FLAME_FIRE].concat(GAS_FLAME_LIT).concat([{ fluid: '#minecraft:lava' }])
// Cold iron (R25): blocks that ground zephyr.
var GAS_COLD_IRON = [
  { block: 'minecraft:iron_block' }, { block: 'minecraft:iron_bars' }, { block: 'minecraft:chain' },
  { block: 'minecraft:iron_door' }, { block: 'minecraft:iron_trapdoor' }, { block: 'faetouched:steel_block' }
]

// Reactions, checked by the server script when a cloud cell updates, against its six neighbours; the first rule
// that fires is applied and ends the update.
// gas: the reacting gas. with: one partner or a list, each { gas: key }, { block: id or '#tag', state: {...} },
//   { fluid: id or '#tag' } (a fluid source or flowing block, read from its fluid state) or { condition: name }
//   (read at the reacting cell, no neighbour needed; several are ANDed, and the server script reads them only when the
//   rule is checked, cheapest first). Quest-gas slice 4 (kind K6) knows these conditions (server script,
//   GAS_CONDITION_TESTS; an unknown name drops the rule with a warning):
//     'ultrawarm'  a dimension whose type is ultrawarm, such as the Nether
//     'always'     true: the rule's chance is a decay timer (R38; pair it with skipUltraWarm to keep the Nether out)
//     'day'        vanilla's Level.isDay(): sky darkening under 4 in a dimension with a day cycle, which in clear weather is
//                  daytime 23,460 to 12,541 (through dawn, noon and dusk), in rain 23,992 to 12,009, and never in a
//                  thunderstorm at noon (the weather darkens the sky past 4)
//     'sky'        open sky over the cell: sky light 15 (nothing above dims light: no leaves, water, solid block or tinted
//                  glass) and no block of the tag faetouched:sky_shade (stained glass, built in the server script) in the
//                  column up to the highest motion-blocking block; plain glass, glass panes and iron bars count as open
//     'storm'      thundering, and rain falls on the cell (Level.isRainingAt: sky light 15, no motion-blocking block
//                  above, the biome rains there rather than snows); glass, panes and iron bars shelter the cell
//     'warm'       the cell's biome has a base temperature of 1.0 or more (desert, savanna, badlands)
//     'snowy'      (slice 5, for the intakes below) vanilla's Biome.coldEnoughToSnow at the cell: the biome's temperature
//                  adjusted for height is under 0.15, so snow biomes and cold high ground, never a mild or warm biome
//   A cell whose condition is false drops out of the queue until something wakes it, and random ticks (about every 68 s
//   a block) do, so a time or weather condition is noticed within about a minute, not at once.
// minLayers (default 1): layers the reacting cell needs. chance (default 1): per check; a partner that is present
//   but didn't fire makes the cell check again later.
// consume: layers of the reacting gas used up (a number or 'all'); consumeOther: layers of a partner gas used up.
// result: { gas: key, layers: n or 'same' } put into the reacting cell (n at most the layers consumed), or
//   { gas: key, ratio: r } (floor(layers consumed x r) layers; a remainder is lost), or { fluid: id } placed as a
//   source in the reacting cell (needs minLayers 8 and consume 8). A gas product goes into the reacting cell when
//   that empties (at most 8 layers there; the rest spills like placed gas, and what has no room is lost).
//   (No rule makes a fluid source straight from gas any more: R9 to R12, R19 and R20 make condensate gases, 2026-11-20.)
//   at: 'partner' places a gas product by gasAdd starting at the partner gas cell (it fills that cell, then spills
//   around it); the rule fires only when every product layer has room, so mass is conserved.
//   Block results (quest-gas slice 3, kind K1): the rule changes a block instead of making gas. Reactions place or
//   change blocks but drop no items themselves (the author's call, 2026-11-19): one setBlock or one random tick per
//   firing. The setBlock still runs vanilla's neighbour shape updates, so what was attached to a changed block (a torch
//   on melted ice, a lily pad on taken water) can pop off as an item, as when vanilla ice melts. The forms:
//     { block: id, at: 'partner' }  the partner block or fluid becomes that block's default state ('minecraft:air'
//                                   clears it)
//     { block: id, at: 'self' }     the reacting cell becomes the block; the rule must use up the whole cell (consume
//                                   'all' or 8)
//     { state: { prop: value }, at: 'partner' }  the partner keeps its block and its other properties; the named
//                                   properties change
//     { tick: n, at: 'partner' }    the partner gets n random ticks (never one holding lava: AgriCraft's crop sticks
//                                   burn and drop items there)
//     { fluid: id, at: 'partner' }  the partner becomes a source of the fluid (a water result in an ultrawarm
//                                   dimension leaves air, as vanilla's water bucket and melting ice do)
//   at: 'partner' needs block or fluid partners: the one that matched is changed. consume may be 0 (the gas isn't used).
//   Partner filters for block results: { fluid, source: true } (a source block of the fluid itself, not a waterlogged
//   block or a water plant) and { block, growing: true } (the block's own isValidBonemealTarget, read on every check:
//   AgriCraft keeps a crop's growth in its block entity, not in the state).
// effect: { type: 'explode', powerPerLayer, maxPower, fire, mode } (mode 'tnt' breaks blocks like TNT; at most 2
//   ignitions per tick) or { type: 'particles', particle, count }.
// skipUltraWarm: the rule doesn't fire in ultrawarm dimensions (the Nether).
// vibration (optional; none of the rules below sets it): the vanilla game event a firing emits at the reacting cell, which sculk
//   sensors hear: a minecraft: game event ID (its path upper-cased names GameEvent's static field, so resonate_7 is RESONATE_7,
//   and resonate_1 to resonate_15 have exactly the frequencies 1 to 15, which a comparator reads from a sensor and a calibrated sensor filters on) or false for none. A bad ID warns at load and keeps the
//   default, which comes from the rule's shape (server script, gasShapeOf): a block result block_activate (frequency 10), a gas
//   product block_change (11), no product fluid_pickup (12), a fluid product fluid_place (13), an explode effect nothing extra
//   (vanilla's explosion emits explode, 15); a settle conversion emits fluid_place. An explode rule's override is emitted too.
var GAS_REACTIONS = [
  // R1: gas + block, a layer threshold, gas -> gas at 2:1. Steam beside ice becomes condensate, one layer for every
  // two of steam (an odd layer is lost), which settles into water once a cell is full and still (the author's call,
  // 2026-11-18: a water source straight from steam felt wrong).
  {
    id: 'condensation', gas: 'steam', with: { block: '#minecraft:ice' },
    minLayers: 2, consume: 'all', result: { gas: 'condensate', ratio: 0.5 }, skipUltraWarm: true
  },
  // R2: gas + block or fluid, an effect, a chain (explosions ignite the hydrogen they reach). Strength 1 per layer,
  // at most 8 (doubled, the author's call, 2026-11-18). The open-flame list (lit candles since the quest gases).
  {
    id: 'ignition', gas: 'hydrogen', with: GAS_OPEN_FLAME,
    consume: 'all', effect: { type: 'explode', powerPerLayer: 1.0, maxPower: 8, fire: true, mode: 'tnt' }
  },
  // R3: gas + fluid, a chance, consumption with no product.
  { id: 'dissolving', gas: 'chlorine', with: { fluid: '#minecraft:water' }, consume: 1, chance: 0.2 },
  // R4: gas + gas, both consumed, no product, particles.
  {
    id: 'annihilation', gas: 'chlorine', with: { gas: 'hydrogen' }, consume: 1, consumeOther: 1, chance: 0.5,
    effect: { type: 'particles', particle: 'minecraft:smoke', count: 8 }
  },
  // R5: gas + gas, one transformed, layers 1:1, gradual (the author's call, 2026-11-18): each firing takes one
  // glimmermist layer and places one bog miasma layer by gasAdd from the touching miasma cell, so the miasma grows
  // layer by layer and keeps touching the glimmermist. When that layer has no room, the whole glimmermist cell turns
  // into miasma, layer for layer (whenFull: 'flip', the author's call, 2026-11-19), so souring always keeps spreading.
  {
    id: 'souring', gas: 'glimmermist', with: { gas: 'bog_miasma' }, consume: 1,
    result: { gas: 'bog_miasma', layers: 1, at: 'partner', whenFull: 'flip' }, chance: 0.1
  },
  // R6: gas + condition, the inverse of R1 (the author's call, 2026-11-18): condensate in an ultrawarm dimension (the
  // Nether) becomes steam, 2 layers for each of condensate. The whole cell converts at once: it keeps 8 layers of
  // steam at most, the rest spills like placed gas, and what has no room is lost.
  {
    id: 'evaporation', gas: 'condensate', with: { condition: 'ultrawarm' }, consume: 'all',
    result: { gas: 'steam', ratio: 2 }
  },

  // --- The quest gases, slice 2 (B-034 quest-gas design, adopted 2026-11-19): the rules today's engine expresses. The
  // design's numbers are kept as the rule ids' comments (R7 and so on). Per gas, rules are tried in this order, and a
  // gas-gas rule counts for both gases. Slice 3 adds the block results (R8, R29 to R33, R39); slice 4 the condition rules
  // R34 to R36 and R38 (warm, sky and day, storm, always).
  // R7: as R5, the product reek.
  {
    id: 'souring_reek', gas: 'glimmermist', with: { gas: 'reek' }, consume: 1,
    result: { gas: 'reek', layers: 1, at: 'partner', whenFull: 'flip' }, chance: 0.1
  },
  // R8 (slice 3): a full reek cell over a water source turns the water into a vitriol source and is used up (8 layers to
  // the bucket). The vitriol forms in the water's cell and uses up the water (the author's call, 2026-11-19). It stays a
  // block result, with no condensate: it changes the water block itself, it isn't gas turning into a fluid (2026-11-20).
  {
    id: 'vitriol_scrub', gas: 'reek', with: { fluid: '#minecraft:water', source: true }, minLayers: 8, consume: 8,
    result: { fluid: 'faetouched:vitriol', at: 'partner' }
  },
  // R9, R10: a full glimmermist cell beside ice, or rime (which loses a layer), condenses into 8 layers of moonwater
  // condensate, which settles into a moonwater source (the author's call, 2026-11-20: a condensation like steam's; before,
  // the fluid source came straight from the gas).
  { id: 'moonwater_ice', gas: 'glimmermist', with: { block: '#minecraft:ice' }, minLayers: 8, consume: 8, result: { gas: 'moonwater_condensate', layers: 'same' } },
  { id: 'moonwater_rime', gas: 'glimmermist', with: { gas: 'rime' }, minLayers: 8, consume: 8, consumeOther: 1, result: { gas: 'moonwater_condensate', layers: 'same' } },
  // R20, before R11 and R12: a quarter of full argent cells touching reek turn to vermilion condensate (reek -2), which
  // settles into a vermilion source, which a Create compactor presses into cinnabar (server script). No reaction drops
  // items (the author's call, 2026-11-19).
  { id: 'recombination', gas: 'argent', with: { gas: 'reek' }, minLayers: 8, consume: 8, consumeOther: 2, result: { gas: 'vermilion_condensate', layers: 'same' }, chance: 0.25 },
  // R11, R12: a full argent cell beside ice, or rime (-2), becomes quicksilver condensate, which settles into a quicksilver source.
  { id: 'quicksilver_ice', gas: 'argent', with: { block: '#minecraft:ice' }, minLayers: 8, consume: 8, result: { gas: 'quicksilver_condensate', layers: 'same' } },
  { id: 'quicksilver_rime', gas: 'argent', with: { gas: 'rime' }, minLayers: 8, consume: 8, consumeOther: 2, result: { gas: 'quicksilver_condensate', layers: 'same' } },
  // R13: rime at an open flame thaws into steam, layer for layer.
  { id: 'thaw', gas: 'rime', with: GAS_OPEN_FLAME, consume: 'all', result: { gas: 'steam', layers: 'same' } },
  // R14: steam beside rime condenses as at ice (2:1), and the rime loses 2 layers. Not in ultrawarm dimensions.
  {
    id: 'frost_condensation', gas: 'steam', with: { gas: 'rime' }, minLayers: 2, consume: 'all', consumeOther: 2,
    result: { gas: 'condensate', ratio: 0.5 }, skipUltraWarm: true
  },
  // R15: reek fouls rime: one layer of each, white ash.
  {
    id: 'fouling', gas: 'rime', with: { gas: 'reek' }, consume: 1, consumeOther: 1, chance: 0.25,
    effect: { type: 'particles', particle: 'minecraft:white_ash', count: 8 }
  },
  // R16: firedamp at an open flame flashes (0.15 per layer, at most 1.2, no fire, breaks nothing) and leaves carbon
  // dioxide, 1 layer per 2. The product is written before the flash, and mode 'none' keeps it; the flash primes the
  // hydrogen and firedamp it reaches, as R2's blast does.
  {
    id: 'afterdamp', gas: 'firedamp', with: GAS_OPEN_FLAME, consume: 'all', result: { gas: 'carbon_dioxide', ratio: 0.5 },
    effect: { type: 'explode', powerPerLayer: 0.15, maxPower: 1.2, fire: false, mode: 'none' }
  },
  // R17: bog miasma at an open flame burns off: the cell becomes carbon dioxide, layer for layer, with flames.
  {
    id: 'burn_off', gas: 'bog_miasma', with: GAS_OPEN_FLAME, consume: 'all', result: { gas: 'carbon_dioxide', layers: 'same' },
    chance: 0.5, effect: { type: 'particles', particle: 'minecraft:flame', count: 8 }
  },
  // R18: chlorine sweetens bog miasma: one layer of each, white ash.
  {
    id: 'sweetening', gas: 'bog_miasma', with: { gas: 'chlorine' }, consume: 1, consumeOther: 1, chance: 0.3,
    effect: { type: 'particles', particle: 'minecraft:white_ash', count: 8 }
  },
  // R19: a full reek cell beside steam or scalding steam (-4) becomes vitriol condensate, which settles into a vitriol source.
  {
    id: 'acid_mist', gas: 'reek', with: [{ gas: 'steam' }, { gas: 'scalding_steam' }], minLayers: 8, consume: 8, consumeOther: 4,
    result: { gas: 'vitriol_condensate', layers: 'same' }, chance: 0.25
  },
  // R21: argent and chlorine: one layer of each, white ash.
  {
    id: 'sublimate', gas: 'argent', with: { gas: 'chlorine' }, consume: 1, consumeOther: 1, chance: 0.25,
    effect: { type: 'particles', particle: 'minecraft:white_ash', count: 8 }
  },
  // R22: hydrogen vented through reek is defused but stinks: the cell becomes bog miasma, layer for layer; reek -1.
  { id: 'hepar', gas: 'hydrogen', with: { gas: 'reek' }, consume: 'all', consumeOther: 1, result: { gas: 'bog_miasma', layers: 'same' }, chance: 0.25 },
  // R23: rime in an ultrawarm dimension thaws into steam (as R6).
  { id: 'thaw_ultrawarm', gas: 'rime', with: { condition: 'ultrawarm' }, consume: 'all', result: { gas: 'steam', layers: 'same' } },
  // R24: chlorine bleaches glimmermist: one layer of each, white ash. Each firing also bleaches the dyed porous blocks
  // (GAS_BLEACH below) within a sphere of radius 2 of the glimmermist cell (the author's call, 2026-11-20: "porous
  // materials, not glass or metal").
  {
    id: 'bleaching', gas: 'glimmermist', with: { gas: 'chlorine' }, consume: 1, consumeOther: 1, chance: 0.25,
    effect: { type: 'particles', particle: 'minecraft:white_ash', count: 8 }, bleach: { radius: 2 }
  },
  // R25: cold iron grounds zephyr, a layer at a time.
  { id: 'grounding', gas: 'zephyr', with: GAS_COLD_IRON, consume: 1, chance: 0.25 },
  // R26: zephyr over lava quenches into steam, layer for layer.
  { id: 'quenching_wind', gas: 'zephyr', with: { fluid: '#minecraft:lava' }, consume: 'all', result: { gas: 'steam', layers: 'same' } },
  // R27: zephyr thins firedamp: one layer of each.
  { id: 'ventilation', gas: 'firedamp', with: { gas: 'zephyr' }, consume: 1, consumeOther: 1, chance: 0.25 },
  // R28: condensate on lava flash-boils into steam, 2 layers per layer (as R6: at most 8 in the cell, the rest spills).
  { id: 'flash_boil', gas: 'condensate', with: { fluid: '#minecraft:lava' }, consume: 'all', result: { gas: 'steam', ratio: 2 } },
  // --- Block results (slice 3). The carbon dioxide rules (R29 to R31) use no gas.
  // R29: carbon dioxide smothers fire: the fire becomes air.
  { id: 'smothering', gas: 'carbon_dioxide', with: GAS_FLAME_FIRE, consume: 0, result: { block: 'minecraft:air', at: 'partner' }, chance: 0.5 },
  // R30: carbon dioxide snuffs lit campfires and candles (lit: false; facing, candles and the rest kept).
  { id: 'snuffing', gas: 'carbon_dioxide', with: GAS_FLAME_LIT, consume: 0, result: { state: { lit: false }, at: 'partner' }, chance: 0.5 },
  // R31: carbon dioxide feeds a crop that is still growing (vanilla's crop tag and AgriCraft's crop sticks) one random
  // tick. A crop's own random tick decides whether it grows (vanilla crops need light 9 or more).
  {
    id: 'fertilizing', gas: 'carbon_dioxide', with: [{ block: '#minecraft:crops', growing: true }, { block: 'agricraft:crop', growing: true }],
    consume: 0, result: { tick: 1, at: 'partner' }, chance: 0.2
  },
  // R32: rime freezes a water source into ice and loses 2 layers.
  { id: 'freezing', gas: 'rime', with: { fluid: '#minecraft:water', source: true }, consume: 2, result: { block: 'minecraft:ice', at: 'partner' }, chance: 0.25 },
  // R33: a full condensate cell beside rime freezes into ice (the cell becomes the block), and the rime loses a layer.
  { id: 'ice_formation', gas: 'condensate', with: { gas: 'rime' }, minLayers: 8, consume: 8, consumeOther: 1, result: { block: 'minecraft:ice', at: 'self' } },
  // --- Condition rules (slice 4, K6): no neighbour, the rule fires on a place or a time (the conditions are listed at the
  // top of this table). The author's calls, 2026-11-19: open sky counts all non-stained glass (plain glass and panes) as
  // open; stained glass shades (the tag faetouched:sky_shade); tinted glass is a roof (it passes no light); R36 needs a
  // storm, so glass and iron bars shelter firedamp; R38 cools scalding steam over time and never in ultrawarm dimensions.
  // R34: rime in a warm biome sublimes one layer into steam, now and then (2% a check, so about 25 s a layer).
  { id: 'sublimation', gas: 'rime', with: { condition: 'warm' }, consume: 1, result: { gas: 'steam', layers: 'same' }, chance: 0.02 },
  // R35: glimmermist under open sky by day fades a layer (20% a check): unhooded mist fades from dawn, under clear glass too.
  { id: 'fading', gas: 'glimmermist', with: [{ condition: 'sky' }, { condition: 'day' }], consume: 1, chance: 0.2 },
  // R36: firedamp in a thunderstorm flashes as R16 does (2% a check): carbon dioxide 2:1, a weak flash that breaks
  // nothing and primes the gas it reaches.
  {
    id: 'thunder_flash', gas: 'firedamp', with: { condition: 'storm' }, consume: 'all', result: { gas: 'carbon_dioxide', ratio: 0.5 },
    effect: { type: 'explode', powerPerLayer: 0.15, maxPower: 1.2, fire: false, mode: 'none' }, chance: 0.02
  },
  // R39, before R37: scalding steam melts plain ice into a water source and loses a layer; packed and blue ice hold
  // (they aren't minecraft:ice), so R37 cools the steam beside them instead. The water then cools the rest (R37).
  { id: 'ice_melt', gas: 'scalding_steam', with: { block: 'minecraft:ice' }, consume: 1, result: { fluid: 'minecraft:water', at: 'partner' } },
  // R37: scalding steam cools into steam at once beside water, ice, rime or condensate; the partners aren't used.
  {
    id: 'cooling', gas: 'scalding_steam',
    with: [{ fluid: '#minecraft:water' }, { block: '#minecraft:ice' }, { gas: 'rime' }, { gas: 'condensate' }],
    consume: 'all', result: { gas: 'steam', layers: 'same' }
  },
  // R38, after R37 (slice 4): scalding steam cools into steam on its own: 5% a check, and a settled cell checks every 10
  // ticks, so it lasts about 10 s (a moving cell checks at each update, so a burst cools sooner as it climbs). Never in
  // an ultrawarm dimension. It only ever cools: steam becomes scalding again only at an open flame (R40) or from a machine.
  {
    id: 'slow_cooling', gas: 'scalding_steam', with: { condition: 'always' }, skipUltraWarm: true,
    consume: 'all', result: { gas: 'steam', layers: 'same' }, chance: 0.05
  },
  // R40: steam drifting past an open flame turns scalding, layer for layer.
  { id: 'scorching', gas: 'steam', with: GAS_OPEN_FLAME, consume: 'all', result: { gas: 'scalding_steam', layers: 'same' }, chance: 0.25 }
]

// --- Quest-gas slice 5: intake by collector (K3), blocks that read gas (K2), masks and detectors (K5) ---

// K3, intake by collector: a gas collector (faetouched:gas_collector) with a listed block against one of its six faces draws
// the gas into its tank, now and then, where the block's place allows it. Nothing appears in the world and the block isn't
// used up. The author's call, 2026-11-19: rime never forms natural clouds, it comes from ice this way, and "snowy" keeps it
// regional (a collector in a frozen hollow, piped out); no reaction produces an item, only a machine does.
//   id: the entry's name (/gas debug rule <id> builds its chamber).
//   gas: the gas key the tank gets (the tank must be empty or hold that gas, and have room for a layer, 125 mB).
//   block: block ID or '#tag' of the block a collector face touches.
//   every: ticks between layers on average, per face. The collector acts every 10 ticks (its block entity's tickFrequency), so
//     each action a face gives a layer with chance 10 / every: blue ice 200 is a layer per 10 s, packed ice 800 per 40 s.
//   conditions: names from the condition list above, ANDed, read at the block (not the collector) once the roll is won.
//   Several faces each roll; the collector's tank and rate (4000 mB, every 10 ticks) are unchanged.
var GAS_INTAKES = [
  { id: 'rime_blue_ice', gas: 'rime', block: 'minecraft:blue_ice', every: 200, conditions: ['snowy'] },
  { id: 'rime_packed_ice', gas: 'rime', block: 'minecraft:packed_ice', every: 800, conditions: ['snowy'] }
]

// K2, blocks that read the gas lying against them. Empty until the professions' machines exist (the annealing bed, the steam
// hood, the cold and chill heats and the rest; knowledge/systems/gases.md lists them): a machine adds one entry here, and its
// block gets the reading with no script of its own. The server script polls each entry's block, at most one reading every
// `every` ticks per block, and reports through the block entity's data and, if asked, a block state property.
//   id: the entry's name (/gas debug rule <id> builds its chamber).
//   block: the block ID. It must be a KubeJS block entity block that ticks (.blockEntity(be => be.serverTicking())): the
//     poll is that block's tick. A block ID that doesn't exist drops the entry with a warning.
//   gas: a gas key or a list of keys: any of them counts.
//   faces: the faces read, from 'up', 'down', 'north', 'east', 'south', 'west' (default all six): the gas cell touching
//     that face of the block. At most six reads a poll.
//   minLayers (default 1): layers a face's cell needs to count. minFaces (default 1): faces that must count for the reading
//     to be met.
//   spend (default 0): layers the reading takes out of the cells it read when it is met, fullest cell first (a pressing
//     spends a layer of the cold heat's rime); a reading with fewer layers than that isn't met and takes nothing.
//   every (default and least 20): ticks between readings of one block.
//   property: optional name of a boolean block state property of the block, set true when the reading is met and false when
//     not. The reading is also kept in the block entity's data: faetouched_gas_sense_<id> (boolean) and
//     faetouched_gas_layers_<id> (the layers read), for the block's own script. The server script also has gasSense(level,
//     pos, gasSenseSpec(entry)) for a machine's own tick, which returns { met, faces, layers, spent }.
var GAS_SENSORS = []

// K5, masks (the author's call, 2026-11-19: the Beaked Mask lets the wearer breathe in bog miasma and chlorine). Item ID ->
// gas keys whose effects (mob effects and damage) the wearer takes no more of. Worn means in the head armor slot, or in a
// Curios head slot (the item is in the item tag curios:head, server script). Effects the wearer already has run out.
var GAS_MASKS = { 'faetouched:beaked_mask': ['bog_miasma', 'chlorine'] }
// K5, detectors (the Sapper's Safety Lamp: it burns blue in firedamp and gutters in carbon dioxide, and never lights either).
// Item ID -> gas key -> signal. Held in either hand, the lamp reads the gas around the player once a second (server script):
// 'blue' turns the lamp's model blue (the item's custom model data 1) and says so on the action bar, 'gutter' says the flame
// gutters, with smoke. The lamp is no open flame (GAS_OPEN_FLAME), so firedamp never flashes at it.
var GAS_DETECTORS = { 'faetouched:safety_lamp': { firedamp: 'blue', carbon_dioxide: 'gutter' } }

// Bleaching (a reaction's `bleach: { radius }`, R24): the dyed porous blocks a firing turns plain, every block within the
// radius (a sphere, dx² + dy² + dz² <= radius²) of the reacting cell. Tried in order; the first entry whose `from` (block
// ID or '#tag') matches wins.
//   to: the plain block it becomes (its default state; these blocks have no state properties). A block already `to` is
//     skipped, with no write.
//   except: block IDs in the tag that stay (cattail thatch is plant thatch, not dyed wool).
// Members checked in reference/dumps/full/tags.txt (2026-11-20): #minecraft:wool and #minecraft:terracotta are the 16 wools
// and the 17 terracottas (plain terracotta, already plain, is skipped); #minecraft:wool_carpets the 16 carpets, Twilight
// Forest's coronation carpet and Biomes We've Gone's cattail thatch carpet; #c:concretes the 16 concretes; concrete powder has
// no c: block tag (#c:concrete_powders is an item tag), so vanilla's #minecraft:concrete_powder (the 16 powders). None of
// them is glass, metal, a candle or a block entity; the server script also skips any block entity a mod adds to a tag.
var GAS_BLEACH = [
  { from: '#minecraft:wool', to: 'minecraft:white_wool' },
  { from: '#minecraft:wool_carpets', to: 'minecraft:white_carpet', except: ['biomeswevegone:cattail_thatch_carpet'] },
  { from: '#minecraft:terracotta', to: 'minecraft:terracotta' },
  { from: '#c:concretes', to: 'minecraft:white_concrete' },
  { from: '#minecraft:concrete_powder', to: 'minecraft:white_concrete_powder' }
]

global.faetouchedGases = GAS_TABLE
global.faetouchedGasBleach = GAS_BLEACH
global.faetouchedGasReactions = GAS_REACTIONS
global.faetouchedGasIntakes = GAS_INTAKES
global.faetouchedGasSensors = GAS_SENSORS
global.faetouchedGasMasks = GAS_MASKS
global.faetouchedGasDetectors = GAS_DETECTORS
// Maps keyed by dimension use the dimension ID (a ResourceLocation, from KubeJS's level.getDimension()).
// Simulation queue, per dimension: TreeMap<due game time, ArrayDeque<BlockPos>> and the
// HashSet<BlockPos> of queued positions. Filled and drained by the server script.
global.faetouchedGasQueues = new GasHashMap()
global.faetouchedGasMembers = new GasHashMap()
// Positions woken by random ticks, as entries (level, pos); the server tick moves them into the queue.
global.faetouchedGasInbox = new GasArrayDeque()
// Create open pipe ends: dimension -> BlockPos (output cell) -> Fluid -> mB not yet placed.
global.faetouchedGasPipe = new GasHashMap()
// Cells an explosion reached that will ignite on their next update: dimension -> HashSet<BlockPos>.
global.faetouchedGasPrimed = new GasHashMap()
// Small shared counters (the ignitions of the current tick), so both loaded copies of the server script agree.
global.faetouchedGasState = new GasHashMap()
// Full cells of a gas that settles, with the game time each was first seen full and still:
// dimension -> HashMap<BlockPos, game time>.
global.faetouchedGasSettle = new GasHashMap()
// Fans and nozzles (prototypes/gases/specs/spec-fans-pumps.md), all keyed by dimension and filled by the server script: fans
// for the airflow tick to look at now (HashSet<BlockPos>: a fan or nozzle placed, or gas written into an idle fan's current;
// the fans' records stay in the server script's tick copy), the cells a current or nozzle holds (BlockPos -> game time held
// until), and the cells of every idle fan's straight current (BlockPos -> the fan's BlockPos).
global.faetouchedGasFans = new GasHashMap()
global.faetouchedGasHeld = new GasHashMap()
global.faetouchedGasCurrentCells = new GasHashMap()

var GAS_INBOX = global.faetouchedGasInbox
var GAS_PIPE = global.faetouchedGasPipe
var GAS_INBOX_MAX = 8192
var GAS_EFFECT_REFRESH = 40 // ticks: an effect with this much left or less is applied again

function gasId(path) { return 'faetouched' + ':' + path }

// Effect holders, looked up once per effect on first use (the registry is complete by then). If the lookup fails,
// the ID itself is kept, and KubeJS converts it on every call.
var GAS_EFFECT_HOLDERS = {}
function gasEffectHolder(id) {
  var h = GAS_EFFECT_HOLDERS[id]
  if (h === undefined) {
    try {
      var reg = Registry.of('minecraft:mob_effect')
      h = reg.registry().wrapAsHolder(reg.get(id))
    } catch (err) {
      console.warn('faetouched gases: no holder for effect ' + id + ', using the ID (' + err + ')')
      h = id
    }
    GAS_EFFECT_HOLDERS[id] = h
  }
  return h
}

// Masks (K5): gas key -> the item IDs that protect from it, built once from GAS_MASKS.
var GAS_MASKED = {}
Object.keys(GAS_MASKS).forEach(function (itemId) {
  GAS_MASKS[itemId].forEach(function (key) {
    if (GAS_MASKED[key] === undefined) GAS_MASKED[key] = []
    GAS_MASKED[key].push(itemId)
  })
})
// Is the entity wearing one of the items (IDs)? The head armor slot (KubeJS's headArmorItem, any living entity), else, for a
// player, a Curios slot (CuriosApi.getCuriosInventory(entity) is an Optional of the handler). The handler's isEquipped has an
// Item overload and a Predicate overload; a JS function would bind the Item one (Rhino scores a value 0 for a type KubeJS wraps,
// a function only 1 for a functional interface) and throw a plain exception in argument conversion that no script catch takes, so
// the mask IDs are passed as strings, one call each. If Curios can't be reached, the lookup fails once and the mask counts as
// not worn there.
var GAS_CURIOS_API = null
function gasWearing(ent, itemIds) {
  var head = ent.headArmorItem
  if (head != null && !head.isEmpty() && itemIds.indexOf(String(head.id)) >= 0) return true
  if (!ent.isPlayer() || GAS_CURIOS_API === false) return false
  try {
    if (GAS_CURIOS_API == null) GAS_CURIOS_API = Java.loadClass('top.theillusivec4.curios.api.CuriosApi')
    var inv = GAS_CURIOS_API.getCuriosInventory(ent)
    if (!inv.isPresent()) return false
    var handler = inv.get()
    for (var i = 0; i < itemIds.length; i++) if (handler.isEquipped(itemIds[i]) == true) return true
    return false
  } catch (err) {
    console.warn('faetouched gases: the Curios lookup for masks failed (' + err + '); masks count only in the head armor slot')
    GAS_CURIOS_API = false
    return false
  }
}
// An entity inside a cloud of gas `key` that wears a mask for it takes none of its effects. The answer is kept per entity
// for 10 ticks, so a masked player standing in a cloud isn't looked up every tick.
var GAS_MASK_CACHE = {}
var GAS_MASK_CACHE_TICKS = 10
function gasMasked(cb, ent, key) {
  var ids = GAS_MASKED[key]
  if (ids === undefined) return false
  var now = Number(cb.level.getLevelData().getGameTime())
  // KubeJS's EntityMixin renames Entity.getStringUUID() to getStringUuid() for scripts (@RemapForJS, read with javap -v), so
  // getUUID() and getStringUUID() don't exist there.
  var ck = String(ent.getStringUuid()) + ' ' + key
  var hit = GAS_MASK_CACHE[ck]
  // now >= hit.t: the cache lives for the whole launch, and game time starts again in each world.
  if (hit !== undefined && now >= hit.t && now - hit.t < GAS_MASK_CACHE_TICKS) return hit.v
  if (Object.keys(GAS_MASK_CACHE).length > 256) GAS_MASK_CACHE = {}
  var v = gasWearing(ent, ids)
  GAS_MASK_CACHE[ck] = { t: now, v: v }
  return v
}

// Called for every entity inside a cloud cell, every tick: tops up each effect once it runs low, so it isn't
// reapplied every tick, and deals each damage entry at most once per `every` ticks. A mask for the gas (K5) ends all of it.
function gasApplyEffects(cb, key, effects) {
  if (cb.level.isClientSide()) return
  var ent = cb.entity
  if (!ent.isLiving()) return
  if (gasMasked(cb, ent, key)) return
  var pe = null
  for (var i = 0; i < effects.length; i++) {
    var ef = effects[i]
    if (ef.damage !== undefined) { gasApplyDamage(cb, ent, ef); continue }
    if (pe == null) pe = ent.getPotionEffects()
    var h = gasEffectHolder(ef.id)
    if (pe.getDuration(h) <= GAS_EFFECT_REFRESH) pe.add(h, ef.seconds * 20, ef.amplifier)
  }
}

// Damage (scalding steam): the game time of the entity's last hit is kept in its persistent data, so one entity takes
// at most one hit per `every` ticks however many cells it stands in. KubeJS turns the damage type ID into a damage
// source (its DamageSource type wrapper); vanilla then applies Fire Resistance and fire immunity for
// #minecraft:is_fire types such as minecraft:hot_floor, and its own hurt cooldown.
var GAS_DAMAGE_KEY = 'faetouched_gas_damage_at'
function gasApplyDamage(cb, ent, ef) {
  var now = Number(cb.level.getLevelData().getGameTime()) // Level.getGameTime() is hidden from scripts (LevelMixin)
  var every = ef.every !== undefined ? Number(ef.every) : 10
  var pd = ent.persistentData
  if (pd.contains(GAS_DAMAGE_KEY) && now - Number(pd.getLong(GAS_DAMAGE_KEY)) < every) return
  pd.putLong(GAS_DAMAGE_KEY, now)
  ent.attack(ef.damage, ef.amount)
}

StartupEvents.registry('fluid', e => {
  GAS_TABLE.forEach(g => {
    // 'thin' uses KubeJS's own thin still and flowing textures, tinted. No block, no bucket: gases live in
    // pipes, tanks and machines, and in the world only as cloud blocks.
    e.create(gasId(g.key), 'thin')
      .tint(g.tint)
      .noBlock()
      .noBucket()
      .type(t => t.density(g.density).temperature(g.temperature))
      .displayName(g.name)
  })
  // Fluids that quest-gas reactions make (slice 2), with a block and a bucket, KubeJS's own tinted textures (no art):
  // vitriol (R8; R19 through vitriol condensate), moonwater (R9, R10 through moonwater condensate) and vermilion (R20 through
  // vermilion condensate, pressed into cinnabar by a Create compactor). Quicksilver (R11, R12 through quicksilver
  // condensate) is made in startup_scripts/faetouched_metals.js. Each condensate gas settles into one of them and its
  // cloud models use the fluid's still texture (thin_fluid_still for moonwater and vitriol, thick_fluid_still for vermilion
  // and quicksilver, both KubeJS's own) with the fluid's tint.
  e.create(gasId('vitriol'), 'thin').tint(0xC8D86A).displayName('Vitriol')
  e.create(gasId('moonwater'), 'thin').tint(0xD8D0FF).displayName('Moonwater')
  e.create(gasId('vermilion'), 'thick').tint(0xC8302C).displayName('Vermilion')
})

// The structure void's properties, which the clouds start from (below), looked up once.
var GAS_CLOUD_BASE = null

StartupEvents.registry('block', e => {
  if (GAS_CLOUD_BASE == null) GAS_CLOUD_BASE = Block.getBlock('minecraft:structure_void')
  GAS_TABLE.forEach(g => {
    // 1 layer = 125 mB of the gas. Rising gases hang from the top of the cell, sinking gases sit on the floor.
    var cloud = e.create(gasId(g.key + '_cloud'))
      // Replaceable (the author's call, 2026-11-20), so Create's open pipe ends top up a cell holding gas (OpenEndedPipe
      // needs a replaceable or waterloggable target). KubeJS's builder has no replaceable switch: copyPropertiesFrom(Block)
      // makes KubeJSBlockProperties copy every field of that block's BlockBehaviour$Properties by reflection, then applies the
      // builder's own settings (createProperties, read in the 2101.7.2 jar): sound, strength, light, noCollision, noOcclusion,
      // noLootTable, spawns, suffocating and view blocking below all win. What the structure void brings that the builder
      // doesn't set: replaceable; pushReaction DESTROY (a piston destroys gas); noTerrainParticles. The consequences, accepted:
      // sand and gravel fall through gas and destroy the cell they land in, sculk veins and nether portals may replace it.
      .copyPropertiesFrom(GAS_CLOUD_BASE)
      .displayName(g.name)
      .property(BlockProperties.LAYERS)
      .defaultTranslucent()
      // defaultTranslucent() (through defaultCutout()) sets transparent(true), and KubeJS's BasicKubeBlock.skipRendering
      // then culls every face toward a neighbour of the same block, whatever its layers, so the side of a taller cell beside a
      // shorter one of the same gas vanished (a stepped sheet with open sides). transparent(false) gives vanilla's
      // skipRendering (never), getShadeBrightness and getVisualShape, and BasicKubeBlock's own propagatesSkylightDown (true
      // unless waterlogged), which match for this block anyway (no collision, an empty shape). Vanilla's Block.shouldRenderFace returns true at once for a state whose own
      // face occlusion shape is empty, as this block's is, so the sides toward solid blocks were drawn before this change
      // too (they face into the solid, away from the cloud, and nothing changes there); the cost is that the faces between
      // two equal cells are drawn as well (two coincident translucent faces, each facing one way).
      .transparent(false)
      .notSolid()
      .noCollision()
      .box(0, 0, 0, 0, 0, 0) // empty outline: players target the blocks behind the gas
      .suffocating(false)
      .viewBlocking(false)
      .noValidSpawns(true)
      .canBeReplaced(c => true)
      .noItem()
      .noDrops()
      .noSoundType()
      .resistance(0) // explosions pass through and reach the cloud (hydrogen chains)
      .lightLevel(g.light)
      .color(0, g.tint)
      // The queue is not saved, so a random tick puts the block back into it (after restarts and /reload).
      .randomTick(cb => {
        if (GAS_INBOX.size() < GAS_INBOX_MAX) GAS_INBOX.add(new GasEntry(cb.level, cb.block.pos.immutable()))
      })
    var effects = g.effects
    if (effects.length > 0) cloud.entityInside(cb => gasApplyEffects(cb, g.key, effects))
  })

  // Gas vent (faetouched:gas_vent): not registered here. It is a Multiblocked2 kinetic machine (spec-kinetic-vent,
  // 2026-11-21), so it joins the Create shaft network through its front and back like any Create block (placement, stress,
  // the spinning shaft), which no KubeJS block can (KubeJS Create 2101.3.1 makes no kinetic blocks; the old vent only read
  // a neighbouring shaft's speed). Its spec is mbd2/machines/gas_vent.json, written by tools/mbd2-gen.js to
  // minecraft/ldlib2/assets/mbd2/create_machine/gas_vent.cm; its model is kubejs/assets/faetouched/models/block/
  // gas_vent_kinetic.json and its name the lang file's block.faetouched.gas_vent. MBD2 registers the block, its item and its
  // block entity type under the same id, so registering it here too is a duplicate-registration error at startup. MBD2
  // drops the machine item itself (dropMachineItem): never add a faetouched:blocks/gas_vent loot table (two drops). Its
  // release logic, tank view and pickaxe tag: server_scripts/faetouched_gases.js.

  // Gas collector: draws one layer from every neighbouring cloud block into its tank, one gas at a time.
  // Its tank takes Direction.EMPTY_SET, which KubeJS's KubeEntityCapabilityProvider reads as every side and also the null
  // side; with ALL_SET a null side got nothing, and Jade asks for a block's fluid capability with a null side, so it showed
  // no tank (2026-11-20). Pipes ask with a side, and get the tank either way.
  // The empty rightClick (the author's report 2026-11-21): with a rightClick callback, KubeJS's
  // BasicKubeBlock.useItemOn answers SUCCESS on the client too (the callback runs only on the server), so the client takes the
  // click as used and doesn't predict placing a held block against it (the placement sound with nothing placed) or send an
  // item use. Without one it passes, and the client places the block locally until the server says no. Sneaking with an item
  // skips the block's use in vanilla, so placing against it while sneaking still works. The screen itself is opened by the
  // server script's BlockEvents.rightClicked, which cancels before this callback is reached.
  // The 'filter' inventory (spec-tank-view): one slot for an imprinted gas filter (the predicate takes no other item), seen
  // in the right-click screen and reached by hoppers and funnels from the top and bottom faces only. A non-empty side set
  // isn't served on the null side, so Jade shows the tank but not the filter. The predicate is a function, not the item's ID:
  // KubeJS reads an ID string at once through the item registry, and blocks register before items, so the filter item doesn't
  // exist yet here (a startup error, and the collector would get no slot and no tick). A function is only called when an
  // item is tested, in game.
  e.create(gasId('gas_collector'))
    .displayName('Gas Collector')
    .hardness(3).resistance(6).requiresTool(true)
    .soundType(SoundType.COPPER)
    .tagBlock('minecraft:mineable/pickaxe')
    .rightClick(e => {})
    .blockEntity(be => {
      be.fluidTank('tank', Direction.EMPTY_SET, 4000, '#faetouched:gases')
      be.inventory('filter', gasSides([Direction.UP, Direction.DOWN]), 1, 1, st => String(st.id) == gasId('gas_filter_imprinted'))
      be.serverTicking()
      be.tickFrequency(10)
    })
})

// Gear (quest-gas slice 5, K5): the Beaked Mask and the Sapper's Safety Lamp, with no recipes yet (the professions' quest
// rewards make them: the mask the Beaked Mask quest, the lamp the Sapper's Gallery). Textures and models: kubejs/assets/
// faetouched/ (placeholders; the lamp's model switches to safety_lamp_blue at custom model data 1). What they do is in
// GAS_MASKS and GAS_DETECTORS above; the mask goes in the item tag curios:head (server script).
// Gas filters (spec-fans-pumps): a blank filter, imprinted by right-clicking a gas in the world (it takes one layer), and the
// imprinted filter, which holds the gas key in its custom data (faetouched_gas) and goes into a gas collector so it takes only
// that gas (server script). Two items, so recipes and EMI tell them apart. Placeholder textures from tools/placeholder-art.mjs;
// KubeJS makes their plain item models.
StartupEvents.registry('item', e => {
  e.create(gasId('beaked_mask')).displayName('Beaked Mask').maxStackSize(1)
  e.create(gasId('safety_lamp')).displayName("Sapper's Safety Lamp").maxStackSize(1)
  e.create(gasId('gas_filter')).displayName('Gas Filter').maxStackSize(16)
  e.create(gasId('gas_filter_imprinted')).displayName('Imprinted Gas Filter').maxStackSize(1)
})

// Create open pipe ends releasing a gas (KubeJS Create 2101.3.1). Create hands over about 1 mB per tick per open
// end while the output cell is replaceable or air; since the clouds are replaceable (2026-11-20) that includes a cell holding
// gas, so there is no backpressure any more. The handler only counts the mB; the server tick turns every full 125 mB into a
// layer at the output cell with gasAdd and keeps the remainder, which has no cap: where gasAdd finds no room (a full cell, or
// another gas with no room beside it) the count grows while the pipe drains (an open question in knowledge/systems/gases.md).
CreateEvents.pipeFluidEffect(e => {
  e.add('#faetouched:gases', (level, aabb, stack) => {
    if (level.isClientSide()) return
    var amount = stack.getAmount()
    if (amount <= 0) return
    var dim = level.getDimension()
    var byPos = GAS_PIPE.get(dim)
    if (byPos == null) { byPos = new GasHashMap(); GAS_PIPE.put(dim, byPos) }
    // The area is the output cell stretched one block down (two when the pipe faces down).
    var pos = BlockPos.containing(aabb.minX, aabb.maxY - 1, aabb.minZ)
    var byFluid = byPos.get(pos)
    if (byFluid == null) { byFluid = new GasHashMap(); byPos.put(pos, byFluid) }
    var fluid = stack.getFluid()
    var had = byFluid.get(fluid)
    byFluid.put(fluid, (had == null ? 0 : had) + amount)
  })
})
