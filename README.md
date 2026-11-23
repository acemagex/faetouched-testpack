# Faetouched test pack

A self-updating test copy of Faetouched, a Minecraft 1.21.1 modpack on NeoForge, for friends who help test it. It's built from the pack's private repository by `tools/testpack.js`; don't edit files here by hand.

## Install (once)

1. Install [Prism Launcher](https://prismlauncher.org/) and sign in with your Microsoft account.
2. In Prism, click **Add Instance**, pick **Import** on the left, and paste this link:

   `https://raw.githubusercontent.com/acemagex/faetouched-testpack/main/Faetouched-test.zip`

3. Click OK. A "Faetouched (test)" instance appears.
4. Launch it. Before the game starts, a small packwiz window downloads the mods (about 500 MB the first time). Then the game starts.

The instance asks for 10 GB of memory. If your computer has less than 16 GB, lower it: right-click the instance, **Edit** > **Settings** > **Java**, and set the maximum to about half your RAM (at least 6 GB).

## Updates

Nothing to do. Every time you press Launch, the packwiz window checks for a new version and downloads only the files that changed. If it can't reach the internet (or anything else goes wrong), it asks whether to quit or continue without updating. Continuing plays the version you already have, which is fine offline, but tell the pack's author if it keeps happening.

When the pack moves to a new NeoForge version, the window asks about "Updating MultiMC versions": click **Update**, then close the game once it's up and launch again, so the new version takes effect.

Your worlds, keybinds, video settings and shader choice are yours: updates never touch `saves/`, `options.txt` or JourneyMap's maps. A few settings files (shaders, Sodium video settings, JEI, Jade, the F3 screen) are installed once and then left alone.

## If something goes wrong

- **A window asks you to download a file by hand.** Some CurseForge authors block other programs from downloading their mods. Click the link, download that exact file, save it where the window says, and click Continue.
- **The launch stops with "Pre-Launch command failed".** You chose Quit in the packwiz window. Read its message, or send the instance's log (the **Logs** button in Prism) to the pack's author.
- **The game crashes.** Send `minecraft/crash-reports/` (newest file) and `minecraft/logs/latest.log` from the instance folder (right-click the instance > **Folder**).
