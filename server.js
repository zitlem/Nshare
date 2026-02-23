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
            return loadedConfig;
        } catch (e) {
            console.log(`Error loading config: ${e.message}`);
        }
    } else {
        // console.log(`Config file ${CONFIG_FILE} not found, using defaults`);
    }
    
    return defaultConfig;
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
const PORT = process.env.PORT || config.port || 80;
const BASE_DIR = path.resolve(config.upload_directory || "./uploads");

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
    if (!config.upload_directory) {
        config.upload_directory = "./uploads";
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
    if (config.smb_url === undefined) {
        config.smb_url = "";
        needsUpdate = true;
    }
    if (config.smb_button_text === undefined) {
        config.smb_button_text = "";
        needsUpdate = true;
    }
    if (needsUpdate) {
        saveConfig(config);
    }
}

// Create base directory if it doesn't exist
if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
}

// Create temp upload directory if it doesn't exist
const TEMP_DIR = path.resolve(config.temp_upload_directory);
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
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
    const fullPath = safeJoin(BASE_DIR, currentPath);
    if (!isSafePath(fullPath, BASE_DIR)) {
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
        smb_url: config.smb_url || '',
        smb_button_text: config.smb_button_text || ''
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
    const uploadDir = safeJoin(BASE_DIR, currentPath);
    if (!isSafePath(uploadDir, BASE_DIR)) {
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
    io.to('file_browser').emit('file_updated', { path: currentPath });
    
    res.json({ success: true, uploaded: uploadedFiles });
});

app.get('/download', apiProtection, (req, res) => {
    const filePath = req.query.path || '';
    
    // Security check
    const fullPath = safeJoin(BASE_DIR, filePath);
    if (!isSafePath(fullPath, BASE_DIR)) {
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
    const fullPath = safeJoin(BASE_DIR, folderPath);
    if (!isSafePath(fullPath, BASE_DIR)) {
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
    const parentDir = safeJoin(BASE_DIR, currentPath);
    if (!isSafePath(parentDir, BASE_DIR)) {
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
        io.to('file_browser').emit('file_updated', { path: currentPath });
        
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
    const fullPath = safeJoin(BASE_DIR, itemPath);
    if (!isSafePath(fullPath, BASE_DIR)) {
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
        io.to('file_browser').emit('file_updated', { path: currentDir });
        
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
    const fullOldPath = safeJoin(BASE_DIR, oldPath);
    if (!isSafePath(fullOldPath, BASE_DIR)) {
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
        io.to('file_browser').emit('file_updated', { path: currentDir });
        
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
        io.to('file_browser').emit('file_updated', { path: '' });
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: `Failed to undo: ${e.message}` });
    }
});

app.get('/preview', apiProtection, (req, res) => {
    const filePath = req.query.path || '';
    
    // Security check
    const fullPath = safeJoin(BASE_DIR, filePath);
    if (!isSafePath(fullPath, BASE_DIR)) {
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
    const fullPath = safeJoin(BASE_DIR, currentPath);
    if (!isSafePath(fullPath, BASE_DIR)) {
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
    
    sharedTextContent.content = content;
    
    // Save to config file for persistence
    config.shared_text = content;
    const success = saveConfig(config);
    
    if (!success) {
        console.log("Failed to save shared text to config file");
    }
    
    // Emit update to all clients
    io.to('shared_text').emit('shared_text_updated', sharedTextContent);
    
    res.json({ success: true });
});

// Socket.IO events
io.on('connection', (socket) => {
    // console.log('Client connected');
    socket.join('file_browser');
    socket.join('shared_text');
    
    socket.on('disconnect', () => {
        // console.log('Client disconnected');
        socket.leave('file_browser');
        socket.leave('shared_text');
    });
});

// Watch filesystem for external changes (SCP, rsync, cp, etc.)
let fsWatchDebounce = null;
fs.watch(BASE_DIR, { recursive: true }, (eventType, filename) => {
    clearTimeout(fsWatchDebounce);
    fsWatchDebounce = setTimeout(() => {
        const dir = filename ? path.dirname(filename).replace(/\\/g, '/') : '';
        const relativePath = dir === '.' ? '' : dir;
        io.to('file_browser').emit('file_updated', { path: relativePath });
    }, 500);
});

// Poll for NFS changes not detected by inotify
let lastMtimes = new Map();
function pollForChanges() {
    try {
        const dirs = [BASE_DIR];
        const newMtimes = new Map();
        while (dirs.length) {
            const dir = dirs.pop();
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const stat = fs.statSync(dir);
            const rel = path.relative(BASE_DIR, dir).replace(/\\/g, '/');
            newMtimes.set(dir, stat.mtimeMs);
            if (lastMtimes.has(dir) && lastMtimes.get(dir) !== stat.mtimeMs) {
                io.to('file_browser').emit('file_updated', { path: rel === '.' ? '' : rel });
            }
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    dirs.push(path.join(dir, entry.name));
                }
            }
        }
        lastMtimes = newMtimes;
    } catch (e) { /* ignore polling errors */ }
}
pollForChanges(); // initial snapshot
setInterval(pollForChanges, 5000);

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});