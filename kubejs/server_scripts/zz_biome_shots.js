// Biome shots for the visualizer's biome bubbles (B-024, decision 0010).
// The server half: picks the biomes, finds each one, places the camera and
// teleports the player; client_scripts/biome_shots.js waits for the view to
// render and saves the screenshot. The two halves talk through global.biomeShots,
// a map made by startup_scripts/biome_shots.js (only startup scripts may assign to global).
//
// Commands (op): /biomeshots start [filter]  resume the run (filter: parts of biome IDs, comma-separated)
//                /biomeshots stop | status
//                /biomeshots redo <filter>   shoot the matching biomes again (same filter as start)
//                /biomeshots restart         forget every result and start over
//                /biomeshots reshoot <ids>   twelve new shots of each biome (exact IDs, comma-separated):
//                                            four in the middle of each of three places 10,000+ blocks apart
//                /biomeshots far [filter]    eight new shots of each biome: four at each of two such places (B-028).
//                                            No filter: BS_FAR_LIST. Filter as start. Resumes: biomes already searched are skipped
//                /biomeshots surface [filter] the same for BS_SURFACE_LIST, after TerraBlenderFix came off (B-028). Its own resume marker
// Output: minecraft/screenshots/fae-biome__<ns>__<path>__<n>.png (git-ignored; a reshoot's are __r<n>.png, far's __f<n>.png, surface's __s<n>.png)
//         minecraft/local/visualizer/biome-shots.json, the run log (git-ignored),
//         which the visualizer's dev server reads for the review page.
//
// Biome and dimension IDs come from the game at runtime; only BS_FAR_LIST names any.
// Rhino rejects const/let redeclared inside loop bodies, so this file uses var.

var BS_FILE = 'local/visualizer/biome-shots.json'
var BS_PREFIX = 'fae-biome__'
var BS_SECOND_SPOT = 1600       // the second spot is searched from this far out
var BS_SEARCH_RADIUS = 6400     // as /locate biome
var BS_MIN_SPOT_GAP = 256
var BS_FAR_SPOTS = 3            // a reshoot's places
var BS_FAR_PAIR = 2             // /biomeshots far's places
var BS_FAR_GAP = 10000          // how far apart they must be
var BS_PATCH = 320              // how far around a found spot its biome patch is measured
var BS_FAR_RINGS = [8000, 16000, 24000, 32000]      // searched from these distances out,
var BS_FAR_BEARINGS = [0, 120, 240, 60, 180, 300]   // the widest-spread bearings first
// What /biomeshots far shoots with no filter: every Terralith biome, and the kept
// vanilla biomes Terralith changes (their first shots show the old look).
var BS_FAR_LIST = ['terralith:', 'minecraft:cherry_grove', 'minecraft:dark_forest', 'minecraft:flower_forest',
  'minecraft:frozen_peaks', 'minecraft:frozen_ocean', 'minecraft:deep_frozen_ocean', 'minecraft:frozen_river',
  'minecraft:snowy_plains', 'minecraft:snowy_slopes', 'minecraft:savanna_plateau', 'minecraft:sunflower_plains',
  'minecraft:stony_shore', 'minecraft:mushroom_fields', 'minecraft:dripstone_caves', 'minecraft:lush_caves']
