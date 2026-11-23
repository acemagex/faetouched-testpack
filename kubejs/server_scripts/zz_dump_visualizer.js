// Exports the game's final state for the pack visualizer (decision 0010).
// Output: minecraft/local/visualizer/ (git-ignored), one file per namespace:
//   recipes/<ns>.json             recipe id -> recipe JSON (Recipe.CODEC, or the
//                                 recipe event's JSON when the codec fails), plus
//                                 _recipe_type, the recipe type (its `type` is the serializer)
//   biomes/<ns>.json              biome id -> { biome, spawns, generation, tags, dimensions }
//   placed_features/<ns>.json     placed feature id -> JSON (heights and counts)
//   configured_features/<ns>.json configured feature id -> JSON (ore targets)
//   loot/<ns>.json                loot table id -> JSON
//   entities.json                 entity id -> { category, loot_table }
//   meta.json                     time, counts per section, first errors
// Then build the app data: cd visualizer; npm run data
//
// Runs on world load and on the first tick after /reload, like zz_dump_registries.js.
// Rhino rejects const/let redeclared inside loop bodies, so this file uses var.

var VIS_DIR = 'local/visualizer/'
var VIS_MAX_ERRORS = 40

var JsonOps = Java.loadClass('com.mojang.serialization.JsonOps')
var RegistryOps = Java.loadClass('net.minecraft.resources.RegistryOps')
var Registries = Java.loadClass('net.minecraft.core.registries.Registries')
var JsonObject = Java.loadClass('com.google.gson.JsonObject')
var JsonArray = Java.loadClass('com.google.gson.JsonArray')

// Recipe JSON captured in the recipe event, keyed by recipe id. It is the
// fallback for recipes Recipe.CODEC cannot encode. Covers only recipes that
// existed before KubeJS's event (not ones added in it).
var visFallback = {}
var visFallbackCount = 0

ServerEvents.recipes(function (event) {
  try {
    event.forEachRecipe('*', function (r) {
      try {
        if (r.id && r.json) {
          visFallback[String(r.id)] = r.json
          visFallbackCount++
        }
      } catch (e) { /* one bad recipe must not stop the walk */ }
    })
  } catch (e) {
    console.error('[visualizer] recipe event fallback failed: ' + e)
  }
})

function visSection(name) {
  return { name: name, files: {}, count: 0, failed: 0, errors: [] }
}

function visError(section, id, message) {
  section.failed++
  if (section.errors.length < VIS_MAX_ERRORS) section.errors.push(id + ': ' + message)
}

function visPut(section, id, json) {
  var ns = id.indexOf(':') > 0 ? id.substring(0, id.indexOf(':')) : 'minecraft'
  var file = section.files[ns]
  if (!file) {
    file = new JsonObject()
    section.files[ns] = file
  }
  file.add(id, json)
  section.count++
}

function visWrite(path, json) {
  try {
    JsonIO.write(VIS_DIR + path, json)
    return true
  } catch (e) {
    console.error('[visualizer] could not write ' + path + ': ' + e)
    return false
  }
}

function visFlush(section) {
  Object.keys(section.files).forEach(function (ns) {
    visWrite(section.name + '/' + ns + '.json', section.files[ns])
  })
}

// Encodes value with codec, accepting a Codec or a MapCodec. Returns a
// JsonElement, or throws with the codec's own message.
function visEncode(codec, ops, value) {
  var c = codec
  if (c.encodeStart === undefined && c.codec !== undefined) c = c.codec()
  var result = c.encodeStart(ops, value)
  var ok = result.result()
  if (ok.isPresent()) return ok.get()
  var err = result.error()
  throw new Error(err.isPresent() ? String(err.get().message()) : 'no result')
}

