#!/usr/bin/env node

/**
 * Lightweight Express File Server with Web Interface
 * Features: File browsing, uploading, downloading, admin/viewer modes, real-time updates
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const archiver = require('archiver');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const mime = require('mime-types');
const crypto = require('crypto');
const { promisify } = require('util');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const Y = require('yjs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// Configuration
const CONFIG_FILE = "config.json"; // Configuration file for persistent data

// CORS middleware will be configured after config loading

// Basic middleware setup (before config loading)
app.use(express.static('public'));

// Set UTF-8 charset for all responses
app.use((req, res, next) => {
    res.setHeader('Content-Type', res.getHeader('Content-Type') || 'text/html; charset=utf-8');
    next();
});
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    store: new MemoryStore({
        checkPeriod: 86400000 // prune expired entries every 24h
    }),
    cookie: {
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Multer will be configured after config loading

// Template engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Global variables for undo functionality and shared text
let lastOperation = null;

// Ensure config has a normalized `profiles` array. Old single-folder configs
// (no `profiles`) are upgraded in-memory to a single "default" profile built
// from the legacy top-level fields, so they keep working unchanged.
function ensureProfiles(cfg) {
    if (!Array.isArray(cfg.profiles) || cfg.profiles.length === 0) {
        cfg.profiles = [{
            name: "default",
            subnets: [],
            upload_directory: cfg.upload_directory || "./uploads",
            smb_url: cfg.smb_url || "",
            smb_button_text: cfg.smb_button_text || ""
        }];
    }
    // Normalize each profile's fields. A profile with a non-empty `shares`
    // array is a "switcher" (no folder of its own — its users pick which share
    // to view); everything else is a normal folder profile.
    cfg.profiles = cfg.profiles.map((p, i) => {
        const name = p.name || `profile${i + 1}`;
        const subnets = Array.isArray(p.subnets) ? p.subnets : (p.subnets ? [p.subnets] : []);
        if (Array.isArray(p.shares) && p.shares.length > 0) {
            return { name, subnets, label: p.label || name, shares: p.shares.slice() };
        }
        const label = p.label || name;
        return {
            name,
            subnets,
            label,                                          // friendly display name
            home_label: p.home_label || `Home of ${label}`, // heading shown on the home page
            upload_directory: p.upload_directory || "./uploads",
            smb_url: p.smb_url || "",
            smb_button_text: p.smb_button_text || ""
        };
    });
    return cfg;
}

// Load configuration
function loadConfig() {
    const defaultConfig = {
        shared_text: "Welcome",
        admin_password: "admin123",
        port: 80,
        upload_directory: "./uploads",
        max_file_size: "500MB",
        temp_upload_directory: "temp_uploads",
        request_size_limit: "500mb",
        cors_origins: "same-origin",
        enable_api_restrictions: true
    };

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            const loadedConfig = JSON.parse(data);
            // Ensure required fields exist in config
            if (!loadedConfig.admin_password) {
                loadedConfig.admin_password = defaultConfig.admin_password;
            }
            if (!loadedConfig.port) {
                loadedConfig.port = defaultConfig.port;
            }
            if (!loadedConfig.upload_directory) {
                loadedConfig.upload_directory = defaultConfig.upload_directory;
            }
            if (!loadedConfig.max_file_size) {
                loadedConfig.max_file_size = defaultConfig.max_file_size;
            }
            if (!loadedConfig.temp_upload_directory) {
                loadedConfig.temp_upload_directory = defaultConfig.temp_upload_directory;
            }
            if (!loadedConfig.request_size_limit) {
                loadedConfig.request_size_limit = defaultConfig.request_size_limit;
            }
            if (!loadedConfig.cors_origins) {
                loadedConfig.cors_origins = defaultConfig.cors_origins;
            }
            if (loadedConfig.enable_api_restrictions === undefined) {
                loadedConfig.enable_api_restrictions = defaultConfig.enable_api_restrictions;
            }
            return ensureProfiles(loadedConfig);
        } catch (e) {
            console.log(`Error loading config: ${e.message}`);
        }
    } else {
        // console.log(`Config file ${CONFIG_FILE} not found, using defaults`);
    }

    return ensureProfiles(defaultConfig);
}

// Save configuration
function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.log(`Warning: Failed to save config: ${e.message}`);
        return false;
    }
}

// Load initial configuration
let config = loadConfig();
let sharedTextContent = { content: config.shared_text || "" };

// Yjs collaborative document for shared text
const ydoc = new Y.Doc();
const ytext = ydoc.getText('shared_text');

// Initialize Y.Text from persisted content
const initialSharedText = config.shared_text || '';
if (initialSharedText) {
    ytext.insert(0, initialSharedText);
}

// Debounced persistence for Y.Text changes
let persistYTextTimer = null;
function persistYText() {
    clearTimeout(persistYTextTimer);
    persistYTextTimer = setTimeout(() => {
        const content = ytext.toString();
        sharedTextContent.content = content;
        config.shared_text = content;
        saveConfig(config);
    }, 1000);
}
const PORT = process.env.PORT || config.port || 80;
// Per-profile base directories are resolved per request via getBaseDir(req).
// getProfileDir() resolves a profile's upload_directory to an absolute path.
function getProfileDir(profile) {
    return path.resolve(profile.upload_directory || "./uploads");
}

// ---------------------------------------------------------------------------
// Cloudflare quick tunnel (public upload link)
// ---------------------------------------------------------------------------
const TUNNEL_HOURS = Number(config.tunnel_duration_hours) || 4;
// Path to the cloudflared binary. Defaults to "cloudflared" on PATH; set
// "cloudflared_path" in config.json to an absolute path if it isn't on PATH.
const CLOUDFLARED_BIN = config.cloudflared_path || 'cloudflared';

// One tunnel per profile. tunnels[name] = { proc, timer, state }, where state is
// the client-facing status. Each profile's public URL carries ?share=<name> so
// tunnel visitors land on (and stay pinned to) that profile's folder.
const tunnels = new Map();
function inactiveState() {
    return { active: false, url: null, qr: null, startedAt: null, expiresAt: null };
}
function getTunnel(name) {
    if (!tunnels.has(name)) tunnels.set(name, { proc: null, timer: null, state: inactiveState() });
    return tunnels.get(name);
}
function emitTunnel(name, extra) {
    io.emit('tunnel_updated', { profile: name, ...getTunnel(name).state, ...(extra || {}) });
}

// Public status for all configured profiles: { name: state, ... }
function tunnelStatusAll() {
    const out = {};
    for (const p of config.profiles) if (isFolderProfile(p)) out[p.name] = getTunnel(p.name).state;
    return out;
}

function stopTunnel(name) {
    const t = getTunnel(name);
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    const proc = t.proc;
    t.proc = null;
    if (proc) {
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
            } else {
                proc.kill('SIGTERM');
            }
        } catch (e) {
            console.log(`Warning: failed to stop tunnel "${name}": ${e.message}`);
        }
    }
    t.state = inactiveState();
    emitTunnel(name);
}

function stopAllTunnels() {
    for (const name of tunnels.keys()) stopTunnel(name);
}

function startTunnel(name) {
    if (!profileByName(name)) return null;
    const t = getTunnel(name);
    if (t.state.active || t.proc) return t.state;

    let proc;
    try {
        proc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${PORT}`]);
    } catch (e) {
        console.log(`Failed to launch cloudflared ("${CLOUDFLARED_BIN}"): ${e.message}`);
        emitTunnel(name, { error: 'cloudflared not found' });
        return t.state;
    }
    t.proc = proc;

    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    let captured = false;

    const handleOutput = (data) => {
        if (captured) return;
        const match = String(data).match(urlRegex);
        if (!match) return;
        captured = true;
        // Pin tunnel visitors to this profile's folder via ?share=<name>.
        const shareUrl = `${match[0]}/?share=${encodeURIComponent(name)}`;
        QRCode.toDataURL(shareUrl, { margin: 1, width: 320 })
            .then((qr) => {
                const startedAt = Date.now();
                t.state = {
                    active: true,
                    url: shareUrl,
                    qr,
                    startedAt,
                    expiresAt: startedAt + TUNNEL_HOURS * 3600 * 1000
                };
                if (t.timer) clearTimeout(t.timer);
                t.timer = setTimeout(() => stopTunnel(name), TUNNEL_HOURS * 3600 * 1000);
                console.log(`Cloudflare tunnel "${name}" active: ${shareUrl} (auto-closes in ${TUNNEL_HOURS}h)`);
                emitTunnel(name);
            })
            .catch((e) => {
                console.log(`Failed to generate QR code for "${name}": ${e.message}`);
                emitTunnel(name, { error: 'qr_failed' });
            });
    };

    proc.stdout.on('data', handleOutput);
    proc.stderr.on('data', handleOutput);

    proc.on('error', (e) => {
        const hint = e.code === 'ENOENT'
            ? ` — "${CLOUDFLARED_BIN}" not found. Install cloudflared or set "cloudflared_path" in config.json to its absolute path.`
            : '';
        console.log(`cloudflared error ("${name}"): ${e.message}${hint}`);
        if (t.proc === proc) {
            t.proc = null;
            t.state = inactiveState();
            emitTunnel(name, { error: 'cloudflared not found' });
        }
    });

    proc.on('exit', () => {
        // Covers crashes / external termination
        if (t.proc === proc) {
            t.proc = null;
            if (t.timer) { clearTimeout(t.timer); t.timer = null; }
            t.state = inactiveState();
            emitTunnel(name);
        }
    });

    return t.state;
}

// Clean up all tunnels on server shutdown so no orphan cloudflared survives
['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => {
        stopAllTunnels();
        process.exit(0);
    });
});

// Ensure config file exists with current data
if (!fs.existsSync(CONFIG_FILE)) {
    // console.log("Creating initial config file...");
    saveConfig(config);
} else {
    // If config exists but doesn't have required fields, update it
    let needsUpdate = false;
    if (!config.admin_password) {
        config.admin_password = "admin123";
        needsUpdate = true;
    }
    if (!config.port) {
        config.port = 80;
        needsUpdate = true;
    }
    if (!config.max_file_size) {
        config.max_file_size = "500MB";
        needsUpdate = true;
    }
    if (!config.temp_upload_directory) {
        config.temp_upload_directory = "temp_uploads";
        needsUpdate = true;
    }
    if (!config.request_size_limit) {
        config.request_size_limit = "500mb";
        needsUpdate = true;
    }
    if (!config.cors_origins) {
        config.cors_origins = "same-origin";
        needsUpdate = true;
    }
    if (config.enable_api_restrictions === undefined) {
        config.enable_api_restrictions = true;
        needsUpdate = true;
    }
    if (needsUpdate) {
        saveConfig(config);
    }
}

// Create each folder profile's base directory if it doesn't exist
for (const profile of config.profiles) {
    if (!isFolderProfile(profile)) continue;
    const dir = getProfileDir(profile);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Create temp upload directory if it doesn't exist
const TEMP_DIR = path.resolve(config.temp_upload_directory);
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Subnet-aware profile resolution
// A profile = { name, subnets[], upload_directory, smb_url, smb_button_text }.
// LAN visitors are matched to a profile by their client IP subnet; visitors
// arriving through a Cloudflare tunnel are pinned to a profile via the
// ?share=<name> marker carried by each per-profile tunnel URL (stored in the
// session so it persists across navigation and API calls).
// ---------------------------------------------------------------------------
function clientIp(req) {
    let ip = (req.socket && req.socket.remoteAddress) || '';
    // Normalize IPv4-mapped IPv6 (e.g. ::ffff:192.168.2.5)
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

function ipToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        const o = Number(p);
        if (!Number.isInteger(o) || o < 0 || o > 255) return null;
        n = (n * 256) + o;
    }
    return n >>> 0;
}

// IPv4-only CIDR membership test, e.g. ipInCidr("192.168.2.5", "192.168.2.0/24")
function ipInCidr(ip, cidr) {
    const [net, bitsStr] = String(cidr).split('/');
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const ipInt = ipToInt(ip);
    const netInt = ipToInt(net);
    if (ipInt === null || netInt === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (ipInt & mask) === (netInt & mask);
}

function profileByName(name) {
    if (!name) return null;
    return config.profiles.find(p => p.name === name) || null;
}

// A folder profile owns an upload_directory; a switcher profile has a `shares`
// allowlist instead and lets its users pick which folder profile to view.
function isFolderProfile(p) {
    return !!p && (!Array.isArray(p.shares) || p.shares.length === 0);
}
function switcherShares(p) {
    if (!p || !Array.isArray(p.shares)) return [];
    return p.shares.filter(n => isFolderProfile(profileByName(n)));
}

// Detect requests arriving through a Cloudflare tunnel (host ends in
// trycloudflare.com). Reused by profile resolution and SMB-button hiding.
function isTunnelRequest(req) {
    const host = (req.headers.host || '').toLowerCase().split(':')[0];
    return host.endsWith('.trycloudflare.com');
}

// Resolve the profile a request matches, or null if none applies (=> 403 deny).
// May return a switcher profile; getEffectiveProfile() narrows that to a folder.
function getProfile(req) {
    if (isTunnelRequest(req)) {
        // Only folder profiles can be tunnel share targets.
        const shareParam = req.query && req.query.share;
        if (shareParam && isFolderProfile(profileByName(shareParam))) {
            if (req.session) req.session.shareProfile = shareParam;
            return profileByName(shareParam);
        }
        if (req.session && isFolderProfile(profileByName(req.session.shareProfile))) {
            return profileByName(req.session.shareProfile);
        }
        return null;
    }
    const ip = clientIp(req);
    for (const profile of config.profiles) {
        if ((profile.subnets || []).some(cidr => ipInCidr(ip, cidr))) {
            return profile;
        }
    }
    return null;
}

// The effective *folder* profile for a request. Logged-in admins may switch to
// ANY folder profile (all sites) regardless of subnet; switcher profiles use
// their `shares` allowlist; plain folder profiles are locked to themselves.
// The selected folder is chosen via ?share=<name> and remembered in the session.
function getEffectiveProfile(req) {
    const p = getProfile(req);

    // Determine which folders this request may switch between.
    let targets;
    if (isAdmin(req)) {
        targets = config.profiles.filter(isFolderProfile).map(x => x.name);
    } else if (p && !isFolderProfile(p)) {
        targets = switcherShares(p);
    } else {
        // Non-admin on a plain folder profile (or nothing) — locked.
        return p && isFolderProfile(p) ? p : null;
    }
    if (!targets || targets.length === 0) return null;

    const param = req.query && req.query.share;
    let active;
    if (param && targets.includes(param)) {
        active = param;
        if (req.session) req.session.activeShare = param;
    } else if (req.session && targets.includes(req.session.activeShare)) {
        active = req.session.activeShare;
    } else if (p && isFolderProfile(p) && targets.includes(p.name)) {
        active = p.name; // default to the subnet's own folder
    } else {
        active = targets[0];
    }
    return profileByName(active) || null;
}

function getBaseDir(req) {
    const profile = getEffectiveProfile(req);
    return profile ? getProfileDir(profile) : null;
}

// Deny access when no profile matches the client's subnet / tunnel share.
const deniedIpsLogged = new Set();
function requireProfile(req, res, next) {
    const access = getProfile(req);          // matched profile (maybe a switcher, maybe null for an admin)
    const profile = getEffectiveProfile(req); // narrowed to a folder profile
    if (!profile) {
        const ip = clientIp(req);
        if (!deniedIpsLogged.has(ip)) {
            deniedIpsLogged.add(ip);
            console.log(`Access denied: no share/profile for client ${ip} (host ${req.headers.host || '?'})`);
        }
        res.status(403).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send('<!doctype html><html><head><meta charset="utf-8"><title>No share</title>'
            + '<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;'
            + 'align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}'
            + 'div{max-width:32rem;padding:2rem}</style></head><body><div>'
            + '<h1>No share configured for your network</h1>'
            + '<p>This server has no folder assigned to your subnet. Contact the administrator.</p>'
            + '</div></body></html>');
    }
    req.accessProfile = access;  // for rendering the switcher picker
    req.profile = profile;       // the effective folder profile
    next();
}

// Clean up stale temp files (older than 1 hour)
function cleanTempUploads() {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        const maxAge = 60 * 60 * 1000; // 1 hour
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile() && (now - stat.mtimeMs) > maxAge) {
                    fs.unlinkSync(filePath);
                }
            } catch (e) { /* ignore individual file errors */ }
        }
    } catch (e) { /* ignore if temp dir is inaccessible */ }
}

