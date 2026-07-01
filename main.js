// ============================================================================
// SmileOS - Electron Main Process (main.js)
// This is Electron's "main" process: it opens the window, accesses the file
// system, and serves the renderer (index.html) over IPC (main <-> renderer
// communication). nodeIntegration is enabled in the renderer, so index.html
// can also access fs/crypto/path directly; the checks here are an extra
// security layer (the actual file operations happen here, in the main process).
// ============================================================================

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// Supported music file extensions (also used in the file-picker filter)
const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav', '.m4a', '.flac'];
// Folder the app runs from (boss music files live here)
const APP_ROOT = __dirname;

// ----------------------------------------------------------------------------
// PROTECTED (must-be-purchased) BOSS TRACKS
// trackId -> actual file name mapping. The shop module (index.html) shows
// these ids to the user; here they get resolved to the real file.
// !! THIS LIST WAS NOT TOUCHED - audio protection behavior is unchanged !!
// ----------------------------------------------------------------------------
const BOSS_TRACK_FILES = {
    chaos: 'Heaven_Pierce_Her_-_CHAOS_ULTRAKILL_P-1_Theme_(mp3.pm).mp3',
    divine: 'Divine_Intervention.ogg',
    'war-without-reason': 'Heaven Pierce Her - War Without Reason (ULTRAKILL 7-4 Theme).mp3',
    war: 'Heaven Pierce Her - WAR (ULTRAKILL P-2 Theme #3).mp3',
    order: 'Heaven Pierce Her - ORDER (ULTRAKILL P-1 Theme #2).mp3',
    'castle-vein': 'Castle Vein ~ Combat - ULTRAKILL Soundtrack  Heaven Pierce Her.mp3',
    pandemonium: 'Heaven Pierce Her - PANDEMONIUM (ULTRAKILL P-2 Theme #2).mp3',
    'the-fall': 'Heaven Pierce Her - The Fall (ULTRAKILL 8-4 Theme).mp3',
    versus: 'Versus.mp3'
};

// Hashes are computed lazily on first use and cached here (so the files
// aren't re-read from disk every time).
let protectedMusicHashes = null;

// Returns the full (absolute) paths of all boss track files.
function getBossTrackFilePaths() {
    return Object.values(BOSS_TRACK_FILES).map(file => path.join(APP_ROOT, 'musics', file));
}

// Computes a file's SHA-256 hash. Returns null if the file can't be read
// (e.g. it was deleted/moved) so the app doesn't crash - try/catch guards it.
function hashMusicFileSync(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(data).digest('hex');
    } catch (e) {
        return null;
    }
}

// Builds a Set of hashes for every protected boss track.
// Purpose: even if the user renames the file (e.g. to "mysong.mp3"), it can
// still be caught as protected if the content matches.
function buildProtectedMusicHashes() {
    const hashes = new Set();
    getBossTrackFilePaths().forEach(filePath => {
        const hash = hashMusicFileSync(filePath);
        if (hash) hashes.add(hash);
    });
    return hashes;
}

// Lazily builds and caches the hash Set.
function getProtectedMusicHashes() {
    if (!protectedMusicHashes) protectedMusicHashes = buildProtectedMusicHashes();
    return protectedMusicHashes;
}

// Lower-cased list of the protected tracks' original file names.
function getProtectedMusicNames() {
    return Object.values(BOSS_TRACK_FILES).map(file => file.toLowerCase());
}