// What /biomeshots surface shoots with no filter: the biomes with ground of their own that
// TerraBlenderFix buried under Climate Rivers' grass, read from each mod's rules. Left out:
// ground hidden by snow or deep water in shots, and biomes that are off. Exact IDs.
var BS_SURFACE_LIST = [
  'biomeswevegone:atacama_outback', 'biomeswevegone:basalt_barrera', 'biomeswevegone:dacite_shore',
  'biomeswevegone:dead_sea', 'biomeswevegone:ebony_woods', 'biomeswevegone:enchanted_tangle',
  'biomeswevegone:forgotten_forest', 'biomeswevegone:fragment_jungle', 'biomeswevegone:ironwood_gour',
  'biomeswevegone:jacaranda_jungle', 'biomeswevegone:lush_stacks', 'biomeswevegone:pale_bog',
  'biomeswevegone:rainbow_beach', 'biomeswevegone:sakura_grove', 'biomeswevegone:skyris_vale',
  'biomeswevegone:weeping_witch_forest', 'biomeswevegone:white_mangrove_marshes', 'minecraft:beach',
  'minecraft:flower_forest', 'minecraft:mushroom_fields', 'minecraft:savanna_plateau',
  'minecraft:snowy_beach', 'minecraft:stony_shore', 'regions_unexplored:ancient_delta',
  'regions_unexplored:baobab_savanna', 'regions_unexplored:bayou', 'regions_unexplored:bioshroom_caves',
  'regions_unexplored:chalk_cliffs', 'regions_unexplored:cold_river', 'regions_unexplored:fungal_fen',
  'regions_unexplored:grassy_beach', 'regions_unexplored:joshua_desert', 'regions_unexplored:muddy_river',
  'regions_unexplored:prismachasm', 'regions_unexplored:redstone_caves', 'regions_unexplored:redwoods',
  'regions_unexplored:towering_cliffs', 'terralith:alpine_highlands', 'terralith:amethyst_canyon',
  'terralith:amethyst_rainforest', 'terralith:ancient_sands', 'terralith:arid_highlands',
  'terralith:ashen_savanna', 'terralith:basalt_cliffs', 'terralith:birch_taiga',
  'terralith:brushland', 'terralith:bryce_canyon', 'terralith:caldera',
  'terralith:cave/underground_jungle', 'terralith:cold_shrubland', 'terralith:desert_canyon',
  'terralith:desert_oasis', 'terralith:desert_spires', 'terralith:forested_highlands',
  'terralith:fractured_savanna', 'terralith:granite_cliffs', 'terralith:gravel_beach',
  'terralith:gravel_desert', 'terralith:highlands', 'terralith:hot_shrubland',
  'terralith:ice_marsh', 'terralith:lush_desert', 'terralith:orchid_swamp',
  'terralith:painted_mountains', 'terralith:red_oasis', 'terralith:rocky_mountains',
  'terralith:rocky_shrubland', 'terralith:sandstone_valley', 'terralith:savanna_badlands',
  'terralith:savanna_slopes', 'terralith:shield', 'terralith:shield_clearing',
  'terralith:shrubland', 'terralith:siberian_taiga', 'terralith:skylands_summer',
  'terralith:temperate_highlands', 'terralith:tropical_jungle', 'terralith:valley_clearing',
  'terralith:volcanic_crater', 'terralith:volcanic_peaks', 'terralith:warm_river',
  'terralith:warped_mesa', 'terralith:white_cliffs', 'terralith:white_mesa',
  'terralith:yellowstone']

var BsPredicate = Java.loadClass('java.util.function.Predicate')
var BsBlockPos = Java.loadClass('net.minecraft.core.BlockPos')
var BsLevel = Java.loadClass('net.minecraft.world.level.Level')
var BsHeightmap = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types')
var BsEffects = Java.loadClass('net.minecraft.world.effect.MobEffects')
var BsEffectInstance = Java.loadClass('net.minecraft.world.effect.MobEffectInstance')
var BsCommands = Java.loadClass('net.minecraft.commands.Commands')
var BsString = Java.loadClass('com.mojang.brigadier.arguments.StringArgumentType')
var BsJsonParser = Java.loadClass('com.google.gson.JsonParser')


// Server-side run state (this script only).
var bs = { running: false, reshoot: false, surface: false, farSpots: BS_FAR_SPOTS, player: null, queue: [], current: null, search: null, manifest: null, seq: 0, deadline: 0, tick: 0, biomes: null }

function bsShared() { return global.biomeShots }

// Creating a world loads this script twice: the commands stay with one copy and
// the tick loop runs in the other, each with its own bs. So a command only posts
// a request, as text in the shared map, and the tick loop acts on it: all run
// state stays in the copy that ticks. A reopened world loads once; this suits both.
var BS_NO_REQUEST = 'none'
bsShared().put('request', BS_NO_REQUEST)   // one left by an earlier world

function bsPost(request) { bsShared().put('request', JSON.stringify(request)) }

function bsLoad() {
  try {
    // A missing file reads as "null" (not an exception), so check the shape.
    var text = JsonIO.readString(BS_FILE)
    var log = text ? JSON.parse(String(text)) : null
    if (log && typeof log == 'object' && log.biomes && typeof log.biomes == 'object') return log
  } catch (e) { /* first run */ }
  return { version: 1, biomes: {} }
}

function bsSave() {
  if (!bs.manifest) return
  bs.manifest.updatedAt = new Date().toISOString()
  try {
    JsonIO.write(BS_FILE, BsJsonParser.parseString(JSON.stringify(bs.manifest)))
  } catch (e) {
    console.error('[biomeshots] could not write ' + BS_FILE + ': ' + e)
  }
}

function bsId(holder) { return String(holder.unwrapKey().get().location()) }

