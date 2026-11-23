// Faetouched metals (B-017, knowledge/systems/materials.md): tags and barebones recipes.
// Items and blocks: startup_scripts/faetouched_metals.js. Every recipe gets an explicit faetouched: ID (CLAUDE.md).
// Every ID built here is listed in reference/dumps/extra-ids.txt until the dumps are refreshed.
// Rhino rejects const/let redeclared inside loop bodies, so this file uses var and forEach.
//
// Create 6 ships crushing recipes that switch on when these item tags have members, so the pack adds none for them:
// the tin, nickel and quicksilver ores and raw materials. Galena uses its own tags (ores and raw_materials "galena")
// so Create's lead crushing doesn't fire; its own recipe adds the silver by-product.
//
// In Create recipes a plain '#tag' string is read as a fluid tag: use Ingredient.of('#tag') or item IDs there.

var NS = 'faetouched'
function fid(path) { return NS + ':' + path }
function rid(path) { return fid('metals/' + path) }
// Common tag names, e.g. ctag('ingots', 'tin') is c:ingots/tin.
function ctag(kind, name) { return 'c' + ':' + kind + (name ? '/' + name : '') }

var METALS = ['tin', 'lead', 'silver', 'nickel', 'cobalt', 'antimony', 'steel', 'bronze',
  'bell_bronze', 'electrum', 'pewter', 'type_metal', 'sidhe_silver', 'argetlam', 'starfall_iron']
var RARE = ['sidhe_silver', 'argetlam', 'starfall_iron']
var BLOCK_METALS = METALS.filter(m => RARE.indexOf(m) < 0)
var SHEETS = ['tin', 'lead', 'silver', 'bronze', 'steel']

// [ore key, common tag name, raw item, needs-tool tag]
var ORES = [
  ['tin', 'tin', 'raw_tin', 'minecraft:needs_stone_tool'],
  ['galena', 'galena', 'raw_galena', 'minecraft:needs_stone_tool'],
  ['nickel', 'nickel', 'raw_nickel', 'minecraft:needs_iron_tool'],
  ['cobalt', 'cobalt', 'raw_cobalt', 'minecraft:needs_iron_tool'],
  ['stibnite', 'antimony', 'raw_stibnite', 'minecraft:needs_stone_tool'],
  ['cinnabar', 'quicksilver', 'cinnabar', 'minecraft:needs_stone_tool']
]

// Adds a member to c:<kind>/<name> and that tag to its parent c:<kind>.
function addCommon(e, kind, name, members) {
  e.add(ctag(kind, name), members)
  e.add(ctag(kind), '#' + ctag(kind, name))
}

ServerEvents.tags('block', e => {
  ORES.forEach(o => {
    var stone = fid(o[0] + '_ore')
    var deep = fid('deepslate_' + o[0] + '_ore')
    e.add('minecraft:mineable/pickaxe', [stone, deep])
    e.add(o[3], [stone, deep])
    addCommon(e, 'ores', o[1], [stone, deep])
    e.add('c:ores_in_ground/stone', stone)
    e.add('c:ores_in_ground/deepslate', deep)
  })
  e.add('minecraft:mineable/shovel', fid('bog_ore'))
  e.add('c:ores/iron', fid('bog_ore'))
  BLOCK_METALS.forEach(m => {
    e.add('minecraft:mineable/pickaxe', fid(m + '_block'))
    e.add('minecraft:needs_stone_tool', fid(m + '_block'))
    addCommon(e, 'storage_blocks', m, fid(m + '_block'))
  })
})

