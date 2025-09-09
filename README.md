# NShare - Simple File Server

A lightweight file server with web interface for easy file sharing and management.

## Quick Start

1. **Install Node.js** (version 14+)
2. **Download NShare** and install dependencies:
   ```bash
   npm install
   ```
3. **Start the server**:
   ```bash
   npm start
   ```
4. **Open** `http://localhost:80` in your browser

## Features

✅ **Browse & manage files** through web interface  
✅ **Upload files** by drag & drop or file picker  
✅ **Download files** and folders (as ZIP)  
✅ **Admin login** for file operations (default password: `admin123`)  
✅ **File preview** for images, videos, text, and PDFs  
✅ **Search & sort** files  
✅ **Dark/light theme** toggle  
✅ **Mobile friendly** responsive design  

## Configuration

All settings are in `config.json` (auto-created on first run):

```json
{
  "admin_password": "admin123",
  "port": 80,
  "upload_directory": "./uploads", 
  "max_file_size": "500MB"
}
```

### Quick Setup Examples

**Production (secure)**:
```bash
cp config.production.json config.json
```

**Development (open access)**:
```bash
cp config.development.json config.json
```

See `CONFIG.md` for detailed configuration options.

## Security

🔒 **Default settings are secure** - only your web interface can access files  
🔒 **Change the admin password** from default `admin123`  
🔒 **CORS protection** blocks external websites from accessing your files  

## Requirements

- **Node.js 14+**
- **Modern web browser** (Chrome, Firefox, Safari, Edge)

## Files & Directories

- `server.js` - Main server
- `config.json` - Settings (auto-created)
- `uploads/` - Your files (auto-created)
- `CONFIG.md` - Detailed configuration guide

---

**That's it!** NShare is designed to be simple and just work out of the box.