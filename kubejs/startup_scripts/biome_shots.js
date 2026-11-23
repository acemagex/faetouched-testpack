// Biome shots (B-024): the handshake map shared by server_scripts/zz_biome_shots.js
// and client_scripts/biome_shots.js. KubeJS 7 lets only startup scripts assign
// to global (client and server scripts see it read-only), so it is made here;
// the other two read it and change its entries.
global.biomeShots = new (Java.loadClass('java.util.concurrent.ConcurrentHashMap'))()