ServerEvents.tags('item', e => {
  ORES.forEach(o => {
    // Create's crushing gates test the item tag, so the ore items need it too.
    addCommon(e, 'ores', o[1], [fid(o[0] + '_ore'), fid('deepslate_' + o[0] + '_ore')])
    e.add('c:ores_in_ground/stone', fid(o[0] + '_ore'))
    e.add('c:ores_in_ground/deepslate', fid('deepslate_' + o[0] + '_ore'))
    addCommon(e, 'raw_materials', o[1], fid(o[2]))
  })
  e.add('c:ores/iron', fid('bog_ore'))
  METALS.forEach(m => {
    addCommon(e, 'ingots', m, fid(m + '_ingot'))
    addCommon(e, 'nuggets', m, fid(m + '_nugget'))
  })
  BLOCK_METALS.forEach(m => addCommon(e, 'storage_blocks', m, fid(m + '_block')))
  SHEETS.forEach(m => addCommon(e, 'plates', m, fid(m + '_sheet')))
  addCommon(e, 'rods', 'steel', fid('steel_rod'))
})

ServerEvents.recipes(e => {
  // Smelting and blasting with the same input and output, named <metal>/<output>_from_<input>_<type>.
  function cook(metal, output, input, name, xp) {
    e.smelting(output, input).xp(xp).id(rid(metal + '/' + name + '_smelting'))
    e.blasting(output, input).xp(xp).id(rid(metal + '/' + name + '_blasting'))
  }
  cook('tin', fid('tin_ingot'), '#' + ctag('ores', 'tin'), 'tin_ingot_from_ore', 0.7)
  cook('tin', fid('tin_ingot'), fid('raw_tin'), 'tin_ingot_from_raw', 0.7)
  cook('tin', fid('tin_ingot'), 'create:crushed_raw_tin', 'tin_ingot_from_crushed', 0.1)
  cook('lead', fid('lead_ingot'), '#' + ctag('ores', 'galena'), 'lead_ingot_from_ore', 0.7)
  cook('lead', fid('lead_ingot'), fid('raw_galena'), 'lead_ingot_from_raw', 0.7)
  cook('lead', fid('lead_ingot'), 'create:crushed_raw_lead', 'lead_ingot_from_crushed', 0.1)
  cook('silver', fid('silver_ingot'), 'create:crushed_raw_silver', 'silver_ingot_from_crushed', 0.1)
  cook('nickel', fid('nickel_ingot'), '#' + ctag('ores', 'nickel'), 'nickel_ingot_from_ore', 0.7)
  cook('nickel', fid('nickel_ingot'), fid('raw_nickel'), 'nickel_ingot_from_raw', 0.7)
  cook('nickel', fid('nickel_ingot'), 'create:crushed_raw_nickel', 'nickel_ingot_from_crushed', 0.1)
  cook('cobalt', fid('cobalt_ingot'), '#' + ctag('ores', 'cobalt'), 'cobalt_ingot_from_ore', 0.7)
  cook('cobalt', fid('cobalt_ingot'), fid('raw_cobalt'), 'cobalt_ingot_from_raw', 0.7)
  cook('cobalt', fid('cobalt_ingot'), fid('crushed_raw_cobalt'), 'cobalt_ingot_from_crushed', 0.1)
  cook('antimony', fid('antimony_ingot'), '#' + ctag('ores', 'antimony'), 'antimony_ingot_from_ore', 0.7)
  cook('antimony', fid('antimony_ingot'), fid('raw_stibnite'), 'antimony_ingot_from_raw', 0.7)
  cook('iron', 'minecraft:iron_ingot', fid('bog_ore'), 'iron_ingot_from_bog_ore', 0.7)

  // Steel starts as a plain blast-furnace recipe (the author's call, 2026-10-28).
  e.blasting(fid('steel_ingot'), 'minecraft:iron_ingot').xp(0.5).id(rid('steel/steel_ingot_from_iron_ingot_blasting'))

  // Nuggets, ingots and blocks.
  METALS.forEach(m => {
    e.shaped(fid(m + '_ingot'), ['NNN', 'NNN', 'NNN'], { N: fid(m + '_nugget') }).id(rid(m + '/' + m + '_ingot_from_nuggets'))
    e.shapeless(Item.of(fid(m + '_nugget'), 9), [fid(m + '_ingot')]).id(rid(m + '/' + m + '_nugget_from_ingot'))
  })
  BLOCK_METALS.forEach(m => {
    e.shaped(fid(m + '_block'), ['III', 'III', 'III'], { I: fid(m + '_ingot') }).id(rid(m + '/' + m + '_block_from_ingots'))
    e.shapeless(Item.of(fid(m + '_ingot'), 9), [fid(m + '_block')]).id(rid(m + '/' + m + '_ingot_from_block'))
  })

  // Create: sheets, rods, crushing.
  SHEETS.forEach(m => {
    e.recipes.create.pressing(fid(m + '_sheet'), fid(m + '_ingot')).id(rid(m + '/' + m + '_sheet_pressing'))
  })
  e.recipes.create.cutting(Item.of(fid('steel_rod'), 2), fid('steel_ingot')).id(rid('steel/steel_rod_cutting'))

  e.recipes.create.crushing([
    CreateItem.of('create:crushed_raw_lead', 1), CreateItem.of('create:crushed_raw_lead', 0.75),
    CreateItem.of('create:crushed_raw_silver', 0.3), CreateItem.of('create:experience_nugget', 0.75)
  ], Ingredient.of('#' + ctag('ores', 'galena'))).processingTime(400).id(rid('lead/crushed_raw_lead_from_ore_crushing'))
  e.recipes.create.crushing([
    CreateItem.of('create:crushed_raw_lead', 1), CreateItem.of('create:crushed_raw_silver', 0.3),
    CreateItem.of('create:experience_nugget', 0.75)
  ], fid('raw_galena')).processingTime(400).id(rid('lead/crushed_raw_lead_from_raw_crushing'))
  e.recipes.create.crushing([
    CreateItem.of(fid('crushed_raw_cobalt'), 1), CreateItem.of(fid('crushed_raw_cobalt'), 0.75),
    CreateItem.of('create:experience_nugget', 0.75)
  ], Ingredient.of('#' + ctag('ores', 'cobalt'))).processingTime(400).id(rid('cobalt/crushed_raw_cobalt_from_ore_crushing'))
  e.recipes.create.crushing([
    CreateItem.of(fid('crushed_raw_cobalt'), 1), CreateItem.of('create:experience_nugget', 0.75)
  ], fid('raw_cobalt')).processingTime(400).id(rid('cobalt/crushed_raw_cobalt_from_raw_crushing'))
  e.recipes.create.crushing([
    CreateItem.of('create:crushed_raw_iron', 1), CreateItem.of('create:crushed_raw_iron', 0.75),
    CreateItem.of('create:experience_nugget', 0.75)
  ], fid('bog_ore')).processingTime(250).id(rid('iron/crushed_raw_iron_from_bog_ore_crushing'))

  // Alloys: Create mixing with no heat (heat tiers come later with Create Heat JS).
  // A basin runs the matching recipe with the most ingredients, so no alloy's inputs may be a subset of a
  // bigger one's: bell bronze is made from bronze, and type metal (with lead) outranks pewter.
  function mix(metal, count, inputs) {
    e.recipes.create.mixing(Item.of(fid(metal + '_ingot'), count), inputs).id(rid(metal + '/' + metal + '_ingot_mixing'))
  }
  mix('bronze', 4, ['3x minecraft:copper_ingot', fid('tin_ingot')])
  mix('bell_bronze', 4, ['3x ' + fid('bronze_ingot'), fid('tin_ingot')])
  mix('electrum', 2, ['minecraft:gold_ingot', fid('silver_ingot')])
  mix('pewter', 4, ['3x ' + fid('tin_ingot'), fid('antimony_ingot')])
  mix('type_metal', 6, ['4x ' + fid('lead_ingot'), fid('tin_ingot'), fid('antimony_ingot')])
  mix('argetlam', 4, ['2x ' + fid('silver_ingot'), fid('sidhe_silver_ingot'), fid('tin_ingot')])

  // Quicksilver: a fluid test (the author's call); barebones, no heat.
  e.recipes.create.mixing(Fluid.of(fid('quicksilver'), 250), 'create:crushed_raw_quicksilver')
    .id(rid('quicksilver/quicksilver_mixing'))
})
