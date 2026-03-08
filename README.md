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
4. **Open** `http://localhost` in your browser

## Features

✅ **Browse & manage files** through web interface
✅ **Upload files** by drag & drop or file picker
✅ **Download files** and folders (as ZIP)
✅ **Admin login** for file operations (default password: `admin123`)
✅ **File preview** for images, videos, text, and PDFs
✅ **Collaborative shared text** with real-time sync (Yjs)
✅ **Real-time file updates** via Socket.IO
✅ **Search & sort** files
✅ **Dark/light theme** toggle
✅ **Mobile friendly** responsive design
✅ **SMB link** support (optional)

## Configuration

All settings are in `config.json` (auto-created on first run):

```json
{
  "shared_text": "Welcome",
  "admin_password": "admin123",
  "port": 80,
  "upload_directory": "./uploads",
  "max_file_size": "500MB",
  "temp_upload_directory": "temp_uploads",
  "request_size_limit": "500mb",
  "cors_origins": "same-origin",
  "enable_api_restrictions": true,
  "smb_url": "",
  "smb_button_text": ""
}
```

### Quick Setup Examples

**Production (secure)** — use the defaults above, then change the admin password:
```json
{
  "admin_password": "your-strong-password",
  "cors_origins": "same-origin",
  "enable_api_restrictions": true
}
```

**Development (open access)**:
```json
{
  "cors_origins": "*",
  "enable_api_restrictions": false
}
```

See `CONFIG.md` for detailed configuration options.

## Security

🔒 **Change the admin password** from the default `admin123`
🔒 **CORS protection** — set `cors_origins` to `"same-origin"` (default) to block external websites
🔒 **API restrictions** — set `enable_api_restrictions` to `true` (default) to block external API calls

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