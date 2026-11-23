// B-031's patch survey (proposals/biome-distribution.md, step 1): samples the overworld's biome
// source on a fine grid around the caller, without generating chunks, and writes the grid for
// tools/biome-patches.js, which joins samples into patches and measures them. Kept while the
// distribution is being tuned; remove with zz_biome_share.js once it's settled.
//
// Command (op): /biomepatches [half] [step]   a square of 2*half blocks centred on the caller,
//   one sample every step blocks (defaults 4000 and 16: 501 x 501 = 251,001 samples, 237 s in the first
//   surface run, 2026-11-19: about 0.94 ms each). The game pauses until it finishes.
// Output: minecraft/local/visualizer/biome-patches.json (git-ignored): the palette of biome IDs
//   and one string per row of palette indices in base 36, comma-separated. While the size field's noise
//   exists (the pack's permanent copy, prototypes/biome-size/build.js PC --permanent), also `s`: the size
//   field S at each sample, one string per row of numbers rounded to 3 decimals, comma-separated.
//
// Command (op): /biomesize [half] [step]   S only, no biome or surface lookup (step 2's zone survey):
//   defaults 32000 and 64 (1001 x 1001 = 1,002,001 samples), at most 4,000,000. Writes
//   minecraft/local/visualizer/biome-size.json: the grid `s` (as above), its mean, spread and percentiles,
//   the share of samples by the massive weight t_big = clamp((S - 0.155) / 0.1) and by zone (S at least
//   0.205, the middle of the blend), and suggested centres for /biomepatches: the 8,000-block squares at
//   least 5,000 blocks from the caller (run it at spawn) with the most and the least massive zone.
//
// S is read as the size field's density function reads it: the noise faetouched:size_field (or a test
// variant's faetouched:size_test_field when the permanent copy is out) at
// (x / 4, 0, z / 4), through the random state, without the shift_x/shift_z offset (a few blocks at most,
// nothing at a zone's scale; the analyst's approach, 2026-11-19).
//
// Same calls as zz_biome_share.js (getNoiseBiome with the random state's sampler), but at each column's
// surface, as a player standing there sees it: the generator's getBaseHeight (WORLD_SURFACE_WG, worked
// out from the noise without generating chunks). At a flat Y 64, as /biomeshare samples, 6.2% of the
// first survey's samples were cave biomes under high ground, cutting surface patches apart (2026-11-19).
// Both commands work from the console too (messages go through patchSay): tools/headless-test.js runs them as
//   biomesize
//   execute positioned <x> 320 <z> run biomepatches      (the centre is read from the source's position)
// Biome IDs come from the game at runtime; none are written here.
// Rhino rejects const/let redeclared inside loop bodies, so this file uses var.

var PatchCommands = Java.loadClass('net.minecraft.commands.Commands')
var PatchInteger = Java.loadClass('com.mojang.brigadier.arguments.IntegerArgumentType')
var PatchJsonParser = Java.loadClass('com.google.gson.JsonParser')
var PATCH_FILE = 'local/visualizer/biome-patches.json'
var PatchHeightmap = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types')
var PatchResourceKey = Java.loadClass('net.minecraft.resources.ResourceKey')
var PatchResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation')
var PatchRegistries = Java.loadClass('net.minecraft.core.registries.Registries')
var PatchComponent = Java.loadClass('net.minecraft.network.chat.Component')

var PATCH_MAX_SAMPLES = 400000 // about 6 minutes at the measured ~0.94 ms per sample; more would look like a freeze

// The size field (B-031 step 2): the permanent noise build.js PC --permanent writes, or, when that is out, a test
// variant's. The reports name the one read. If neither exists, the surveys say so and drop S (sizeNoise below).
var SIZE_NOISE_IDS = ['faetouched:size_field', 'faetouched:size_test_field']
var SIZE_FILE = 'local/visualizer/biome-size.json'
var SIZE_MAX_SAMPLES = 4000000
var SIZE_SBIG = 0.155 // build.js's defaults: the massive zone's threshold and blend width
var SIZE_W = 0.1
var SIZE_SQUARE = 8000 // the side of /biomepatches' default square
var SIZE_MIN_DISTANCE = 5000 // survey squares this far from spawn at least (the analyst: the scales correlate near spawn)

