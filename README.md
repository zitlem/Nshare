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
✅ **Public share links** via on-demand Cloudflare tunnel + QR code  
✅ **Subnet profiles** — serve different folders to different networks from one server  

## Configuration

All settings live in `config.json`. **This file is git-ignored** because it holds your admin
password, internal IPs, subnets, and SMB paths. A sanitized template is committed as
`config.sample.json` — copy it and edit for your environment:

```bash
cp config.sample.json config.json
# then edit config.json: set admin_password, subnets, upload_directory, smb_url ...
```

(If `config.json` is missing, the server auto-creates a minimal default on first run, but
starting from `config.sample.json` is recommended.)

See `CONFIG.md` for detailed configuration options, and the
[Subnet Profiles](#subnet-profiles-multiple-folders-per-network) section for the multi-folder
setup.

## Public Share Links (Cloudflare Tunnel)

Click the **QR-code button** in the toolbar to open a temporary public link so people
outside your LAN can browse and upload. Each link:

- runs an on-demand [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-tunnel/)
  (`trycloudflare.com`, no account needed) and shows a **URL + QR code**;
- **auto-closes after 4 hours** (configurable via `tunnel_duration_hours`), or immediately when
  you press **Stop**;
- requires the `cloudflared` binary on the server — install it with `install-cloudflared.sh`
  (Linux/macOS) or `install-cloudflared.ps1` (Windows), or set `"cloudflared_path"` in
  `config.json` to its absolute path if it isn't on `PATH`.

Admin actions (delete/rename/new folder) still require the admin login, so anonymous visitors
can only browse, download, and upload. When [subnet profiles](#subnet-profiles-multiple-folders-per-network)
are configured, each profile gets its **own** link, and its QR/URL carries a `?share=<profile>`
marker that pins visitors to that profile's folder.

## Subnet Profiles (multiple folders per network)

One NShare server can serve **different folders to different networks**, choosing a *profile*
by the client's IP subnet. Move the per-folder settings out of the top level into a `profiles`
array:

```json
{
  "port": 80,
  "admin_password": "CHANGE_ME",
  "max_file_size": "8GB",
  "temp_upload_directory": "temp_uploads",
  "request_size_limit": "5gb",
  "cors_origins": "*",
  "enable_api_restrictions": false,
  "tunnel_duration_hours": 4,
  "profiles": [
    {
      "name": "shared",
      "subnets": ["192.168.1.0/24"],
      "upload_directory": "./data/shared",
      "smb_url": "smb://server.example/share-a",
      "smb_button_text": ""
    },
    {
      "name": "school",
      "subnets": ["192.168.10.0/24"],
      "upload_directory": "./data/school",
      "smb_url": "smb://server.example/share-b",
      "smb_button_text": "SHARE B"
    }
  ]
}
```

> Values above are placeholders — set your own subnets, folders, and SMB paths.
> The same template ships as `config.sample.json`.

**Per-profile fields:** `name` (unique id), `subnets` (list of IPv4 CIDRs that map to this
profile), `upload_directory`, `smb_url`, `smb_button_text`.

**Behavior:**

- A LAN visitor is matched to the first profile whose `subnets` contains their IP.
- A visitor whose subnet matches **no** profile gets a **403 "No share configured for your
  network"** page.
- Tunnel/remote visitors have no LAN subnet — they're pinned to a profile by the
  `?share=<name>` marker in the per-profile tunnel link (stored in their session).
- Real-time updates are isolated per profile: a change in one folder only refreshes clients
  viewing that folder.
- The admin password is shared across all profiles.

#### Switcher profiles (access multiple folders)

Give a subnet access to **several** folders by defining a *switcher* profile — one with a
`shares` allowlist **instead of** its own `upload_directory`. Users on that subnet get a
folder-picker dropdown in the toolbar and can view/upload to any of the listed shares:

```json
{ "name": "management", "subnets": ["10.0.0.0/24"], "shares": ["shared", "school"] }
```

- The selected folder is remembered in the session (default: the first entry in `shares`).
  Switching in the toolbar reloads with `/?share=<name>` and moves the file list, SMB button,
  and live updates to that folder together.
- Switcher users still need the **admin login** for destructive actions — being on the
  management subnet does not grant admin automatically.
- Switcher profiles are **not** tunnel targets (only folder profiles get public links).

**Backward compatible:** if `profiles` is omitted, the legacy top-level `upload_directory` /
`smb_url` / `smb_button_text` are used as a single implicit profile — existing single-folder
configs keep working unchanged.

### Deployment prerequisites

- **The server must see each client's real IP.** Subnet matching uses the direct socket
  address, so the box must be reachable from every subnet **without NAT** in between (L2-adjacent
  or routed transparently). If a router masquerades a subnet, all its clients appear as the
  router's IP and won't match. On startup the server logs `Access denied: no share/profile for
  client <ip>` (once per IP) — watch it to confirm real client IPs are arriving.
- **Every profile's `upload_directory` must exist / be mounted** on this one box. Folders that
  used to live on separate servers must be locally accessible (local disk, SMB, or NFS mount).
- **Not a hard security boundary for tunnels:** a tunnel visitor could edit the `?share=` value
  to view another profile's folder. This is fine for anonymous file-sharing; if you need strict
  isolation, run separate instances instead.

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
- `uploads/` - Your files (auto-created; or per-profile `upload_directory` folders)
- `install-cloudflared.sh` / `install-cloudflared.ps1` - Installers for the tunnel binary
- `CONFIG.md` - Detailed configuration guide

---

**That's it!** NShare is designed to be simple and just work out of the box.