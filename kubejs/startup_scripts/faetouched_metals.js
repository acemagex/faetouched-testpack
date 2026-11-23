// Faetouched metals (B-017, knowledge/systems/materials.md): items, blocks and the quicksilver fluid.
// Barebones on purpose: every metal exists so it can be adjusted later.
// Recipes and tags: server_scripts/faetouched_metals.js. Worldgen, ore loot tables: kubejs/data/faetouched/.
// Textures are scripted placeholders (tools/placeholder-art.mjs, listed in kubejs/placeholders-faetouched.md);
// the ore blocks use hand-written two-layer models in kubejs/assets/faetouched/models/block/.
// Rhino rejects const/let redeclared inside loop bodies, so this file uses var and forEach.

var NS = 'faetouched'
function fid(path) { return NS + ':' + path }

// [key, display name]: the first twelve get storage blocks, the last three are rare items only.
var METALS = [
  ['tin', 'Tin'], ['lead', 'Lead'], ['silver', 'Silver'], ['nickel', 'Nickel'],
  ['cobalt', 'Cobalt'], ['antimony', 'Antimony'], ['steel', 'Steel'], ['bronze', 'Bronze'],
  ['bell_bronze', 'Bell Bronze'], ['electrum', 'Electrum'], ['pewter', 'Pewter'], ['type_metal', 'Type Metal'],
  ['sidhe_silver', 'Sidhe-silver'], ['argetlam', 'Argetlam'], ['starfall_iron', 'Starfall Iron']
]
var RARE = ['sidhe_silver', 'argetlam', 'starfall_iron']
var SHEETS = [['tin', 'Tin'], ['lead', 'Lead'], ['silver', 'Silver'], ['bronze', 'Bronze'], ['steel', 'Steel']]

// [ore key, ore name, raw item, raw item name, deepslate hardness]
var ORES = [
  ['tin', 'Tinstone', 'raw_tin', 'Raw Tin'],
  ['galena', 'Galena', 'raw_galena', 'Raw Galena'],
  ['nickel', 'Kupfernickel', 'raw_nickel', 'Raw Kupfernickel'],
  ['cobalt', 'Kobold Ore', 'raw_cobalt', 'Raw Kobold Ore'],
  ['stibnite', 'Stibnite', 'raw_stibnite', 'Raw Stibnite'],
  ['cinnabar', 'Cinnabar Ore', 'cinnabar', 'Cinnabar']
]

StartupEvents.registry('item', e => {
  METALS.forEach(m => {
    e.create(fid(m[0] + '_ingot')).displayName(m[1] + ' Ingot')
    e.create(fid(m[0] + '_nugget')).displayName(m[1] + ' Nugget')
  })
  SHEETS.forEach(m => e.create(fid(m[0] + '_sheet')).displayName(m[1] + ' Sheet'))
  ORES.forEach(o => e.create(fid(o[2])).displayName(o[3]))
  e.create(fid('steel_rod')).displayName('Steel Rod')
  e.create(fid('crushed_raw_cobalt')).displayName('Crushed Kobold Ore')
})

StartupEvents.registry('block', e => {
  METALS.forEach(m => {
    if (RARE.indexOf(m[0]) >= 0) return
    e.create(fid(m[0] + '_block')).displayName('Block of ' + m[1])
      .hardness(5).resistance(6).requiresTool(true).stoneSoundType()
  })
  // Ore drops come from the loot tables in kubejs/data/faetouched/loot_table/blocks/ (Fortune, Silk Touch);
  // they replace KubeJS's generated self-drop tables. Don't call noDrops(): it disables loot tables entirely.
  ORES.forEach(o => {
    e.create(fid(o[0] + '_ore')).displayName(o[1])
      .hardness(3).resistance(3).requiresTool(true).stoneSoundType()
    e.create(fid('deepslate_' + o[0] + '_ore')).displayName('Deepslate ' + o[1])
      .hardness(4.5).resistance(3).requiresTool(true).stoneSoundType()
  })
  // Bog iron: shovel-mined patches in swamp mud and river beds; drops vanilla raw iron.
  e.create(fid('bog_ore')).displayName('Bog Ore')
    .hardness(0.8).resistance(0.8).requiresTool(true).gravelSoundType()
})

StartupEvents.registry('fluid', e => {
  // 'thick' uses KubeJS's own still and flowing textures, tinted, so no art is needed; the bucket is automatic.
  e.create(fid('quicksilver'), 'thick').tint(0xC8CED6).displayName('Quicksilver')
})