// Clean on startup and every 30 minutes
cleanTempUploads();
setInterval(cleanTempUploads, 30 * 60 * 1000);

// Helper function to convert file size strings to bytes
function parseFileSize(sizeStr) {
    const units = {
        'B': 1,
        'KB': 1024,
        'MB': 1024 * 1024,
        'GB': 1024 * 1024 * 1024
    };
    
    const match = sizeStr.toString().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
    if (!match) {
        // Fallback: if it's just a number, assume bytes
        const num = parseInt(sizeStr);
        return isNaN(num) ? 500 * 1024 * 1024 : num; // Default to 500MB
    }
    
    const [, size, unit] = match;
    return parseFloat(size) * units[unit.toUpperCase()];
}

// Smart CORS middleware (after config loading)
app.use((req, res, next) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    
    if (config.cors_origins === "same-origin") {
        // Only allow same-origin requests (no CORS headers for same-origin)
        if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
            return res.status(403).json({ error: 'Cross-origin requests not allowed' });
        }
    } else if (config.cors_origins === "*") {
        // Allow all origins (development mode)
        res.header('Access-Control-Allow-Origin', '*');
    } else if (typeof config.cors_origins === 'string') {
        // Allow specific origin
        res.header('Access-Control-Allow-Origin', config.cors_origins);
    } else if (Array.isArray(config.cors_origins)) {
        // Allow multiple specific origins
        if (config.cors_origins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
        }
    }
    
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Config-dependent middleware setup (after config loading)
app.use(express.json({ limit: config.request_size_limit }));
app.use(express.urlencoded({ extended: true, limit: config.request_size_limit, charset: 'utf-8' }));