// Every biome some dimension's biome source can place: id -> { holder, dim, level }.
// Dimensions sort overworld, Nether, End, then the rest.
function bsBiomes(server) {
  var out = {}
  var order = []
  server.getAllLevels().forEach(function (level) {
    var dim = String(level.getDimension())
    try {
      level.getChunkSource().getGenerator().getBiomeSource().possibleBiomes().forEach(function (h) {
        var id = bsId(h)
        if (out[id]) return
        out[id] = { holder: h, dim: dim, level: level }
        order.push(id)
      })
    } catch (e) {
      console.error('[biomeshots] biome source of ' + dim + ' unreadable: ' + e)
    }
  })
  var first = [String(BsLevel.OVERWORLD.location()), String(BsLevel.NETHER.location()), String(BsLevel.END.location())]
  var rank = function (dim) { var i = first.indexOf(dim); return i < 0 ? first.length : i }
  order.sort(function (a, b) {
    var d = rank(out[a].dim) - rank(out[b].dim)
    if (d != 0) return d
    if (out[a].dim != out[b].dim) return out[a].dim < out[b].dim ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  })
  return { byId: out, order: order }
}

function bsBiomeAt(level, x, y, z) { return bsId(level.getBiome(new BsBlockPos(Math.floor(x), Math.floor(y), Math.floor(z)))) }

function bsNoiseBiomeAt(level, x, y, z) { return bsId(level.getUncachedNoiseBiome(Math.floor(x) >> 2, Math.floor(y) >> 2, Math.floor(z) >> 2)) }

// getHeight does not generate chunks (an ungenerated one reads as the world's
// floor), and the spots findClosestBiome3d returns are usually ungenerated,
// so load the chunk first. getBlockState already generates on demand.
function bsHeight(level, x, z) {
  level.getChunk(Math.floor(x) >> 4, Math.floor(z) >> 4)
  return level.getHeight(BsHeightmap.MOTION_BLOCKING, Math.floor(x), Math.floor(z))
}

// Minecraft's yaw: 0 faces +Z (south), 90 faces -X (west).
function bsDir(yaw) {
  var r = yaw * Math.PI / 180
  return { x: -Math.sin(r), z: Math.cos(r) }
}

