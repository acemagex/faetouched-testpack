// B-035: thick fog for chosen biomes in the overworld. Twilight Forest's own
// thick fog (FogHandler) runs only inside its dimension, so the remade
// twilightforest:spooky_forest gets it here instead (the author's call: the
// spooky forest only). The numbers follow Twilight's FogHandler, read from the
// jar: for both the terrain fog and the sky fog, the far plane moves to half
// the distance the game would otherwise use (so Blindness and Darkness,
// applied before this event, still shrink it), which fades the sky and the
// horizon into the fog colour; the terrain's near plane moves to three
// quarters of that (the sky's already starts at 0 in vanilla). Both ease by
// 0.003 per call, Twilight's far-plane rate (its near plane eases at 0.0015
// rising and 0.006 falling). Cancelling RenderFog makes NeoForge use the
// distances set here, as biome_shots.js does; fog in water or lava is left
// alone. Twilight's dimension is skipped, for Twilight's own handler, which
// would run there under the same condition as this script.
// NOTE: RenderFog only fires where BCLib's custom fog is off. The author keeps
// BCLib's fog (2026-11-18), so this script is inert, kept for if that changes. BCLib 21.0.28
// cancels vanilla's setupFog everywhere but in biomes with wover biome data
// (none in the overworld or Twilight's dimension) while "custom_fog_rendering"
// is true in config/bclib/client.json, so this script, and Twilight's handler,
// do nothing until that changes (found by a reviewer, 2026-11-18).

// Biome ID -> where the fog ends, as a share of the normal fog distance.
var faeFogBiomes = { 'twilightforest:spooky_forest': 0.5 }
// 0 = the normal fog, 1 = the biome's fog; one per fog mode, as each mode's event eases on its own.
var faeFogMix = { FOG_TERRAIN: 0, FOG_SKY: 0 }
var faeFogShare = 0.5 // the last fog biome's share, kept while easing out
var faeFogLogged = false

NativeEvents.onEvent(Java.loadClass('net.neoforged.neoforge.client.event.ViewportEvent$RenderFog'), function (event) {
  var mode = String(event.getMode())
  if ((mode != 'FOG_TERRAIN' && mode != 'FOG_SKY') || String(event.getType()) != 'NONE') return
  var level = Client.level
  if (!level || String(level.getDimension()) == 'twilightforest:twilight_forest') return
  var id = ''
  var key = level.getBiome(Client.gameRenderer.getMainCamera().getBlockPosition()).unwrapKey()
  if (key.isPresent()) id = String(key.get().location())
  var share = faeFogBiomes[id]
  if (share !== undefined) faeFogShare = share
  var mix = faeFogMix[mode] + ((share !== undefined ? 1 : 0) - faeFogMix[mode]) * 0.003
  faeFogMix[mode] = mix
  if (mix < 0.001) return
  var normalFar = event.getFarPlaneDistance()
  var normalNear = event.getNearPlaneDistance()
  var far = normalFar * faeFogShare
  var near = mode == 'FOG_SKY' ? 0 : far * 0.75
  event.setFarPlaneDistance(normalFar + (far - normalFar) * mix)
  event.setNearPlaneDistance(normalNear + (near - normalNear) * mix)
  event.setCanceled(true)
  // Once per game, so the log shows the fog engaging (B-035 check).
  if (!faeFogLogged && mode == 'FOG_TERRAIN' && mix > 0.5) {
    faeFogLogged = true
    console.info('faetouched_biome_fog: fog engaged in ' + id + ', normal far ' + normalFar + ', now far ' + (normalFar + (far - normalFar) * mix))
  }
})