// Resolve the subnet/tunnel profile for every request; deny (403) if none.
// Static assets are served earlier by express.static and bypass this.
app.use(requireProfile);

// Set up multer for file uploads with UTF-8 filename support (after config loading)
const storage = multer.diskStorage({
    destination: config.temp_upload_directory + '/',
    filename: (req, file, cb) => {
        // Properly decode UTF-8 filename
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, Date.now() + '-' + originalName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: parseFileSize(config.max_file_size)
    }
});

// Utility functions
function getFileSize(filePath) {
    try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
            return stats.size;
        } else if (stats.isDirectory()) {
            let totalSize = 0;
            const files = fs.readdirSync(filePath);
            for (const file of files) {
                const subPath = path.join(filePath, file);
                try {
                    totalSize += getFileSize(subPath);
                } catch (e) {
                    // Skip files that can't be read
                }
            }
            return totalSize;
        }
    } catch (e) {
        return 0;
    }
    return 0;
}

function formatFileSize(bytes) {
    if (bytes === 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (bytes >= 1024 && i < sizes.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(1)} ${sizes[i]}`;
}

function getFileIcon(filename) {
    const ext = path.extname(filename).toLowerCase();
    const iconMap = {
        // Images
        '.jpg': 'fas fa-image', '.jpeg': 'fas fa-image', '.png': 'fas fa-image',
        '.gif': 'fas fa-image', '.bmp': 'fas fa-image', '.svg': 'fas fa-image',
        // Videos
        '.mp4': 'fas fa-video', '.avi': 'fas fa-video', '.mkv': 'fas fa-video',
        '.mov': 'fas fa-video', '.wmv': 'fas fa-video', '.flv': 'fas fa-video',
        // Audio
        '.mp3': 'fas fa-music', '.wav': 'fas fa-music', '.flac': 'fas fa-music',
        '.aac': 'fas fa-music', '.ogg': 'fas fa-music',
        // Documents
        '.pdf': 'fas fa-file-pdf', '.doc': 'fas fa-file-word', '.docx': 'fas fa-file-word',
        '.xls': 'fas fa-file-excel', '.xlsx': 'fas fa-file-excel',
        '.ppt': 'fas fa-file-powerpoint', '.pptx': 'fas fa-file-powerpoint',
        '.txt': 'fas fa-file-alt', '.md': 'fas fa-file-alt', '.rtf': 'fas fa-file-alt',
        // Code
        '.py': 'fas fa-file-code', '.js': 'fas fa-file-code', '.html': 'fas fa-file-code',
        '.css': 'fas fa-file-code', '.php': 'fas fa-file-code', '.cpp': 'fas fa-file-code',
        '.java': 'fas fa-file-code', '.c': 'fas fa-file-code',
        // Archives
        '.zip': 'fas fa-file-archive', '.rar': 'fas fa-file-archive', '.7z': 'fas fa-file-archive',
        '.tar': 'fas fa-file-archive', '.gz': 'fas fa-file-archive',
    };
    return iconMap[ext] || 'fas fa-file';
}

function isHidden(filename, stats) {
    // Linux style: files starting with '.'
    if (filename.startsWith('.')) return true;
    // Windows style: check hidden attribute (0x2)
    if (process.platform === 'win32' && stats && stats.attributes && (stats.attributes & 0x2)) return true;
    // Windows thumbnail cache
    if (filename.toLowerCase() === 'thumbs.db') return true;
    return false;
}

function isAdmin(req) {
    return req.session && req.session.admin === true;
}

function adminRequired(req, res, next) {
    if (!isAdmin(req)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// API protection middleware - blocks external API calls when enabled
function apiProtection(req, res, next) {
    if (!config.enable_api_restrictions) {
        return next();
    }
    
    // Allow requests from the web interface (same origin or no origin for direct server access)
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const userAgent = req.headers['user-agent'];
    
    // Allow requests without origin (direct server access, same-origin requests)
    if (!origin) {
        return next();
    }
    
    // Allow if origin matches server host
    const host = req.headers.host;
    if (origin === `http://${host}` || origin === `https://${host}`) {
        return next();
    }
    
    // Block external API calls
    return res.status(403).json({ 
        error: 'External API access not allowed. Please use the web interface.' 
    });
}