// Returns { noise, id } for the first size field installed, { missing: true } when none is, { error, id } when a
// lookup fails some other way (then only S is dropped).
function sizeNoise(server, randomState) {
  for (var i = 0; i < SIZE_NOISE_IDS.length; i++) {
    var r = sizeNoiseOf(server, randomState, SIZE_NOISE_IDS[i])
    if (!r.missing) { r.id = SIZE_NOISE_IDS[i]; return r }
  }
  return { missing: true }
}
function sizeNoiseOf(server, randomState, id) {
  var key
  try {
    key = PatchResourceKey.create(PatchRegistries.NOISE, PatchResourceLocation.parse(id))
  } catch (e) {
    return { error: 'cannot make the key: ' + e }
  }
  try {
    // keySet().contains, not containsKey: containsKey has ResourceKey and ResourceLocation overloads, and
    // Rhino found the call ambiguous in game (2026-11-19); Set.contains(Object) has one signature.
    if (!server.registryAccess().registryOrThrow(PatchRegistries.NOISE).keySet().contains(key.location())) return { missing: true }
  } catch (e) {
    console.warn('[biomesize] registry check failed, trying the noise directly: ' + e)
  }
  try {
    return { noise: randomState.getOrCreateNoise(key) }
  } catch (e) {
    if (String(e).indexOf('Missing') >= 0) return { missing: true }
    return { error: String(e) }
  }
}
// Tells whoever ran the command: a player in chat, or the console in the server log. A console or `execute ... run`
// source has no player, so getPlayerOrException throws there; CommandSourceStack.sendSystemMessage goes to the
// player when the source has one and to the source itself when not. With a tag the text is also logged as a
// warning, which a headless runner (tools/headless-test.js --commands) can wait for or fail on.
function patchSay(ctx, msg, tag) {
  if (tag) console.warn(tag + ' ' + msg)
  ctx.source.sendSystemMessage(PatchComponent.literal(msg))
}
function sizeRound(v) { return Math.round(v * 1000) / 1000 }

function patchRun(ctx, half, step) {
  var side = Math.floor((2 * half) / step) + 1
  if (side * side > PATCH_MAX_SAMPLES) {
    patchSay(ctx, 'Too many samples (' + side * side + ', the cap is ' + PATCH_MAX_SAMPLES + '): use a smaller square or a larger step', '[biomepatches]')
    return 0
  }
  var started = Date.now()
  var server = ctx.source.getServer()
  var level = server.overworld()
  var chunks = level.getChunkSource()
  var source = chunks.getGenerator().getBiomeSource()
  var randomState = chunks.randomState()
  var sampler = randomState.sampler()
  var generator = chunks.getGenerator()
  var size = sizeNoise(server, randomState)
  var sNoise = size.noise || null
  var pos = ctx.source.getPosition()
  var cx = Math.floor(pos.x() / step) * step
  var cz = Math.floor(pos.z() / step) * step
  var palette = []
  var index = {}
  var rows = []
  var sRows = []
  var n = 0
  for (var z = cz - half; z <= cz + half; z += step) {
    var row = []
    var sRow = []
    for (var x = cx - half; x <= cx + half; x += step) {
      var surface = generator.getBaseHeight(x, z, PatchHeightmap.WORLD_SURFACE_WG, level, randomState) - 1
      var id = String(source.getNoiseBiome(x >> 2, surface >> 2, z >> 2, sampler).unwrapKey().get().location())
      var k = index[id]
      if (k === undefined) { k = palette.length; index[id] = k; palette.push(id) }
      row.push(k.toString(36))
      if (sNoise) {
        try {
          sRow.push(sizeRound(sNoise.getValue(x * 0.25, 0, z * 0.25)))
        } catch (e) {
          sNoise = null
          size = { error: 'reading the noise failed: ' + e }
        }
      }
      n++
    }
    rows.push(row.join(','))
    if (sNoise) sRows.push(sRow.join(','))
  }
  var seconds = Math.round((Date.now() - started) / 100) / 10
  var report = { centre: [cx, cz], half: half, step: step, y: 'surface', samples: n, seconds: seconds, palette: palette, rows: rows }
  if (sNoise) { report.sNoise = size.id; report.s = sRows }
  var json = PatchJsonParser.parseString(JSON.stringify(report))
  JsonIO.write(PATCH_FILE, json)
  // A copy named after the centre too, so the next run doesn't overwrite this one (W0's massive-centre grid
  // was lost that way, 2026-11-19): local/visualizer/biome-patches-<x>_<z>.json.
  var keep = 'local/visualizer/biome-patches-' + cx + '_' + cz + '.json'
  JsonIO.write(keep, json)
  var msg = n + ' samples around ' + cx + ', ' + cz + ' in ' + seconds + ' s, ' + palette.length + ' biomes' + (sNoise ? ', with S' : '') + '; also saved as ' + keep + '; run node tools/biome-patches.js ' + 'minecraft/' + keep
  console.info('[biomepatches] ' + msg)
  patchSay(ctx, msg)
  if (size.error) {
    console.warn('[biomepatches] S not recorded: ' + size.error)
    patchSay(ctx, 'S not recorded (the biome grid is fine): ' + size.error)
  }
  return 1
}

