# NShare Configuration Guide

## Configuration File

### Main Configuration: `config.json`
All settings are stored in `config.json`. Modify settings by editing this file and restarting the server.

### Quick Start
1. **Edit `config.json`** with your desired settings
2. **Restart the server** to apply changes

```bash
# Edit the config file
nano config.json  # or use any text editor

# Restart the server
npm start
```

## Available Settings

### Basic Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `shared_text` | `"Welcome"` | Default text in the shared text editor |
| `admin_password` | `"admin123"` | Password for admin access ⚠️ **CHANGE IN PRODUCTION** |
| `port` | `80` | Server port number |

### File Storage

| Setting | Default | Description |
|---------|---------|-------------|
| `upload_directory` | `"./uploads"` | Directory for uploaded files |
| `temp_upload_directory` | `"temp_uploads"` | Temporary upload processing directory |

### File Limits

| Setting | Default | Description | Examples |
|---------|---------|-------------|----------|
| `max_file_size` | `"500MB"` | Maximum file upload size | `"1GB"`, `"100MB"`, `"50KB"` |
| `request_size_limit` | `"500mb"` | Maximum request body size | `"1gb"`, `"100mb"` |

### Security Settings

| Setting | Default | Description | Options |
|---------|---------|-------------|---------|
| `cors_origins` | `"same-origin"` | Cross-origin request policy | See CORS Options below |
| `enable_api_restrictions` | `true` | Block external API access | `true` (secure) / `false` (open) |

## CORS Configuration Examples

### Basic Options
| Value | Description | Use Case |
|-------|-------------|----------|
| `"same-origin"` | Only allow same-origin requests | **Production (Recommended)** |
| `"*"` | Allow all origins | Development/Testing |
| `"https://yourdomain.com"` | Allow specific domain | External integration |

### Array of Domains (Multiple Origins)
```json
{
  "cors_origins": [
    "https://app1.com",
    "https://app2.com", 
    "https://admin.mysite.org"
  ]
}
```

### Development with Frontend Frameworks
```json
{
  "cors_origins": [
    "http://localhost:3000",    // React dev server
    "http://localhost:5173",    // Vite dev server  
    "http://localhost:4200",    // Angular dev server
    "http://localhost:8080",    // Vue dev server
    "http://127.0.0.1:3000"     // Alternative localhost
  ]
}
```

### Enterprise Multi-Domain Setup
```json
{
  "cors_origins": [
    "https://intranet.company.com",
    "https://portal.company.com",
    "https://admin.company.com",
    "https://mobile-app.company.com"
  ]
}
```

### Mixed Environment (Prod + Dev)
```json
{
  "cors_origins": [
    "https://production.com",
    "http://localhost:3000"
  ]
}
```

## Security Levels

### Maximum Security (Production)
```json
{
  "cors_origins": "same-origin",
  "enable_api_restrictions": true
}
```
- Only your web interface can access the API
- Blocks external websites from accessing files

### Development Mode
```json
{
  "cors_origins": "*",
  "enable_api_restrictions": false
}
```
- Open API access for development tools
- External applications can access the API

### Custom Domain Access
```json
{
  "cors_origins": "https://myapp.com",
  "enable_api_restrictions": true
}
```
- Allow specific external domain
- Block all other external access

## File Size Examples

```json
{
  "max_file_size": "1GB",     // 1 gigabyte
  "max_file_size": "500MB",   // 500 megabytes  
  "max_file_size": "50MB",    // 50 megabytes
  "max_file_size": "1024KB"   // 1024 kilobytes
}
```

## Directory Examples

```json
{
  "upload_directory": "./uploads",           // Relative path
  "upload_directory": "/var/nshare/files",   // Absolute path
  "upload_directory": "C:\\Files\\NShare"    // Windows absolute path
}
```

## Configuration Tips

1. **Always restart the server** after changing config.json
2. **Backup your config** before making changes
3. **Use absolute paths** for production deployments
4. **Change the admin password** from default
5. **Test CORS settings** with your intended usage
6. **Start with restrictive settings** and open as needed

## Troubleshooting

- **"Access denied" errors**: Check `cors_origins` and `enable_api_restrictions`
- **Upload failures**: Check `max_file_size` and directory permissions
- **Config not loading**: Verify JSON syntax with a validator
- **Port conflicts**: Change `port` to an available port number