function safeJoin(dir, filename) {
    return path.resolve(path.join(dir, filename));
}

function isSafePath(filePath, baseDir) {
    const resolvedPath = path.resolve(filePath);
    const resolvedBase = path.resolve(baseDir);
    return resolvedPath.startsWith(resolvedBase);
}

// Input validation functions
function isValidFileName(filename) {
    if (!filename || typeof filename !== 'string') return false;
    const invalidChars = /[<>:"|?*\x00-\x1f]/;
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    return !invalidChars.test(filename) && !reserved.test(filename) && filename.length <= 255;
}

function isValidPath(pathStr) {
    if (typeof pathStr !== 'string') return false;
    // Allow empty string (represents root directory)
    if (pathStr === '') return true;
    return pathStr.length <= 1000 && !pathStr.includes('\x00');
}

function sanitizeError(error) {
    if (typeof error === 'string') {
        // Remove absolute paths and replace with generic messages
        return error.replace(/[A-Za-z]:[\\\/][^:]+/g, '[file path]')
                   .replace(/\/[^:]+/g, '[file path]')
                   .replace(/ENOENT.*/, 'File or directory not found')
                   .replace(/EACCES.*/, 'Permission denied')
                   .replace(/EPERM.*/, 'Operation not permitted');
    }
    return 'An error occurred';
}

// Routes
app.get('/', async (req, res) => {
    const currentPath = req.query.path || '';
    const searchQuery = req.query.search || '';
    
    // Input validation
    if (!isValidPath(currentPath) || !isValidPath(searchQuery)) {
        return res.redirect('/');
    }
    
    // Security check
    const fullPath = safeJoin(getProfileDir(req.profile), currentPath);
    if (!isSafePath(fullPath, getProfileDir(req.profile))) {
        return res.redirect('/');
    }
    
    try {
        await fs.promises.access(fullPath, fs.constants.F_OK);
    } catch {
        return res.redirect('/');
    }
    
    // Get directory contents
    let items = [];
    const stats = await fs.promises.stat(fullPath);
    if (stats.isDirectory()) {
        try {
            const files = await fs.promises.readdir(fullPath);
            for (const item of files) {
                if (searchQuery && !item.toLowerCase().includes(searchQuery.toLowerCase())) {
                    continue;
                }

                const itemPath = path.join(fullPath, item);
                const stats = await fs.promises.stat(itemPath);
                if (isHidden(item, stats)) continue;
                const isDir = stats.isDirectory();
                const size = getFileSize(itemPath);
                const modified = stats.mtime;
                
                items.push({
                    name: item,
                    is_dir: isDir,
                    size: size,
                    size_formatted: formatFileSize(size),
                    modified: modified.toISOString().slice(0, 19).replace('T', ' '),
                    icon: isDir ? 'fas fa-folder' : getFileIcon(item),
                    path: path.join(currentPath, item).replace(/\\/g, '/')
                });
            }
        } catch (e) {
            console.error('Permission denied accessing directory:', e.message);
            return res.redirect('/');
        }
    }
    
    // Sort items
    const sortBy = req.query.sort || 'name';
    const reverse = req.query.order === 'desc';
    
    items.sort((a, b) => {
        // Directories first
        if (a.is_dir !== b.is_dir) {
            return a.is_dir ? -1 : 1;
        }
        
        let comparison = 0;
        if (sortBy === 'size') {
            comparison = a.size - b.size;
        } else if (sortBy === 'modified') {
            comparison = new Date(a.modified) - new Date(b.modified);
        } else { // name
            comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        }
        
        return reverse ? -comparison : comparison;
    });
    
    // Breadcrumb navigation
    const breadcrumbs = [];
    if (currentPath) {
        const parts = currentPath.split('/').filter(p => p);
        let pathSoFar = '';
        for (const part of parts) {
            pathSoFar = path.join(pathSoFar, part).replace(/\\/g, '/');
            breadcrumbs.push({ name: part, path: pathSoFar });
        }
    }
    
    // The SMB share (smb://<LAN ip>/...) only resolves on the LAN, so hide that
    // button for remote/tunnel visitors while keeping it for local network users.
    const profile = req.profile;
    const onTunnel = isTunnelRequest(req);

    // Which sites this viewer may switch between: admins get all folder profiles;
    // a switcher profile (e.g. management) gets its allowlist; others get none.
    const switchTargetNames = isAdmin(req)
        ? config.profiles.filter(isFolderProfile).map(p => p.name)
        : (req.accessProfile && !isFolderProfile(req.accessProfile) ? switcherShares(req.accessProfile) : []);
    // Carry each option's friendly label for the dropdown.
    const switchNames = switchTargetNames.map(n => {
        const fp = profileByName(n);
        return { name: n, label: (fp && fp.label) || n };
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.render('index', {
        items,
        current_path: currentPath,
        breadcrumbs,
        is_admin: isAdmin(req),
        search_query: searchQuery,
        sort_by: sortBy,
        order: req.query.order || 'asc',
        url_for: (route, params) => {
            if (route === 'index') {
                const query = params && params.path ? `?path=${encodeURIComponent(params.path)}` : '';
                return `/${query}`;
            }
            return `/${route}`;
        },
        get_flashed_messages: () => [],
        smb_url: onTunnel ? '' : (profile.smb_url || ''),
        smb_button_text: profile.smb_button_text || '',
        profile_name: profile.name,
        profile_label: profile.label || profile.name,
        home_label: profile.home_label || `Home of ${profile.label || profile.name}`,
        // Tunnel modal lists folder profiles only (switchers aren't tunnelable).
        profiles: config.profiles.filter(isFolderProfile).map(p => ({ name: p.name, label: p.label || p.name })),
        // Folder switcher: admins get all sites; switcher profiles get their allowlist.
        switch_shares: switchNames.length > 1 ? switchNames : [],
        active_share: profile.name,
        tunnel_hours: TUNNEL_HOURS
    });
});

app.get('/login', (req, res) => {
    res.render('login', {
        url_for: (route) => {
            if (route === 'index') {
                return '/';
            }
            return `/${route}`;
        },
        get_flashed_messages: () => []
    });
});

app.post('/login', (req, res) => {
    const password = req.body.password;
    if (password === config.admin_password) {
        req.session.admin = true;
        res.redirect(req.query.next || '/');
    } else {
        res.render('login', {
            url_for: (route) => {
                if (route === 'index') {
                    return '/';
                }
                return `/${route}`;
            },
            get_flashed_messages: () => [['error', 'Invalid password']]
        });
    }
});

app.get('/logout', (req, res) => {
    req.session.admin = false;
    res.redirect('/');
});

app.post('/upload', upload.array('files'), (req, res) => {
    const currentPath = req.body.path || '';
    const files = req.files || [];

    // Helper to clean up temp files from this request
    function cleanupTempFiles() {
        for (const f of files) {
            try { fs.unlinkSync(f.path); } catch (e) { /* already moved or deleted */ }
        }
    }

    // Security check
    const uploadDir = safeJoin(getProfileDir(req.profile), currentPath);
    if (!isSafePath(uploadDir, getProfileDir(req.profile))) {
        cleanupTempFiles();
        return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(uploadDir)) {
        cleanupTempFiles();
        return res.status(400).json({ error: 'Directory does not exist' });
    }
    
    const uploadedFiles = [];
    
    for (const file of files) {
        try {
            // Properly decode UTF-8 filename
            let filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
            let filePath = path.join(uploadDir, filename);
            
            // Handle duplicate filenames
            let counter = 1;
            const originalName = filename;
            while (fs.existsSync(filePath)) {
                const ext = path.extname(originalName);
                const name = path.basename(originalName, ext);
                filename = `${name}_${counter}${ext}`;
                filePath = path.join(uploadDir, filename);
                counter++;
            }
            
            // Move file from temp location
            try {
                fs.renameSync(file.path, filePath);
            } catch (e) {
                if (e.code === 'EXDEV' || e.code === 'EPERM') {
                    // copyFileSync uses copy_file_range which fails on some NFS mounts
                    const data = fs.readFileSync(file.path);
                    fs.writeFileSync(filePath, data);
                    fs.unlinkSync(file.path);
                } else {
                    throw e;
                }
            }
            uploadedFiles.push(filename);
        } catch (e) {
            cleanupTempFiles();
            return res.status(500).json({ error: `Failed to save ${file.originalname}: ${e.message}` });
        }
    }
    
    // Store operation for undo
    lastOperation = {
        type: 'upload',
        files: uploadedFiles.map(f => path.join(uploadDir, f)),
        timestamp: new Date()
    };
    
    // Emit update to all clients
    io.to('fb:' + req.profile.name).emit('file_updated', { path: currentPath });
    
    res.json({ success: true, uploaded: uploadedFiles });
});

// ---- Cloudflare tunnel routes (one public link per profile) ----
app.get('/tunnel/status', (req, res) => {
    res.json(tunnelStatusAll());
});

app.post('/tunnel/start', (req, res) => {
    const name = (req.body && req.body.profile) || req.query.profile;
    if (!isFolderProfile(profileByName(name))) {
        return res.status(400).json({ error: 'Unknown profile' });
    }
    startTunnel(name);
    // URL + QR arrive asynchronously via the 'tunnel_updated' socket event
    res.json({ profile: name, ...getTunnel(name).state });
});

app.post('/tunnel/stop', (req, res) => {
    const name = (req.body && req.body.profile) || req.query.profile;
    if (!isFolderProfile(profileByName(name))) {
        return res.status(400).json({ error: 'Unknown profile' });
    }
    stopTunnel(name);
    res.json({ profile: name, active: false });
});

app.get('/download', apiProtection, (req, res) => {
    const filePath = req.query.path || '';
    
    // Security check
    const fullPath = safeJoin(getProfileDir(req.profile), filePath);
    if (!isSafePath(fullPath, getProfileDir(req.profile))) {
        return res.status(400).json({ error: 'Invalid path' });
    }
    
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    if (fs.statSync(fullPath).isFile()) {
        res.download(fullPath);
    } else {
        res.status(400).json({ error: 'Path is not a file' });
    }
});

app.get('/download_folder', (req, res) => {
    const folderPath = req.query.path || '';
    
    // Security check
    const fullPath = safeJoin(getProfileDir(req.profile), folderPath);
    if (!isSafePath(fullPath, getProfileDir(req.profile))) {
        return res.status(400).json({ error: 'Invalid path' });
    }
    
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
        return res.status(404).json({ error: 'Folder not found' });
    }
    
    const folderName = path.basename(fullPath) || 'files';
    const zipFilename = `${folderName}.zip`;
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
    
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('error', (err) => {
        res.status(500).json({ error: `Failed to create ZIP: ${err.message}` });
    });
    
    archive.pipe(res);
    archive.directory(fullPath, false);
    archive.finalize();
});

app.post('/create_folder', adminRequired, async (req, res) => {
    const currentPath = req.body.path || '';
    const folderName = (req.body.name || '').trim();
    
    // Input validation
    if (!folderName) {
        return res.status(400).json({ error: 'Folder name required' });
    }
    
    if (!isValidFileName(folderName) || !isValidPath(currentPath)) {
        return res.status(400).json({ error: 'Invalid folder name or path' });
    }
    
    // Security check
    const parentDir = safeJoin(getProfileDir(req.profile), currentPath);
    if (!isSafePath(parentDir, getProfileDir(req.profile))) {
        return res.status(400).json({ error: 'Invalid path' });
    }
    
    const newFolderPath = path.join(parentDir, folderName);
    
    try {
        await fs.promises.access(newFolderPath, fs.constants.F_OK);
        return res.status(400).json({ error: 'Folder already exists' });
    } catch {
        // Folder doesn't exist, which is what we want
    }
    
    try {
        await fs.promises.mkdir(newFolderPath, { recursive: true });
        
        // Store operation for undo
        lastOperation = {
            type: 'create_folder',
            path: newFolderPath,
            timestamp: new Date()
        };
        
        // Emit update to all clients
        io.to('fb:' + req.profile.name).emit('file_updated', { path: currentPath });
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: sanitizeError(`Failed to create folder: ${e.message}`) });
    }
});

