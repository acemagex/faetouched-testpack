// Create Ore Excavation: none of the mod's default veins are used (the author's call, 2026-10-29).
// Its coal and iron veins could generate in every overworld biome (whitelist minecraft:is_overworld),
// which would undo the coal-less overworld (knowledge/systems/materials.md). B-012 adds the pack's own
// veins, with faetouched: IDs, where its outposts go.
//
// Removed: every vein definition, and the drilling and extracting recipes that read from them
// (15, 14 and 1 in Ore Excavation 1.6.8). The machines' own crafting recipes stay.

ServerEvents.recipes(e => {
  e.remove({ type: 'createoreexcavation:vein' })
  e.remove({ type: 'createoreexcavation:drilling' })
  e.remove({ type: 'createoreexcavation:extracting' })
})