function bsAngleGap(a, b) {
  var d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

// Up to four bearings, best first: the first two at least 90 degrees apart, the
// third and fourth at least 60 degrees from every other (90 can leave room for only three),
// from { yaw, score } pairs.
function bsBearings(scored) {
  scored.sort(function (a, b) { return b.score - a.score })
  var picked = []
  for (var i = 0; i < scored.length && picked.length < 4; i++) {
    var clear = true
    for (var j = 0; j < picked.length; j++) {
      if (bsAngleGap(scored[i].yaw, picked[j].yaw) < (picked.length < 2 ? 90 : 60)) clear = false
    }
    if (clear) picked.push(scored[i])
  }
  return picked
}

function bsFind(level, holder, x, y, z) {
  var found = level.findClosestBiome3d(BsPredicate.isEqual(holder), new BsBlockPos(x, y, z), BS_SEARCH_RADIUS, 32, 64)
  return found ? found.getFirst() : null
}

// A column near pos whose top block is in the biome, or null.
function bsSurfaceColumn(level, id, pos) {
  var min = level.getMinBuildHeight()
  var radii = [0, 16, 32, 48, 64]
  for (var ri = 0; ri < radii.length; ri++) {
    var steps = radii[ri] == 0 ? 1 : 8
    for (var k = 0; k < steps; k++) {
      var d = bsDir(k * 45)
      var x = Math.floor(pos.getX() + d.x * radii[ri])
      var z = Math.floor(pos.getZ() + d.z * radii[ri])
      var h = bsHeight(level, x, z)
      if (h > min + 1 && bsBiomeAt(level, x, h - 1, z) == id) return { x: x, y: h, z: z }
    }
  }
  return null
}

// Surface shots: face where the biome continues, sit above the ground and
// treetops behind the spot, and tilt down toward the ground 48 blocks out.
function bsSurfaceShots(level, id, col) {
  var scored = []
  for (var k = 0; k < 16; k++) {
    var yaw = k * 22.5
    var d = bsDir(yaw)
    var score = 0
    var radii = [24, 48, 80, 112]
    for (var ri = 0; ri < radii.length; ri++) {
      if (bsNoiseBiomeAt(level, col.x + d.x * radii[ri], col.y, col.z + d.z * radii[ri]) == id) score += 1
    }
    scored.push({ yaw: yaw, score: score })
  }
  var water = !level.getBlockState(new BsBlockPos(col.x, col.y - 1, col.z)).getFluidState().isEmpty()
  return bsBearings(scored).map(function (b) {
    var d = bsDir(b.yaw)
    var cx = col.x - d.x * 12
    var cz = col.z - d.z * 12
    var top = 0
    for (var ox = -2; ox <= 2; ox += 2) {
      for (var oz = -2; oz <= 2; oz += 2) top = Math.max(top, bsHeight(level, cx + ox, cz + oz))
    }
    for (var a = 0; a <= 24; a += 6) top = Math.max(top, bsHeight(level, cx + d.x * a, cz + d.z * a))
    var eye = top + 4
    var far = bsHeight(level, cx + d.x * 48, cz + d.z * 48)
    var pitch = Math.atan2(eye - far, 48) * 180 / Math.PI
    pitch = Math.max(water ? 14 : 8, Math.min(30, pitch))
    return { x: cx, eye: eye, z: cz, yaw: b.yaw, pitch: pitch, mode: water ? 'ocean' : 'surface' }
  })
}

function bsOpen(level, x, y, z) {
  var s = level.getBlockState(new BsBlockPos(x, y, z))
  return s.isAir() || !s.getFluidState().isEmpty()
}

function bsRay(level, x, y, z, dx, dy, dz, max) {
  for (var i = 1; i <= max; i++) {
    if (!bsOpen(level, Math.floor(x + dx * i), Math.floor(y + dy * i), Math.floor(z + dz * i))) return i - 1
  }
  return max
}

// Cave shots (and the Nether): the most open air cell of the biome near pos,
// facing its longest clear views.
function bsCaveShots(level, id, pos) {
  var min = level.getMinBuildHeight() + 2
  var max = level.getMaxBuildHeight() - 2
  // Under a ceiling (the Nether's bedrock roof) stay below the roof: the
  // biome search can return a point above it.
  if (level.dimensionType().hasCeiling()) max = Math.min(max, level.getLogicalHeight() - 8)
  var cy = Math.min(pos.getY(), max - 12)
  var dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.7, 0, 0.7], [-0.7, 0, 0.7], [0.7, 0, -0.7], [-0.7, 0, -0.7], [0, 1, 0], [0, -1, 0]]
  var best = null
  var tries = [[12, 3], [24, 4], [40, 6]]   // radius, step: wider and coarser until something opens up
  for (var t = 0; t < tries.length && (!best || best.open < 20); t++) {
    var r = tries[t][0]
    var step = tries[t][1]
    for (var ox = -r; ox <= r; ox += step) {
      for (var oy = -r; oy <= r; oy += step) {
        for (var oz = -r; oz <= r; oz += step) {
          var x = pos.getX() + ox
          var y = cy + oy
          var z = pos.getZ() + oz
          if (y < min || y > max) continue
          if (!level.getBlockState(new BsBlockPos(x, y, z)).isAir()) continue
          if (bsBiomeAt(level, x, y, z) != id) continue
          var open = 0
          for (var di = 0; di < dirs.length; di++) open += bsRay(level, x, y, z, dirs[di][0], dirs[di][1], dirs[di][2], 16)
          if (!best || open > best.open) best = { x: x, y: y, z: z, open: open }
        }
      }
    }
  }
  if (!best || best.open < 20) return []
  var scored = []
  for (var k = 0; k < 16; k++) {
    var yaw = k * 22.5
    var d = bsDir(yaw)
    var len = bsRay(level, best.x + 0.5, best.y + 0.5, best.z + 0.5, d.x, -0.15, d.z, 48)
    scored.push({ yaw: yaw, score: len })
  }
  return bsBearings(scored).map(function (b) {
    return { x: best.x + 0.5, eye: best.y + 0.5, z: best.z + 0.5, yaw: b.yaw, pitch: 8, mode: 'cave' }
  })
}

// The shots at a spot: from the surface, or from the open air of a cave or the
// Nether. With noVoid, a spot over nothing has none (the End's biomes reach out
// over the void, where the air would pass for a cave).
function bsShotsAt(level, id, pos, ceiling, noVoid) {
  var col = ceiling ? null : bsSurfaceColumn(level, id, pos)
  if (col) return bsSurfaceShots(level, id, col)
  if (noVoid && !ceiling && bsHeight(level, pos.getX(), pos.getZ()) <= level.getMinBuildHeight() + 1) return []
  return bsCaveShots(level, id, pos)
}