function sizeRun(ctx, half, step) {
  var side = Math.floor((2 * half) / step) + 1
  if (side * side > SIZE_MAX_SAMPLES) {
    patchSay(ctx, 'Too many samples (' + side * side + ', the cap is ' + SIZE_MAX_SAMPLES + '): use a smaller square or a larger step', '[biomesize]')
    return 0
  }
  var server = ctx.source.getServer()
  var randomState = server.overworld().getChunkSource().randomState()
  var size = sizeNoise(server, randomState)
  if (!size.noise) {
    patchSay(ctx, size.missing ? 'No size field in this world: ' + SIZE_NOISE_IDS.join(' and ') + ' are missing (prototypes/biome-size/build.js PC --permanent writes it)' : 'Cannot read the size field: ' + size.error, '[biomesize]')
    return 0
  }
  var noise = size.noise
  var started = Date.now()
  var pos = ctx.source.getPosition()
  var cx = Math.floor(pos.x() / step) * step
  var cz = Math.floor(pos.z() / step) * step
  var x0 = cx - half
  var z0 = cz - half
  // Running sums, a histogram in steps of 0.001 over -2.5..2.5 for the percentiles (no sort of a
  // million numbers in Rhino), and per 1,000-block cell the samples and massive-zone samples.
  var HIST_LO = -2.5
  var hist = []
  for (var h = 0; h <= 5000; h++) hist.push(0)
  var cell = 1000
  var nc = Math.max(1, Math.ceil((2 * half) / cell))
  var cellN = []
  var cellBig = []
  for (var c = 0; c < nc * nc; c++) { cellN.push(0); cellBig.push(0) }
  var zoneLine = Math.round((SIZE_SBIG + SIZE_W / 2) * 1e6) / 1e6 // 0.155 + 0.05 is 0.20500000000000002 unrounded
  var n = 0, sum = 0, sumSq = 0, weight = 0, big = 0, lo = Infinity, hi = -Infinity
  var rows = []
  for (var z = z0; z <= cz + half; z += step) {
    var row = []
    var cz2 = Math.floor((z - z0) / cell) // the far edge's row and column fall past the last cell and stay out of it
    for (var x = x0; x <= cx + half; x += step) {
      var v = noise.getValue(x * 0.25, 0, z * 0.25)
      row.push(sizeRound(v))
      n++
      sum += v
      sumSq += v * v
      if (v < lo) lo = v
      if (v > hi) hi = v
      var t = (v - SIZE_SBIG) / SIZE_W
      weight += t <= 0 ? 0 : (t >= 1 ? 1 : t)
      var bin = Math.round((v - HIST_LO) * 1000)
      hist[bin < 0 ? 0 : (bin > 5000 ? 5000 : bin)]++
      var cx2 = Math.floor((x - x0) / cell)
      var inCell = cz2 < nc && cx2 < nc
      if (inCell) cellN[cz2 * nc + cx2]++
      if (v >= zoneLine) { big++; if (inCell) cellBig[cz2 * nc + cx2]++ }
    }
    rows.push(row.join(','))
  }
  var mean = sum / n
  var sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean))
  var pct = function (q) {
    var want = q * n, run = 0
    for (var b = 0; b <= 5000; b++) { run += hist[b]; if (run >= want) return sizeRound(HIST_LO + b / 1000) }
    return sizeRound(hi)
  }
  // Candidate squares: SIZE_SQUARE / cell cells a side, on the cell lattice, wholly inside the grid
  // and at least SIZE_MIN_DISTANCE from the caller; the best three of each kind, not overlapping.
  var sq = Math.round(SIZE_SQUARE / cell)
  var full = Math.floor((2 * half) / cell)
  var cands = []
  for (var j = 0; j + sq <= full; j++) {
    for (var i = 0; i + sq <= full; i++) {
      var qx = x0 + (i + sq / 2) * cell
      var qz = z0 + (j + sq / 2) * cell
      if (Math.sqrt((qx - cx) * (qx - cx) + (qz - cz) * (qz - cz)) < SIZE_MIN_DISTANCE) continue
      var qn = 0, qb = 0
      for (var b2 = j; b2 < j + sq; b2++) for (var a2 = i; a2 < i + sq; a2++) { qn += cellN[b2 * nc + a2]; qb += cellBig[b2 * nc + a2] }
      if (qn) cands.push({ x: qx, z: qz, massiveShare: sizeRound(qb / qn) })
    }
  }
  var pick = function (sorted) {
    var out = []
    for (var p = 0; p < sorted.length && out.length < 3; p++) {
      var ok = true
      for (var o = 0; o < out.length; o++) if (Math.abs(out[o].x - sorted[p].x) < SIZE_SQUARE && Math.abs(out[o].z - sorted[p].z) < SIZE_SQUARE) ok = false
      if (ok) out.push(sorted[p])
    }
    return out
  }
  var massive = pick(cands.slice().sort(function (a, b) { return b.massiveShare - a.massiveShare }))
  var medium = pick(cands.slice().sort(function (a, b) { return a.massiveShare - b.massiveShare }))
  var seconds = Math.round((Date.now() - started) / 100) / 10
  var stats = { mean: sizeRound(mean), sd: sizeRound(sd), min: sizeRound(lo), max: sizeRound(hi),
    p50: pct(0.5), p90: pct(0.9), p98: pct(0.98), p99: pct(0.99),
    massiveWeightShare: sizeRound(weight / n), massiveZoneShare: sizeRound(big / n) }
  var report = { centre: [cx, cz], half: half, step: step, samples: n, seconds: seconds, noise: size.id,
    sbig: SIZE_SBIG, w: SIZE_W, zoneLine: zoneLine, stats: stats,
    candidates: { square: SIZE_SQUARE, minDistance: SIZE_MIN_DISTANCE, massive: massive, medium: medium }, s: rows }
  JsonIO.write(SIZE_FILE, PatchJsonParser.parseString(JSON.stringify(report)))
  var where = function (list) { return list.length ? list[0].x + ' ' + list[0].z + ' (' + Math.round(100 * list[0].massiveShare) + '% massive)' : 'none (the square is too small)' }
  var msg = n + ' samples of S around ' + cx + ', ' + cz + ' in ' + seconds + ' s: mean ' + stats.mean + ', sd ' + stats.sd +
    ', massive weight ' + Math.round(1000 * stats.massiveWeightShare) / 10 + '%, massive zone ' + Math.round(1000 * stats.massiveZoneShare) / 10 + '%' +
    '. Massive centre ' + where(massive) + ', medium centre ' + where(medium) + '; wrote ' + SIZE_FILE
  console.info('[biomesize] ' + msg)
  patchSay(ctx, msg)
  return 1
}