app.post('/delete', adminRequired, async (req, res) => {
    const itemPath = req.body.path || '';
    
    // Input validation
    if (!isValidPath(itemPath)) {
        return res.status(400).json({ error: 'Invalid path' });
    }
    
    // Security check
    const fullPath = safeJoin(getProfileDir(req.profile), itemPath);
    if (!isSafePath(fullPath, getProfileDir(req.profile))) {
        return res.status(400).json({ error: 'Invalid path' });
    }
    
    try {
        const stats = await fs.promises.stat(fullPath);
        
        // Create backup for undo (simplified - just store the path)
        lastOperation = {
            type: 'delete',
            original_path: fullPath,
            timestamp: new Date()
        };
        
        if (stats.isFile()) {
            await fs.promises.unlink(fullPath);
        } else {
            await fs.promises.rm(fullPath, { recursive: true, force: true });
        }
        
        // Emit update to all clients
        const currentDir = path.dirname(itemPath);
        io.to('fb:' + req.profile.name).emit('file_updated', { path: currentDir });
        
        res.json({ success: true });
    } catch (e) {
        if (e.code === 'ENOENT') {
            res.status(404).json({ error: 'Item not found' });
        } else {
            res.status(500).json({ error: sanitizeError(`Failed to delete: ${e.message}`) });
        }
    }
});