function visRecipes(server, ops) {
  var section = visSection('recipes')
  var Recipe = Java.loadClass('net.minecraft.world.item.crafting.Recipe')
  var BI = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries')
  var fallbackUsed = 0
  server.getRecipeManager().getRecipes().forEach(function (holder) {
    var id = String(holder.id())
    try {
      var json = visEncode(Recipe.CODEC, ops, holder.value())
      // The codec's `type` is the serializer; the recipe type (which machine
      // runs it) is separate, e.g. many serializers share minecraft:crafting.
      // Left out when the type object has no registry key: Create Mechanical
      // Extruder's recipes, though create_mechanical_extruder:extruding_type is registered.
      var typeKey = BI.RECIPE_TYPE.getKey(holder.value().getType())
      if (typeKey) json.addProperty('_recipe_type', String(typeKey))
      visPut(section, id, json)
    } catch (e) {
      var fb = visFallback[id]
      if (fb) {
        visPut(section, id, fb)
        fallbackUsed++
      }
      visError(section, id, (fb ? '(fallback used) ' : '') + e)
    }
  })
  visFlush(section)
  section.fallbackUsed = fallbackUsed
  section.fallbackAvailable = visFallbackCount
  return section
}

function visBiomeDimensions(server) {
  var byBiome = {}
  server.getAllLevels().forEach(function (level) {
    // KubeJS adds getDimension() (a ResourceLocation), whose bean property
    // `dimension` hides vanilla's dimension() method from Rhino.
    var dim = String(level.getDimension())
    try {
      level.getChunkSource().getGenerator().getBiomeSource().possibleBiomes().forEach(function (h) {
        var id = String(h.unwrapKey().get().location())
        if (!byBiome[id]) byBiome[id] = []
        byBiome[id].push(dim)
      })
    } catch (e) {
      console.error('[visualizer] biome source of ' + dim + ' unreadable: ' + e)
    }
  })
  return byBiome
}

function visBiomes(server, ops) {
  var section = visSection('biomes')
  var Biome = Java.loadClass('net.minecraft.world.level.biome.Biome')
  var MobSpawnSettings = Java.loadClass('net.minecraft.world.level.biome.MobSpawnSettings')
  var BiomeGenerationSettings = Java.loadClass('net.minecraft.world.level.biome.BiomeGenerationSettings')
  var dims = {}
  try { dims = visBiomeDimensions(server) } catch (e) { visError(section, 'dimensions', e) }
  var registry = server.registryAccess().registryOrThrow(Registries.BIOME)
  registry.holders().forEach(function (holder) {
    var id = String(holder.key().location())
    var out = new JsonObject()
    var biome = holder.value()
    // The whole biome (climate, effects; NeoForge may encode the pre-modifier
    // version), then spawns and features read through the getters, which
    // return the data after biome modifiers.
    try { out.add('biome', visEncode(Biome.DIRECT_CODEC, ops, biome)) } catch (e) { visError(section, id + ' biome', e) }
    try { out.add('spawns', visEncode(MobSpawnSettings.CODEC, ops, biome.getMobSettings())) } catch (e) { visError(section, id + ' spawns', e) }
    try { out.add('generation', visEncode(BiomeGenerationSettings.CODEC, ops, biome.getGenerationSettings())) } catch (e) { visError(section, id + ' generation', e) }
    var tags = new JsonArray()
    holder.tags().forEach(function (t) { tags.add(String(t.location())) })
    out.add('tags', tags)
    var d = new JsonArray()
    ;(dims[id] || []).forEach(function (x) { d.add(x) })
    out.add('dimensions', d)
    visPut(section, id, out)
  })
  visFlush(section)
  return section
}

function visRegistryCodec(server, ops, name, registryKey, codec) {
  var section = visSection(name)
  var registry = server.registryAccess().registryOrThrow(registryKey)
  registry.holders().forEach(function (holder) {
    var id = String(holder.key().location())
    try {
      visPut(section, id, visEncode(codec, ops, holder.value()))
    } catch (e) {
      visError(section, id, e)
    }
  })
  visFlush(section)
  return section
}