ServerEvents.commandRegistry(function (event) {
  event.register(PatchCommands.literal('biomepatches')
    .requires(function (src) { return src.hasPermission(2) })
    .executes(function (ctx) { return patchRun(ctx, 4000, 16) })
    .then(PatchCommands.argument('half', PatchInteger.integer(256, 20000))
      .executes(function (ctx) { return patchRun(ctx, PatchInteger.getInteger(ctx, 'half'), 16) })
      .then(PatchCommands.argument('step', PatchInteger.integer(4, 128))
        .executes(function (ctx) { return patchRun(ctx, PatchInteger.getInteger(ctx, 'half'), PatchInteger.getInteger(ctx, 'step')) }))))
  event.register(PatchCommands.literal('biomesize')
    .requires(function (src) { return src.hasPermission(2) })
    .executes(function (ctx) { return sizeRun(ctx, 32000, 64) })
    .then(PatchCommands.argument('half', PatchInteger.integer(1000, 64000))
      .executes(function (ctx) { return sizeRun(ctx, PatchInteger.getInteger(ctx, 'half'), 64) })
      .then(PatchCommands.argument('step', PatchInteger.integer(8, 1024))
        .executes(function (ctx) { return sizeRun(ctx, PatchInteger.getInteger(ctx, 'half'), PatchInteger.getInteger(ctx, 'step')) }))))
})