app.post('/rename', adminRequired, async (req, res) => {
    const oldPath = req.body.path || '';
    const newName = (req.body.name || '').trim();
    
    // Input validation
    if (!newName) {
        return res.status(400).json({ error: 'New name required' });
    }
    
    if (!isValidFileName(newName) || !isValidPath(oldPath)) {
        return res.status(400).json({ error: 'Invalid file name or path' });
    }
    
    // Security check
    const fullOldPath = safeJoin(getProfileDir(req.profile), oldPath);
    if (!isSafePath(fullOldPath, getProfileDir(req.profile))) {
        return res.status(400).json({ error: 'Invalid path' });
    }
    
    try {
        await fs.promises.access(fullOldPath, fs.constants.F_OK);
    } catch {
        return res.status(404).json({ error: 'Item not found' });
    }
    
    const parentDir = path.dirname(fullOldPath);
    const newFullPath = path.join(parentDir, newName);
    
    try {
        await fs.promises.access(newFullPath, fs.constants.F_OK);
        return res.status(400).json({ error: 'Name already exists' });
    } catch {
        // Name doesn't exist, which is what we want
    }
    
    try {
        await fs.promises.rename(fullOldPath, newFullPath);
        
        // Store operation for undo
        lastOperation = {
            type: 'rename',
            old_path: fullOldPath,
            new_path: newFullPath,
            timestamp: new Date()
        };
        
        // Emit update to all clients
        const currentDir = path.dirname(oldPath);
        io.to('fb:' + req.profile.name).emit('file_updated', { path: currentDir });
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: sanitizeError(`Failed to rename: ${e.message}`) });
    }
});

