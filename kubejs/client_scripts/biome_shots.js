// Biome shots for the visualizer (B-024, decision 0010): the client half.
// server_scripts/zz_biome_shots.js places the camera and sets phase 'shoot';
// this script waits until the view has rendered, saves the screenshot to
// minecraft/screenshots/<file> and sets phase 'captured'.
// While a run is active it hides the HUD and sets the window to 960x540,
// and puts both back when the run ends.

var BscScreenshot = Java.loadClass('net.minecraft.client.Screenshot')

var BSC_WIDTH = 960
var BSC_HEIGHT = 540
var BSC_RENDER_GRACE = 400   // ticks past minTicks before shooting a view still rendering
var BSC_STABLE = 10          // ticks the view must stay fully rendered

var bsc = { on: false, warned: false, seq: -1, wait: 0, stable: 0, hideGui: false, width: 0, height: 0 }

// Shows in logs/kubejs/client.log, so a restart can be checked (F3+T hangs this pack).
console.info('[biomeshots] client half loaded: waits for chunks, then ' + BSC_STABLE + ' stable ticks')

ClientEvents.tick(function (event) {
  var S = global.biomeShots   // made by startup_scripts/biome_shots.js
  if (!S) return
  var active = String(S.get('active')) == 'yes'
  var window = Client.getWindow()

  if (active && !bsc.on) {
    bsc.on = true
    bsc.warned = false
    bsc.hideGui = Client.options.hideGui
    bsc.width = window.getWidth()
    bsc.height = window.getHeight()
    Client.options.hideGui = true
    window.setWindowed(BSC_WIDTH, BSC_HEIGHT)
  }
  if (!active && bsc.on) {
    bsc.on = false
    Client.options.hideGui = bsc.hideGui
    window.setWindowed(bsc.width, bsc.height)
    if (Client.screen == null) Client.mouseHandler.grabMouse()
  }
  // Keep the cursor released during a run: the mouse only turns the view while
  // it is grabbed, so a stray movement (or a remote desktop sending absolute
  // positions) can't swing the camera before a shot. Clicking the window
  // grabs it again, hence every tick.
  if (active && Client.mouseHandler.isMouseGrabbed()) Client.mouseHandler.releaseMouse()
  if (!active || String(S.get('phase')) != 'shoot') return

  // A maximized window ignores setWindowed: say so once per run (shots still
  // work, only larger).
  if (!bsc.warned && (window.getWidth() != BSC_WIDTH || window.getHeight() != BSC_HEIGHT)) {
    bsc.warned = true
    Client.player.tell('[biomeshots] The window is ' + window.getWidth() + 'x' + window.getHeight() + ', not ' + BSC_WIDTH + 'x' + BSC_HEIGHT +
      ' (maximized?). Shots are saved at that size. For smaller files: /biomeshots stop, un-maximize the window, start again.')
  }

  var seq = Number(S.get('seq'))
  if (seq != bsc.seq) {
    bsc.seq = seq
    bsc.wait = 0
    bsc.stable = 0
  }
  bsc.wait++
  var minTicks = Number(S.get('minTicks'))
  if (bsc.wait < minTicks) return
  // Ready when every chunk in view has arrived and the renderer has had
  // nothing left to build for BSC_STABLE ticks in a row. (hasRenderedAllSections
  // alone is true right after a teleport, before the chunks come in.)
  if (bscChunksIn() && Client.levelRenderer.hasRenderedAllSections()) bsc.stable++
  else bsc.stable = 0
  var rendered = bsc.stable >= BSC_STABLE
  if (!rendered && bsc.wait < minTicks + BSC_RENDER_GRACE) return

  var file = String(S.get('file'))
  try {
    BscScreenshot.grab(Client.gameDirectory, file, Client.getMainRenderTarget(), function (message) {})
    S.put('rendered', rendered ? 'yes' : 'timeout')
    console.info('[biomeshots] ' + file + ' after ' + bsc.wait + ' ticks' + (rendered ? '' : ' (still rendering)'))
  } catch (e) {
    console.error('[biomeshots] screenshot ' + file + ' failed: ' + e)
    S.put('rendered', 'failed')
  }
  S.put('phase', 'captured')
})

// While a run is active, terrain fog in open air starts near the edge of the
// render distance. Cancelling RenderFog makes NeoForge use the distances set
// here; fog in water or lava and the sky's fog are left alone. This event doesn't
// fire where BCLib draws the fog, as in the Nether: there it's fog_density in
// config/bclib/client.json that thins it.
NativeEvents.onEvent(Java.loadClass('net.neoforged.neoforge.client.event.ViewportEvent$RenderFog'), function (event) {
  if (!bsc.on) return
  if (String(event.getMode()) != 'FOG_TERRAIN' || String(event.getType()) != 'NONE') return
  var far = Client.options.getEffectiveRenderDistance() * 16
  event.setFarPlaneDistance(far)
  event.setNearPlaneDistance(far - Math.max(4, Math.min(64, far / 10)))
  event.setCanceled(true)
})

// Whether the client has every chunk within the render distance (less a margin
// of 2) around the camera.
function bscChunksIn() {
  var level = Client.level
  if (!level || !Client.player) return false
  var source = level.getChunkSource()
  var r = Math.max(2, Client.options.getEffectiveRenderDistance() - 2)
  var cx = Math.floor(Client.player.getX()) >> 4
  var cz = Math.floor(Client.player.getZ()) >> 4
  for (var dx = -r; dx <= r; dx++) {
    for (var dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue
      if (!source.hasChunk(cx + dx, cz + dz)) return false
    }
  }
  return true
}
