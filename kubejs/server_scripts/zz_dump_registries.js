// Writes registry and tag dumps for the project's reference data.
// Output: minecraft/local/dumps/*.json (one array of IDs per registry, plus
// tags.json). Then run: powershell -ExecutionPolicy Bypass -File tools\import-dumps.ps1
// If JsonIO.write is unavailable, the same data goes to the log as [DUMP] lines,
// which import-dumps.ps1 also reads.
//
// Rhino (KubeJS's JavaScript engine) rejects const/let redeclared inside loop
// bodies, so each registry is handled in its own function call.

const DUMP_DIR = 'local/dumps/'

function dumpSave(name, data) {
  try {
    JsonIO.write(DUMP_DIR + name + '.json', data)
    return 1
  } catch (e) {
    console.error('[dump] JsonIO.write failed for ' + name + ', logging instead: ' + e)
    var lines = Array.isArray(data) ? data : Object.keys(data).map(function (k) { return k + ' -> ' + data[k] })
    lines.forEach(function (line) { console.info('[DUMP] ' + name + ' ' + line) })
    return 0
  }
}

function dumpTags(name, registry, tags) {
  registry.getTags().forEach(function (t) {
    try {
      // 1.21.1 yields Pair<TagKey, HolderSet.Named>; later versions yield Named.
      var named = t.getSecond ? t.getSecond() : t
      var key = String(named.key().location())
      var members = []
      named.stream().forEach(function (h) { members.push(String(h.unwrapKey().get().location())) })
      members.sort()
      tags['#' + key + ' [' + name + ']'] = members.join(', ')
    } catch (e) {
      console.error('[dump] could not read a ' + name + ' tag: ' + e)
    }
  })
}

function dumpRegistry(name, registry, tags, withTags) {
  try {
    var ids = []
    registry.keySet().forEach(function (k) { ids.push(String(k)) })
    ids.sort()
    var written = dumpSave(name, ids)
    if (withTags) dumpTags(name, registry, tags)
    return written
  } catch (e) {
    console.error('[dump] registry ' + name + ' failed: ' + e)
    return 0
  }
}

// Runs once per script load: when a world starts (ServerEvents.loaded), and on
// the first server tick after a /reload (scripts are re-evaluated on reload,
// which resets this flag; by the first tick the tags are bound again).
var dumpDone = false

function dumpAll() {
  if (dumpDone) return
  dumpDone = true
  var BI = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries')
  var tags = {}
  var written = 0
  written += dumpRegistry('item', BI.ITEM, tags, true)
  written += dumpRegistry('block', BI.BLOCK, tags, true)
  written += dumpRegistry('fluid', BI.FLUID, tags, true)
  written += dumpRegistry('entity_type', BI.ENTITY_TYPE, tags, false)
  written += dumpRegistry('recipe_type', BI.RECIPE_TYPE, tags, false)
  written += dumpRegistry('recipe_serializer', BI.RECIPE_SERIALIZER, tags, false)
  written += dumpSave('tags', tags)
  console.info('[dump] wrote ' + written + ' dump files to ' + DUMP_DIR + ' (' + Object.keys(tags).length + ' tags)')
}

ServerEvents.loaded(function (event) { dumpAll() })
ServerEvents.tick(function (event) { if (!dumpDone) dumpAll() })