// The search returns the biome's nearest point, which is its edge: moves pos to
// the sample of the biome closest to the middle of the patch around it. Reads
// biome noise only, so nothing generates.
function bsInterior(level, id, pos) {
  var inside = []
  var sx = 0
  var sz = 0
  for (var ox = -BS_PATCH; ox <= BS_PATCH; ox += 32) {
    for (var oz = -BS_PATCH; oz <= BS_PATCH; oz += 32) {
      if (bsNoiseBiomeAt(level, pos.getX() + ox, pos.getY(), pos.getZ() + oz) != id) continue
      inside.push([pos.getX() + ox, pos.getZ() + oz])
      sx += pos.getX() + ox
      sz += pos.getZ() + oz
    }
  }
  if (inside.length == 0) return pos
  var mx = sx / inside.length
  var mz = sz / inside.length
  inside.sort(function (a, b) { return Math.abs(a[0] - mx) + Math.abs(a[1] - mz) - Math.abs(b[0] - mx) - Math.abs(b[1] - mz) })
  return new BsBlockPos(inside[0][0], pos.getY(), inside[0][1])
}

// A far search: a far run's or reshoot's places, found outward until bs.farSpots
// working spots at least BS_FAR_GAP apart turn up, or the rings run out. One search
// takes seconds and a rare biome needs all of them, minutes in a row, so the tick
// loop does one per tick: stop and saving get their turn in between. A search reads
// biome noise only. Chunks load all at once in bsFarPlan, in the tick the camera goes:
// loaded earlier, they sat unclaimed and began unloading before it arrived, and the run
// started dropping with unreadable chunk packets (2026-11-05, not proven).
function bsFarBegin(id) {
  var info = bs.biomes.byId[id]
  var ceiling = info.level.dimensionType().hasCeiling()
  bs.search = { id: id, info: info, ceiling: ceiling, originY: ceiling ? 64 : 96, step: 0, pending: [], planned: [], spots: [],
    entry: { dim: info.dim, status: 'done', shots: [], notes: [] } }
}

// Plans the shots at the places found so far, which loads their chunks. A place with
// no shots drops out, and the search carries on if it has rings left.
function bsFarPlan(f) {
  var level = f.info.level
  f.pending.forEach(function (p) {
    var shots = []
    try { shots = bsShotsAt(level, f.id, bsInterior(level, f.id, p), f.ceiling, true) } catch (e) { f.entry.notes.push('near ' + p.getX() + ' ' + p.getZ() + ': ' + e) }
    if (shots.length > 0) {
      f.planned.push(shots)
      f.spots.push(p)
    }
  })
  f.pending = []
}

// One search. The biome's finished entry when it was the last one needed, or null.
function bsFarStep(server) {
  var f = bs.search
  var level = f.info.level
  var perRing = BS_FAR_BEARINGS.length
  var d = bsDir(BS_FAR_BEARINGS[f.step % perRing])
  var ring = BS_FAR_RINGS[Math.floor(f.step / perRing)]
  f.step++
  var p = null
  try { p = bsFind(level, f.info.holder, Math.round(d.x * ring), f.originY, Math.round(d.z * ring)) } catch (e) { f.entry.notes.push('search failed: ' + e) }
  var taken = f.spots.concat(f.pending)
  var near = !p
  for (var si = 0; p && si < taken.length; si++) {
    if (Math.sqrt(Math.pow(taken[si].getX() - p.getX(), 2) + Math.pow(taken[si].getZ() - p.getZ(), 2)) < BS_FAR_GAP) near = true
  }
  if (!near) f.pending.push(p)
  var last = perRing * BS_FAR_RINGS.length
  if (f.spots.length + f.pending.length >= bs.farSpots || f.step >= last) bsFarPlan(f)
  if (f.planned.length < bs.farSpots && f.step < last) {
    if (f.step % perRing == 0) bsTell(server, f.id + ': searching, ' + f.step + ' of ' + last + ' done, ' + f.planned.length + ' of ' + bs.farSpots + ' places found')
    return null
  }
  if (f.planned.length < bs.farSpots) f.entry.notes.push('only ' + f.planned.length + ' of ' + bs.farSpots + ' places found ' + BS_FAR_GAP + ' blocks apart')
  bs.search = null
  return bsFinish(f.id, f.entry, f.planned)
}