app.post('/undo', adminRequired, (req, res) => {
    if (!lastOperation) {
        return res.status(400).json({ error: 'No operation to undo' });
    }
    
    try {
        const opType = lastOperation.type;
        
        if (opType === 'upload') {
            // Delete uploaded files
            for (const filePath of lastOperation.files) {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }
        } else if (opType === 'create_folder') {
            // Remove created folder
            if (fs.existsSync(lastOperation.path)) {
                fs.rmSync(lastOperation.path, { recursive: true, force: true });
            }
        } else if (opType === 'rename') {
            // Restore original name
            if (fs.existsSync(lastOperation.new_path)) {
                fs.renameSync(lastOperation.new_path, lastOperation.old_path);
            }
        }
        // Note: Delete undo is more complex and would require backup restoration
        
        // Clear last operation
        lastOperation = null;
        
        // Emit update to all clients
        io.to('fb:' + req.profile.name).emit('file_updated', { path: '' });
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: `Failed to undo: ${e.message}` });
    }
});

app.get('/preview', apiProtection, (req, res) => {
    const filePath = req.query.path || '';
    
    // Security check
    const fullPath = safeJoin(getProfileDir(req.profile), filePath);
    if (!isSafePath(fullPath, getProfileDir(req.profile))) {
        return res.status(400).json({ error: 'Invalid path' });
    }
    
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    try {
        // Check if file is text
        const mimeType = mime.lookup(fullPath);
        if (mimeType && !mimeType.startsWith('text/')) {
            return res.status(400).json({ error: 'File is not a text file' });
        }
        
        const content = fs.readFileSync(fullPath, 'utf-8').substring(0, 10000); // Limit to first 10KB
        res.json({ success: true, content });
    } catch (e) {
        res.status(500).json({ error: `Failed to read file: ${e.message}` });
    }
});

app.get('/shared_text', apiProtection, (req, res) => {
    res.json(sharedTextContent);
});