// Normalizes a file name: lowercases it, strips the extension, turns
// underscores/parentheses/dashes into spaces, collapses extra whitespace.
// This lets "Heaven_Pierce_Her_-_CHAOS..." and "heaven pierce her chaos"
// be compared as the same thing.
function normalizeMusicName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\.(mp3|ogg|wav|m4a|flac)$/i, '')
        .replace(/[_~#()[\].-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Fragment list used for name-based matching: both the full normalized name
// of every boss track and a few known short hints.
function getBlockedNamePatterns() {
    const patterns = new Set();
    Object.values(BOSS_TRACK_FILES).forEach(file => {
        const normalized = normalizeMusicName(file);
        if (normalized) patterns.add(normalized);
    });
    [
        'chaos ultrakill',
        'divine intervention',
        'war without reason',
        'heaven pierce her war',
        'heaven pierce her order',
        'castle vein',
        'pandemonium ultrakill',
        'the fall ultrakill'
    ].forEach(fragment => patterns.add(fragment));
    return patterns;
}

// Estimates, by FILE NAME ONLY (not content), whether a file is a protected
// boss track. Catches it even if the user renames the file before adding it.
function isBlockedByMusicName(filePath) {
    const baseName = path.basename(filePath).toLowerCase();
    if (getProtectedMusicNames().includes(baseName)) return true;

    const normalizedBase = normalizeMusicName(path.basename(filePath));
    if (!normalizedBase) return false;

    // Skip patterns shorter than 8 characters; very short patterns risk
    // false positives, blocking innocent files by accident.
    for (const pattern of getBlockedNamePatterns()) {
        if (!pattern || pattern.length < 8) continue;
        if (normalizedBase === pattern || normalizedBase.includes(pattern) || pattern.includes(normalizedBase)) {
            return true;
        }
    }

    if (normalizedBase === 'versus') return true;

    // Extra safety: if the normalized name contains (or is contained in) the
    // full normalized name of any boss file, block it too.
    for (const file of Object.values(BOSS_TRACK_FILES)) {
        const normalizedBoss = normalizeMusicName(file);
        if (normalizedBoss.length >= 14 && (normalizedBase.includes(normalizedBoss) || normalizedBoss.includes(normalizedBase))) {
            return true;
        }
    }
    return false;
}

// Main protection function: checks the name first (fast); if that doesn't
// match, computes the file's SHA-256 hash and compares it against the known
// boss-track hashes (to catch renamed-but-identical files).
function isBlockedMusicPath(filePath) {
    if (!filePath) return false;
    if (isBlockedByMusicName(filePath)) return true;
    const hash = hashMusicFileSync(filePath);
    return !!(hash && getProtectedMusicHashes().has(hash));
}

// Used by the renderer (index.html) to ask "is this file protected?".
ipcMain.handle('is-music-file-blocked', (event, filePath) => isBlockedMusicPath(filePath));

// Returns the file path of a boss track the user OWNS.
// Returns null if it's not in ownedIds -> the renderer won't play it.
ipcMain.handle('get-owned-boss-track-path', (event, trackId, ownedIds) => {
    if (!Array.isArray(ownedIds) || !ownedIds.includes(trackId)) return null;
    const fileName = BOSS_TRACK_FILES[trackId];
    if (!fileName) return null;
    const fullPath = path.join(APP_ROOT, 'musics', fileName);
    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
});

// Returns the AUDIO DATA (base64) of a boss track the user has purchased;
// the renderer turns this into a Blob and plays it with <audio>.
ipcMain.handle('get-owned-boss-track-audio', async (event, trackId, ownedIds) => {
    if (!Array.isArray(ownedIds) || !ownedIds.includes(trackId)) return null;
    const fileName = BOSS_TRACK_FILES[trackId];
    if (!fileName) return null;
    const fullPath = path.join(APP_ROOT, 'musics', fileName);
    if (!fs.existsSync(fullPath)) return null;
    const data = fs.readFileSync(fullPath);
    const ext = path.extname(fileName).toLowerCase();
    const mime = ext === '.ogg' ? 'audio/ogg' : ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
    return { base64: data.toString('base64'), mime };
});

// Shared helper: reads a file name and returns its base64 data + mime type.
// Used both for unpurchased previews and other audio reads.
function readShopAudioFile(fileName) {
    const fullPath = path.join(APP_ROOT, 'musics', fileName);
    if (!fs.existsSync(fullPath)) return null;
    const data = fs.readFileSync(fullPath);
    const ext = path.extname(fileName).toLowerCase();
    const mime = ext === '.ogg' ? 'audio/ogg' : ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
    return { base64: data.toString('base64'), mime };
}

// Used by the shop for "preview" playback (lets the user hear a short clip
// even before purchasing) - returns the full file, the renderer enforces
// the time limit.
ipcMain.handle('get-boss-track-preview-audio', async (event, trackId) => {
    const fileName = BOSS_TRACK_FILES[trackId];
    if (!fileName) return null;
    return readShopAudioFile(fileName);
});

// ----------------------------------------------------------------------------
// SYSTEM STATS (NEW - index.html used to call this but main.js had no
// handler for it, so CPU/RAM always showed random/fake numbers. Real values
// are computed here now.)
// ----------------------------------------------------------------------------
ipcMain.handle('get-system-stats', () => {
    // RAM usage: total memory minus free memory, as a percentage.
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ramPercent = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0;

    // CPU usage: for an instant reading, the 1-minute load average is
    // divided by the core count to get a rough percentage. On Windows,
    // loadavg usually returns 0; in that case a simple fallback computes
    // the idle/total ratio across cores via os.cpus().
    const cpuCount = os.cpus().length || 1;
    let cpuPercent = (os.loadavg()[0] / cpuCount) * 100;
    if (!cpuPercent || Number.isNaN(cpuPercent)) {
        const cpus = os.cpus();
        let idleSum = 0, totalSum = 0;
        cpus.forEach(core => {
            const times = core.times;
            const total = times.user + times.nice + times.sys + times.idle + times.irq;
            idleSum += times.idle;
            totalSum += total;
        });
        cpuPercent = totalSum > 0 ? (1 - idleSum / totalSum) * 100 : 0;
    }

    return {
        cpu: Math.min(100, Math.max(0, cpuPercent)),
        ram: Math.min(100, Math.max(0, ramPercent))
    };
});

// ----------------------------------------------------------------------------
// "OYUNLAR" / "EKSTRA" (GAMES / EXTRA) FOLDER PATHS (FIXED)
// BEFORE: the path was hardcoded directly in the code ->
// "C:\Users\Özdemir\Desktop\oyunlar". That only worked on the original
// developer's own machine; anyone who downloaded this from GitHub would
// have the button silently do nothing, since the folder wouldn't exist.
// NOW: the paths are read from config.json. If the file doesn't exist it's
// created automatically, defaulting to the "oyunlar" and "ekstra" folders
// next to the app. Anyone can open config.json and point it at their own
// folders.
// ----------------------------------------------------------------------------
const CONFIG_PATH = path.join(APP_ROOT, 'config.json');

function loadFolderConfig() {
    const defaults = {
        oyunlarPath: path.join(APP_ROOT, 'oyunlar'),
        ekstraPath: path.join(APP_ROOT, 'ekstra')
    };
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            return {
                oyunlarPath: parsed.oyunlarPath || defaults.oyunlarPath,
                ekstraPath: parsed.ekstraPath || defaults.ekstraPath
            };
        }
        // First launch: config.json doesn't exist yet, create it with defaults.
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 4), 'utf-8');
    } catch (e) {
        console.error('Could not read/create config.json:', e);
    }
    return defaults;
}

