// Structure Dev (B-044; knowledge/playbooks/structure-dev.md): /structuredev save <structure> writes every
// save-mode structure block named faetouched:<structure>/... within 16 chunks of the player to disk.
// A structure block powered by redstone saves only to memory (vanilla passes writeToDisk = false), so the
// layout's boxes are saved here with StructureBlockEntity.saveStructure(true), as the block's own Save button
// does. The files land in <world>/generated/faetouched/structures/; tools/structure-dev.js export reads them.
// /structuredev list <structure> only counts the boxes.

var DevCommands = Java.loadClass('net.minecraft.commands.Commands')
var DevString = Java.loadClass('com.mojang.brigadier.arguments.StringArgumentType')
var DevBlockEntityType = Java.loadClass('net.minecraft.world.level.block.entity.BlockEntityType')

var DEV_RADIUS_CHUNKS = 16

// Every save-mode structure block whose name starts with faetouched:<structure>/, in loaded chunks near pos.
function devFindBoxes(level, pos, structure) {
  var prefix = 'faetouched:' + structure + '/'
  var found = []
  var cx0 = Math.floor(pos.x() / 16)
  var cz0 = Math.floor(pos.z() / 16)
  var source = level.getChunkSource()
  for (var cx = cx0 - DEV_RADIUS_CHUNKS; cx <= cx0 + DEV_RADIUS_CHUNKS; cx++) {
    for (var cz = cz0 - DEV_RADIUS_CHUNKS; cz <= cz0 + DEV_RADIUS_CHUNKS; cz++) {
      var chunk = source.getChunkNow(cx, cz)
      if (chunk == null) continue
      var it = chunk.getBlockEntities().values().iterator()
      while (it.hasNext()) {
        var be = it.next()
        if (be.getType() != DevBlockEntityType.STRUCTURE_BLOCK) continue
        var name = String(be.getStructureName())
        if (name.indexOf(prefix) != 0) continue
        if (String(be.getMode().name()) != 'SAVE') continue
        found.push({ be: be, name: name })
      }
    }
  }
  found.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0 })
  return found
}

function devRun(ctx, save) {
  var structure = String(DevString.getString(ctx, 'structure'))
  var src = ctx.source
  var boxes = devFindBoxes(src.getLevel(), src.getPosition(), structure)
  if (boxes.length == 0) {
    src.sendFailure(Text.of('Structure Dev: no save-mode structure blocks named faetouched:' + structure + '/... within ' + DEV_RADIUS_CHUNKS + ' chunks (is the layout built and loaded?)'))
    return 0
  }
  if (!save) {
    src.sendSystemMessage(Text.of('Structure Dev: ' + boxes.length + ' boxes for ' + structure + ': ' + boxes.map(function (b) { return b.name.substring(('faetouched:' + structure + '/').length) }).join(', ')))
    return boxes.length
  }
  var saved = 0
  var failed = []
  boxes.forEach(function (b) {
    var ok = false
    var why = 'the game refused (empty name or box?)'
    try { ok = b.be.saveStructure(true) } catch (e) { ok = false; why = String(e) }
    if (ok) saved++
    else failed.push(b.name + ' (' + why + ')')
  })
  src.sendSystemMessage(Text.of('Structure Dev: saved ' + saved + ' of ' + boxes.length + ' pieces of ' + structure + ' to disk.'))
  if (failed.length > 0) src.sendFailure(Text.of('Structure Dev: not saved: ' + failed.join(', ')))
  return saved
}

ServerEvents.commandRegistry(function (event) {
  event.register(DevCommands.literal('structuredev')
    .requires(function (src) { return src.hasPermission(2) })
    .then(DevCommands.literal('save')
      .then(DevCommands.argument('structure', DevString.word())
        .executes(function (ctx) { return devRun(ctx, true) })))
    .then(DevCommands.literal('list')
      .then(DevCommands.argument('structure', DevString.word())
        .executes(function (ctx) { return devRun(ctx, false) }))))
})