app.get('/api/files', async (req, res) => {
    const currentPath = req.query.path || '';
    const limit = req.query.limit ? parseInt(req.query.limit) : 0;

    // Input validation
    if (!isValidPath(currentPath)) {
        return res.status(400).json({ error: 'Invalid path' });
    }

    // Security check
    const fullPath = safeJoin(getProfileDir(req.profile), currentPath);
    if (!isSafePath(fullPath, getProfileDir(req.profile))) {
        return res.status(400).json({ error: 'Invalid path' });
    }

    try {
        await fs.promises.access(fullPath, fs.constants.F_OK);
    } catch {
        return res.status(404).json({ error: 'Path not found' });
    }

    // Get directory contents
    let items = [];
    const stats = await fs.promises.stat(fullPath);
    if (stats.isDirectory()) {
        try {
            const files = await fs.promises.readdir(fullPath);
            for (const item of files) {
                const itemPath = path.join(fullPath, item);
                const stats = await fs.promises.stat(itemPath);
                if (isHidden(item, stats)) continue;
                const isDir = stats.isDirectory();
                const size = getFileSize(itemPath);
                const modified = stats.mtime;

                items.push({
                    name: item,
                    is_dir: isDir,
                    size: size,
                    size_formatted: formatFileSize(size),
                    modified: modified.toISOString().slice(0, 19).replace('T', ' '),
                    icon: isDir ? 'fas fa-folder' : getFileIcon(item),
                    path: path.join(currentPath, item).replace(/\\/g, '/')
                });
            }
        } catch (e) {
            return res.status(403).json({ error: 'Permission denied' });
        }
    }

    // Sort by modified date (newest first)
    items.sort((a, b) => {
        if (a.is_dir !== b.is_dir) {
            return a.is_dir ? -1 : 1;
        }
        return new Date(b.modified) - new Date(a.modified);
    });

    // Limit results
    if (limit > 0) {
        items = items.slice(0, limit);
    }

    res.json({ success: true, files: items, base_url: `http://${req.headers.host}` });
});

app.post('/shared_text', (req, res) => {
    const content = req.body.content || '';

    // Update the Yjs doc by replacing all Y.Text content
    ydoc.transact(() => {
        ytext.delete(0, ytext.length);
        if (content) {
            ytext.insert(0, content);
        }
    });

    // Persist immediately for REST API calls
    sharedTextContent.content = content;
    config.shared_text = content;
    const success = saveConfig(config);

    if (!success) {
        console.log("Failed to save shared text to config file");
    }

    // Broadcast Yjs update (full state) for Yjs-aware clients
    const stateUpdate = Y.encodeStateAsUpdate(ydoc);
    io.to('shared_text').emit('yjs-update', stateUpdate);

    // Also broadcast legacy event for non-Yjs clients
    io.to('shared_text').emit('shared_text_updated', sharedTextContent);

    res.json({ success: true });
});

// Socket.IO events
io.on('connection', (socket) => {
    socket.join('shared_text');

    // The page tells us which profile it belongs to so it only receives
    // file_updated events for its own folder (per-subnet isolation).
    socket.on('join_profile', (name) => {
        if (profileByName(name)) {
            socket.join('fb:' + name);
        }
    });

    // Yjs sync: client requests full document state
    socket.on('yjs-sync-request', () => {
        const stateUpdate = Y.encodeStateAsUpdate(ydoc);
        socket.emit('yjs-sync-response', stateUpdate);
    });

    // Yjs sync: client sends incremental update
    socket.on('yjs-update', (update) => {
        try {
            const uint8Update = new Uint8Array(update);
            Y.applyUpdate(ydoc, uint8Update);

            // Broadcast to all OTHER clients
            socket.to('shared_text').emit('yjs-update', update);

            // Persist text to config
            persistYText();

            // Also emit legacy event for non-Yjs clients
            io.to('shared_text').emit('shared_text_updated', {
                content: ytext.toString()
            });
        } catch (e) {
            console.error('Failed to apply Yjs update:', e.message);
        }
    });

    socket.on('disconnect', () => {
        socket.leave('shared_text');
    });
});

// Watch each profile's folder for external changes (SCP, rsync, cp, etc.) and
// emit file_updated only to that profile's room.
const fsWatchDebounce = new Map();
for (const profile of config.profiles) {
    if (!isFolderProfile(profile)) continue;
    const dir = getProfileDir(profile);
    const room = 'fb:' + profile.name;
    try {
        fs.watch(dir, { recursive: true }, (eventType, filename) => {
            clearTimeout(fsWatchDebounce.get(profile.name));
            fsWatchDebounce.set(profile.name, setTimeout(() => {
                const sub = filename ? path.dirname(filename).replace(/\\/g, '/') : '';
                const relativePath = sub === '.' ? '' : sub;
                io.to(room).emit('file_updated', { path: relativePath });
            }, 500));
        });
    } catch (e) {
        console.log(`Warning: cannot watch ${dir} for profile "${profile.name}": ${e.message}`);
    }
}

// Poll for NFS changes not detected by inotify, per profile folder.
// Keys are "<profile>|<absolute dir>" so profiles never collide.
let lastMtimes = new Map();
function pollForChanges() {
    const newMtimes = new Map();
    for (const profile of config.profiles) {
        if (!isFolderProfile(profile)) continue;
        const baseDir = getProfileDir(profile);
        const room = 'fb:' + profile.name;
        try {
            const dirs = [baseDir];
            while (dirs.length) {
                const dir = dirs.pop();
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                const stat = fs.statSync(dir);
                const rel = path.relative(baseDir, dir).replace(/\\/g, '/');
                const key = profile.name + '|' + dir;
                newMtimes.set(key, stat.mtimeMs);
                if (lastMtimes.has(key) && lastMtimes.get(key) !== stat.mtimeMs) {
                    io.to(room).emit('file_updated', { path: rel === '.' ? '' : rel });
                }
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        dirs.push(path.join(dir, entry.name));
                    }
                }
            }
        } catch (e) { /* ignore polling errors */ }
    }
    lastMtimes = newMtimes;
}
pollForChanges(); // initial snapshot
setInterval(pollForChanges, 5000);

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});