function openFolderOrWarn(folderPath, win) {
    if (!fs.existsSync(folderPath)) {
        dialog.showMessageBox(win, {
            type: 'warning',
            title: 'Folder Not Found',
            message: `Folder not found:\n${folderPath}\n\nYou can set the correct path in config.json.`
        });
        return;
    }
    shell.openPath(folderPath).then(result => {
        if (result) console.error('Folder open error:', result);
        else console.log('Folder opened:', folderPath);
    });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1200, height: 800,
        webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true }
    });
    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

// ----------------------------------------------------------------------------
// macOS/Linux LIFECYCLE FIX (ADDED)
// These events used to be missing:
//  - When all windows were closed, the app kept running in the background
//    (the user would think it had fully quit when it hadn't).
//  - Clicking the dock icon again on macOS wouldn't reopen a window.
// This is a standard Electron pattern that was missing - now added.
// ----------------------------------------------------------------------------
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Request to open the "Games" / "Extra" folders (buttons in the left menu).
ipcMain.on('launch-app', (event, appName) => {
    console.log('launch-app received:', appName);
    const folders = loadFolderConfig();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (appName === 'oyunlar') {
        console.log('Opening:', folders.oyunlarPath);
        openFolderOrWarn(folders.oyunlarPath, win);
    } else if (appName === 'ekstra') {
        console.log('Opening:', folders.ekstraPath);
        openFolderOrWarn(folders.ekstraPath, win);
    }
});

// Window control buttons (the -, +, X buttons in the title bar).
ipcMain.on('window-control', (event, action) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;
    if (action === 'close') win.close();
    else if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
});

// Opens the system file picker so the user can choose music files from
// their own computer. Any selected file that's a protected boss track gets
// filtered out here (in the main process); only allowed files are returned
// to the renderer - the `blocked` count reports how many were rejected.
ipcMain.handle('pick-music-files', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Music', extensions: ['mp3', 'ogg', 'wav', 'm4a', 'flac'] }]
    });
    if (result.canceled) return { files: [], blocked: 0 };
    const files = [];
    let blocked = 0;
    result.filePaths.forEach(filePath => {
        if (isBlockedMusicPath(filePath)) blocked++;
        else files.push(filePath);
    });
    return { files, blocked };
});