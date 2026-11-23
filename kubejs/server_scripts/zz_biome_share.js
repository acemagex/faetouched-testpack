// TEMPORARY, for decision 0012's verification: remove once the biome layout is settled.
// Samples the overworld's biome source on a grid, without generating chunks, and
// reports each biome's share. This replaces the decision's table-level estimate.
//
// Command (op): /biomeshare [radius]   default 50000 blocks around 0,0, one sample every 128
//   (about 611,000 samples over a 100,000-block square, ten times the area of the old
//   16000 default; the author's request, 2026-11-18). The run is done in one go, so the
//   game pauses until it finishes; the time it took is reported.
// Evenness: the square is cut into SHARE_TILES x SHARE_TILES tiles, and each biome also
//   gets its share in every tile: the lowest and highest tile share, their spread (standard
//   deviation) and how many tiles it appears in. A biome that is even across the map has
//   a small spread and appears in most tiles; one that clumps has a high top tile.
// Output: minecraft/local/visualizer/biome-share.json (git-ignored), and the top ten in chat.
//   Readers that only use biomes[].biome and .percent (tools/tree-inventory.js) are unaffected.
//
// Samples each column at its surface (B-031 step 3, 2026-11-20), as /biomepatches does: the generator's
//   getBaseHeight (WORLD_SURFACE_WG, worked out from the noise without generating chunks). At a flat Y 64,
//   as before, 6.5% of samples were cave biomes under high ground. The surface lookup costs about 1 ms a
//   sample, so the default run takes about 10 minutes. The report's y is 'surface'.
// Quick check: /biomeshare 20000 (about 98,000 samples, a sixth of the time) answers "did the surface change?"
//   after underground work; keep the default radius for decisions about the distribution itself
//   (knowledge/playbooks/testing-loop.md, "Headless server runs").
// Works from the console too (tools/headless-test.js): messages go to the source, not a player.
// Biome IDs come from the game at runtime; none are written here.
// Rhino rejects const/let redeclared inside loop bodies, so this file uses var.

var ShareCommands = Java.loadClass('net.minecraft.commands.Commands')
var ShareInteger = Java.loadClass('com.mojang.brigadier.arguments.IntegerArgumentType')
var ShareJsonParser = Java.loadClass('com.google.gson.JsonParser')
var SHARE_FILE = 'local/visualizer/biome-share.json'
var SHARE_STEP = 128
var ShareHeightmap = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types')
var ShareComponent = Java.loadClass('net.minecraft.network.chat.Component')
var SHARE_DEFAULT_RADIUS = 50000
var SHARE_TILES = 10

function shareRound(v) { return Math.round(v * 100) / 100 }

function shareRun(ctx, radius) {
  var started = Date.now()
  var level = ctx.source.getServer().overworld()
  var chunks = level.getChunkSource()
  var generator = chunks.getGenerator()
  var source = generator.getBiomeSource()
  var randomState = chunks.randomState()
  var sampler = randomState.sampler()
  var side = Math.floor((2 * radius) / SHARE_STEP) + 1 // sample points per axis
  var nTiles = SHARE_TILES * SHARE_TILES
  var tileTotals = []
  for (var k = 0; k < nTiles; k++) tileTotals.push(0)
  var counts = {}
  var tileCounts = {} // biome -> samples per tile
  var total = 0
  var i = 0
  for (var x = -radius; x <= radius; x += SHARE_STEP, i++) {
    var ti = Math.min(SHARE_TILES - 1, Math.floor((i * SHARE_TILES) / side))
    var j = 0
    for (var z = -radius; z <= radius; z += SHARE_STEP, j++) {
      var surface = generator.getBaseHeight(x, z, ShareHeightmap.WORLD_SURFACE_WG, level, randomState) - 1
      var id = String(source.getNoiseBiome(x >> 2, surface >> 2, z >> 2, sampler).unwrapKey().get().location())
      var t = ti * SHARE_TILES + Math.min(SHARE_TILES - 1, Math.floor((j * SHARE_TILES) / side))
      counts[id] = (counts[id] || 0) + 1
      var a = tileCounts[id]
      if (!a) {
        a = []
        for (var m = 0; m < nTiles; m++) a.push(0)
        tileCounts[id] = a
      }
      a[t]++
      tileTotals[t]++
      total++
    }
  }
  var rows = Object.keys(counts).map(function (b) {
    var shares = tileCounts[b].map(function (c, n) { return (100 * c) / tileTotals[n] })
    var mean = shares.reduce(function (s, v) { return s + v }, 0) / nTiles
    var sd = Math.sqrt(shares.reduce(function (s, v) { return s + (v - mean) * (v - mean) }, 0) / nTiles)
    return {
      biome: b,
      percent: shareRound((100 * counts[b]) / total),
      tileMin: shareRound(Math.min.apply(null, shares)),
      tileMax: shareRound(Math.max.apply(null, shares)),
      tileSd: shareRound(sd),
      tilesPresent: shares.filter(function (v) { return v > 0 }).length,
    }
  })
  rows.sort(function (p, q) { return q.percent - p.percent })
  var seconds = Math.round((Date.now() - started) / 100) / 10
  var report = { radius: radius, step: SHARE_STEP, y: 'surface', samples: total, tiles: SHARE_TILES, seconds: seconds, biomes: rows }
  JsonIO.write(SHARE_FILE, ShareJsonParser.parseString(JSON.stringify(report)))
  var line = rows.slice(0, 10).map(function (r) { return r.biome + ' ' + r.percent + '%' }).join(', ')
  console.info('[biomeshare] ' + total + ' samples in ' + seconds + ' s, ' + rows.length + ' biomes: ' + line)
  ctx.source.sendSystemMessage(ShareComponent.literal(total + ' samples in ' + seconds + ' s, ' + rows.length + ' biomes. Top: ' + line))
  return 1
}

ServerEvents.commandRegistry(function (event) {
  event.register(ShareCommands.literal('biomeshare')
    .requires(function (src) { return src.hasPermission(2) })
    .executes(function (ctx) { return shareRun(ctx, SHARE_DEFAULT_RADIUS) })
    // At least 576, so each axis has 10 sample points and every tile gets samples.
    .then(ShareCommands.argument('radius', ShareInteger.integer(576, 100000))
      .executes(function (ctx) { return shareRun(ctx, ShareInteger.getInteger(ctx, 'radius')) })))
})