// Four shots: two spots with two directions each, or four directions from a
// lone spot. A reshoot takes four at each of its far places instead (bsFarBegin).
function bsPlan(id) {
  var info = bs.biomes.byId[id]
  var level = info.level
  var entry = { dim: info.dim, status: 'done', shots: [], notes: [] }
  var ceiling = level.dimensionType().hasCeiling()
  var originY = ceiling ? 64 : 96
  var spots = []
  var origins = [[0, 0], [BS_SECOND_SPOT, BS_SECOND_SPOT]]
  for (var oi = 0; oi < origins.length; oi++) {
    var p = null
    try { p = bsFind(level, info.holder, origins[oi][0], originY, origins[oi][1]) } catch (e) { entry.notes.push('search failed: ' + e) }
    if (!p) continue
    var near = false
    for (var si = 0; si < spots.length; si++) {
      if (Math.abs(spots[si].getX() - p.getX()) + Math.abs(spots[si].getZ() - p.getZ()) < BS_MIN_SPOT_GAP) near = true
    }
    if (!near) spots.push(p)
  }
  if (spots.length == 0) {
    entry.status = 'notfound'
    return entry
  }
  // Each spot plans up to four directions; with two working spots each keeps
  // its best two, and a lone spot keeps all four, so a biome gets four shots.
  var planned = []
  for (var s = 0; s < spots.length; s++) {
    var shots = []
    try {
      shots = bsShotsAt(level, id, spots[s], ceiling, false)
      if (shots.length == 0) entry.notes.push('spot ' + (s + 1) + ': no open space')
    } catch (e) {
      entry.notes.push('spot ' + (s + 1) + ': ' + e)
    }
    if (shots.length > 0) planned.push(shots)
  }
  return bsFinish(id, entry, planned)
}