function visLoot(server) {
  var section = visSection('loot')
  var LootTable = Java.loadClass('net.minecraft.world.level.storage.loot.LootTable')
  var ResourceKey = Java.loadClass('net.minecraft.resources.ResourceKey')
  var holder
  try {
    holder = server.reloadableRegistries()
  } catch (e) {
    visError(section, 'reloadableRegistries', e)
    return section
  }
  // Loot tables refer to items and enchantments, which the server's registry
  // access holds, so its ops are enough. Each step is labelled so a failure
  // names the call that broke (KubeJS hides getClass(), so no reflection).
  var step = 'ops'
  try {
    var ops = RegistryOps.create(JsonOps.INSTANCE, server.registryAccess())
    step = 'getKeys'
    var keys = holder.getKeys(Registries.LOOT_TABLE)
    step = 'tables'
    keys.forEach(function (loc) {
      var id = String(loc)
      try {
        var table = holder.getLootTable(ResourceKey.create(Registries.LOOT_TABLE, loc))
        visPut(section, id, visEncode(LootTable.DIRECT_CODEC, ops, table))
      } catch (e) {
        visError(section, id, e)
      }
    })
  } catch (e) {
    visError(section, 'loot step ' + step, e)
  }
  visFlush(section)
  return section
}

function visEntities() {
  var section = visSection('entities')
  var BI = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries')
  var out = new JsonObject()
  BI.ENTITY_TYPE.keySet().forEach(function (key) {
    var id = String(key)
    try {
      var type = BI.ENTITY_TYPE.get(key)
      var e = new JsonObject()
      e.addProperty('category', String(type.getCategory().getName()))
      var loot = type.getDefaultLootTable()
      // 1.21.1 returns a ResourceKey; older versions a ResourceLocation.
      e.addProperty('loot_table', String(loot.location ? loot.location() : loot))
      out.add(id, e)
      section.count++
    } catch (err) {
      visError(section, id, err)
    }
  })
  visWrite('entities.json', out)
  return section
}

var visDone = false

function visRun(label, fn) {
  var started = Date.now()
  var s
  try {
    s = fn()
  } catch (e) {
    s = visSection(label)
    visError(s, label, e)
  }
  s.ms = Date.now() - started
  console.info('[visualizer] ' + label + ': ' + s.count + ' written, ' + s.failed + ' failed (' + s.ms + ' ms)')
  return s
}

function visExportAll(server) {
  if (visDone) return
  visDone = true
  var ops = RegistryOps.create(JsonOps.INSTANCE, server.registryAccess())
  var PlacedFeature = Java.loadClass('net.minecraft.world.level.levelgen.placement.PlacedFeature')
  var ConfiguredFeature = Java.loadClass('net.minecraft.world.level.levelgen.feature.ConfiguredFeature')
  var sections = [
    visRun('recipes', function () { return visRecipes(server, ops) }),
    visRun('biomes', function () { return visBiomes(server, ops) }),
    visRun('placed_features', function () { return visRegistryCodec(server, ops, 'placed_features', Registries.PLACED_FEATURE, PlacedFeature.DIRECT_CODEC) }),
    visRun('configured_features', function () { return visRegistryCodec(server, ops, 'configured_features', Registries.CONFIGURED_FEATURE, ConfiguredFeature.DIRECT_CODEC) }),
    visRun('loot', function () { return visLoot(server) }),
    visRun('entities', function () { return visEntities() })
  ]
  var meta = new JsonObject()
  meta.addProperty('exported_at', new Date().toISOString())
  meta.addProperty('format', 1)
  var secs = new JsonObject()
  sections.forEach(function (s) {
    var o = new JsonObject()
    o.addProperty('count', s.count)
    o.addProperty('failed', s.failed)
    o.addProperty('ms', s.ms)
    if (s.fallbackUsed !== undefined) {
      o.addProperty('fallback_used', s.fallbackUsed)
      o.addProperty('fallback_available', s.fallbackAvailable)
    }
    var namespaces = new JsonArray()
    Object.keys(s.files).sort().forEach(function (ns) { namespaces.add(ns) })
    o.add('namespaces', namespaces)
    var errs = new JsonArray()
    s.errors.forEach(function (m) { errs.add(String(m)) })
    o.add('errors', errs)
    secs.add(s.name, o)
  })
  meta.add('sections', secs)
  visWrite('meta.json', meta)
  console.info('[visualizer] export done: ' + VIS_DIR + 'meta.json')
}

ServerEvents.loaded(function (event) { visExportAll(event.server) })
ServerEvents.tick(function (event) { if (!visDone) visExportAll(event.server) })