// Keeps each place's shots and names their files.
function bsFinish(id, entry, planned) {
  if (bs.reshoot && bs.farSpots == BS_FAR_PAIR) entry.far = planned.length   // a later far run skips any biome with this
  if (bs.surface) entry.surface = planned.length                             // and a surface run any with this
  var keep = planned.length > 1 && !bs.reshoot ? 2 : 4
  for (var pi = 0; pi < planned.length; pi++) {
    for (var j = 0; j < planned[pi].length && j < keep; j++) {
      planned[pi][j].spot = pi + 1
      entry.shots.push(planned[pi][j])
    }
  }
  var safe = id.replace(':', '__').replace(/\//g, '-')
  entry.shots.forEach(function (shot, i) {
    shot.n = i + 1
    shot.file = BS_PREFIX + safe + '__' + (bs.reshoot ? (bs.surface ? 's' : bs.farSpots == BS_FAR_PAIR ? 'f' : 'r') : '') + shot.n + '.png'
    shot.x = Math.round(shot.x * 10) / 10
    shot.eye = Math.round(shot.eye * 10) / 10
    shot.z = Math.round(shot.z * 10) / 10
    shot.pitch = Math.round(shot.pitch * 10) / 10
    shot.ok = false
  })
  if (entry.shots.length == 0) entry.status = 'noshots'
  return entry
}

// Night vision lights dark caves and forests, but it also bleaches the fog
// colour toward white, so dimensions with a ceiling (the Nether, which is lit
// anyway) go without. Endless (-1), with no particles or icon.
function bsNightVision(player, on) {
  if (on && !player.hasEffect(BsEffects.NIGHT_VISION)) player.addEffect(new BsEffectInstance(BsEffects.NIGHT_VISION, -1, 0, false, false))
  if (!on && player.hasEffect(BsEffects.NIGHT_VISION)) player.removeEffect(BsEffects.NIGHT_VISION)
}

// Puts the camera at the shot (in the current biome's dimension). Spectators'
// eyes are 1.62 above their feet. Pass the dimension ID: with a ServerLevel
// Rhino cannot choose between teleportTo(ServerLevel, ...) and KubeJS's teleportTo(ResourceLocation, ...).
function bsAim(player, shot) {
  player.teleportTo(bs.current.level.getDimension(), shot.x, shot.eye - 1.62, shot.z, shot.yaw, shot.pitch)
}

function bsTell(server, text) {
  var p = bs.player ? server.getPlayerList().getPlayerByName(bs.player) : null
  if (p) p.tell(text)
  console.info('[biomeshots] ' + text)
}

// fresh: shoot the matching biomes again whatever their status (with no
// filter, forget every result). reshoot: the filter is exact IDs, each shot at
// far places; the biome's old entry stays until its new shots are all taken.
// far: a reshoot at two places whose filter works as start's, BS_FAR_LIST if there's none.
// 'surface' is a far run with its own marker and names, BS_SURFACE_LIST if there's no filter.
function bsStart(server, playerName, filter, fresh, reshoot, far) {
  bs.biomes = bsBiomes(server)
  bs.manifest = bsLoad()
  if (fresh && !filter) bs.manifest.biomes = {}
  bs.player = playerName
  var parts = filter ? filter.split(',').map(function (s) { return s.trim() }).filter(function (s) { return s.length > 0 }) : []
  var surface = far == 'surface'
  var exact = surface && parts.length == 0
  if (far && parts.length == 0) parts = surface ? BS_SURFACE_LIST : BS_FAR_LIST
  bs.surface = surface
  bs.reshoot = !!reshoot
  bs.farSpots = far ? BS_FAR_PAIR : BS_FAR_SPOTS
  if (reshoot && !far) parts.forEach(function (p) { if (!bs.biomes.byId[p]) bsTell(server, 'Not a biome any dimension places: ' + p) })
  bs.queue = bs.biomes.order.filter(function (id) {
    if (reshoot && !far) return parts.indexOf(id) >= 0
    if (exact && parts.indexOf(id) < 0) return false
    if (parts.length && !parts.some(function (p) { return id.indexOf(p) >= 0 })) return false
    var e = bs.manifest.biomes[id]
    if (surface) return !e || e.surface == null
    if (far) return !e || e.far == null   // searched already: in the same world it would find the same
    return fresh || !e || e.status == 'pending'
  })
  bs.current = null
  bs.search = null
  bs.running = true
  var S = bsShared()
  S.put('phase', 'idle')
  S.put('active', 'yes')
  var setup = ['gamemode spectator ' + playerName,
    'gamerule doDaylightCycle false',
    'gamerule doWeatherCycle false',
    'time set noon',
    'weather clear']
  for (var i = 0; i < setup.length; i++) server.runCommandSilent(setup[i])
  bsTell(server, 'Biome shots: ' + bs.queue.length + ' biomes to go of ' + bs.biomes.order.length + '.')
}

function bsStop(server, why) {
  bs.running = false
  bs.search = null   // a biome still being searched is searched again next time
  if (bs.current) {
    // An unfinished biome is shot again next time.
    if (!bs.reshoot) bs.manifest.biomes[bs.current.id] = { dim: bs.current.entry.dim, status: 'pending', shots: [], notes: [] }
    bs.current = null
  }
  bsSave()
  var S = bsShared()
  S.put('phase', 'idle')
  S.put('active', 'no')
  var player = bs.player ? server.getPlayerList().getPlayerByName(bs.player) : null
  if (player) bsNightVision(player, false)
  bsTell(server, 'Biome shots stopped: ' + why)
}

function bsStatus() {
  var m = bs.manifest || bsLoad()
  var counts = {}
  Object.keys(m.biomes).forEach(function (id) {
    var s = m.biomes[id].status
    counts[s] = (counts[s] || 0) + 1
  })
  return JSON.stringify(counts) + (bs.running ? ', running, ' + bs.queue.length + ' left' : ', not running')
}

function bsRequest(server, r) {
  if (r.op == 'start') bsStart(server, r.player, r.filter, r.fresh, r.reshoot, r.far)
  if (r.op == 'stop') bsStop(server, 'stopped by command')
  if (r.op == 'status') {
    var p = server.getPlayerList().getPlayerByName(r.player)
    if (p) p.tell('Biome shots: ' + bsStatus())
  }
}

ServerEvents.tick(function (event) {
  var server = event.server
  var S = bsShared()
  var posted = String(S.get('request'))
  if (posted.charAt(0) == '{') {
    S.put('request', BS_NO_REQUEST)
    bsRequest(server, JSON.parse(posted))
  }
  if (!bs.running) return
  bs.tick++
  var phase = String(S.get('phase'))
  var player = server.getPlayerList().getPlayerByName(bs.player)
  if (!player) { bsStop(server, 'the player left'); return }

  if (phase == 'shoot') {
    // Re-aim every 10 ticks while the client waits: a teleport into another
    // dimension can leave the old view direction (a Nether shot faced straight down).
    if (bs.tick % 10 == 0) bsAim(player, bs.current.entry.shots[bs.current.idx - 1])
    if (bs.tick > bs.deadline) {
      bs.current.entry.notes.push('shot ' + bs.current.idx + ': no capture before the deadline')
      S.put('phase', 'idle')
    }
    return
  }
  if (phase == 'captured') {
    // No current biome: a capture that landed after its shot's deadline.
    if (bs.current) {
      var done = bs.current.entry.shots[bs.current.idx - 1]
      done.rendered = String(S.get('rendered'))
      done.ok = done.rendered != 'failed'
    }
    S.put('phase', 'idle')
  }

  if (bs.current && bs.current.idx >= bs.current.entry.shots.length) {
    bs.manifest.biomes[bs.current.id] = bs.current.entry
    bsSave()
    bs.current = null
  }
  while (!bs.current) {
    var id
    var entry
    if (bs.search) {
      id = bs.search.id
      entry = bsFarStep(server)
      if (!entry) return
    } else {
      if (bs.queue.length == 0) { bsStop(server, 'all done. ' + bsStatus()); return }
      id = bs.queue.shift()
      if (bs.reshoot) {
        bsFarBegin(id)
        return
      }
      entry = bsPlan(id)
    }
    bsTell(server, id + ': ' + entry.shots.length + ' shots' + (entry.notes.length ? ' (' + entry.notes.join('; ') + ')' : '') + ', ' + bs.queue.length + ' left')
    if (entry.shots.length == 0) {
      var kept = bs.manifest.biomes[id]
      if (bs.reshoot && bs.farSpots != BS_FAR_PAIR) continue   // it keeps the shots it has
      if (bs.reshoot && kept) {
        if (bs.surface) kept.surface = 0
        else kept.far = 0   // and a later run of the same kind doesn't search again
        bsSave()
        continue
      }
      bs.manifest.biomes[id] = entry
      bsSave()
      continue
    }
    bs.current = { id: id, entry: entry, idx: 0, lastSpot: 0, level: bs.biomes.byId[id].level }
  }

  var shot = bs.current.entry.shots[bs.current.idx]
  var newSpot = shot.spot != bs.current.lastSpot
  // player.level() is hidden by the level field in scripts; serverLevel() is not.
  var newDim = String(player.serverLevel().getDimension()) != bs.current.entry.dim
  bsNightVision(player, !bs.current.level.dimensionType().hasCeiling())
  bsAim(player, shot)
  bs.current.lastSpot = shot.spot
  bs.current.idx++
  bs.seq++
  S.put('file', shot.file)
  S.put('minTicks', newDim ? 140 : newSpot ? 80 : 12)
  S.put('seq', bs.seq)
  S.put('phase', 'shoot')
  bs.deadline = bs.tick + 1200
})

ServerEvents.commandRegistry(function (event) {
  var name = function (ctx) { return String(ctx.source.getPlayerOrException().getGameProfile().getName()) }
  var run = function (ctx, filter, fresh, reshoot, far) {
    bsPost({ op: 'start', player: name(ctx), filter: filter, fresh: !!fresh, reshoot: !!reshoot, far: far || false })
    return 1
  }
  var text = function (ctx, arg) { return String(BsString.getString(ctx, arg)) }
  event.register(BsCommands.literal('biomeshots')
    .requires(function (src) { return src.hasPermission(2) })
    .then(BsCommands.literal('start')
      .executes(function (ctx) { return run(ctx, null, false) })
      .then(BsCommands.argument('filter', BsString.greedyString())
        .executes(function (ctx) { return run(ctx, text(ctx, 'filter'), false) })))
    .then(BsCommands.literal('restart')
      .executes(function (ctx) { return run(ctx, null, true) }))
    .then(BsCommands.literal('stop')
      .executes(function (ctx) { bsPost({ op: 'stop' }); return 1 }))
    .then(BsCommands.literal('status')
      .executes(function (ctx) { bsPost({ op: 'status', player: name(ctx) }); return 1 }))
    .then(BsCommands.literal('redo')
      .then(BsCommands.argument('biome', BsString.greedyString())
        .executes(function (ctx) { return run(ctx, text(ctx, 'biome'), true) })))
    .then(BsCommands.literal('far')
      .executes(function (ctx) { return run(ctx, null, false, true, true) })
      .then(BsCommands.argument('filter', BsString.greedyString())
        .executes(function (ctx) { return run(ctx, text(ctx, 'filter'), false, true, true) })))
    .then(BsCommands.literal('surface')
      .executes(function (ctx) { return run(ctx, null, false, true, 'surface') })
      .then(BsCommands.argument('filter', BsString.greedyString())
        .executes(function (ctx) { return run(ctx, text(ctx, 'filter'), false, true, 'surface') })))
    .then(BsCommands.literal('reshoot')
      .then(BsCommands.argument('biomes', BsString.greedyString())
        .executes(function (ctx) { return run(ctx, text(ctx, 'biomes'), true, true) }))))
})
