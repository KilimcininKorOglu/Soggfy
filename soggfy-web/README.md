# Soggfy Web UI

Web-based interface for Soggfy with advanced features for managing downloads, playlists, schedules, and more.

## Features

### Search and Download
- Search Spotify tracks, albums, artists, and playlists
- Queue multiple items for download
- Real-time download progress via WebSocket
- Search history with quick re-search

### Playlist Management
- Save Spotify playlists to track new additions
- Auto-detect new tracks added to saved playlists
- Bulk download new tracks from playlists
- Track playlist sync status

### Download Scheduling
- Schedule automatic downloads with cron expressions
- Support for tracks, albums, playlists, and artist top tracks
- View schedule history and execution logs
- Enable/disable schedules without deleting

### Download Statistics
- View download history with detailed metadata
- Charts showing downloads over time
- Filter by date range, format, and status
- Export download history

### File Browser
- Browse downloaded files and folders
- Search files by name
- View file metadata (format, bitrate, duration)
- Play audio previews in browser
- Delete files and folders

### Metadata Editor
- Edit ID3 tags (title, artist, album, etc.)
- Change album artwork
- Batch edit multiple files (planned)

### Notifications
- Browser push notifications
- Discord webhook integration
- Telegram bot notifications
- Configurable notification events

### Device Selection
- List available Spotify devices
- Select which device to use for playback
- Auto-reconnect on device change

## Prerequisites

1. **Node.js 18+** installed
2. **Soggfy** installed and running with Spotify client
3. **Spotify Developer Account** for API credentials

## Setup

### 1. Create Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Create a new app
3. Add `http://127.0.0.1:3001/auth/callback` as Redirect URI
4. Copy Client ID and Client Secret

### 2. Backend Setup

```bash
cd backend
npm install

# Create .env file
cp .env.example .env
# Edit .env with your Spotify credentials

npm start
```

The backend runs on port **3001**.

### 3. Frontend Setup

```bash
cd frontend
npm install
npm start
```

The frontend runs on port **3000**.

### 4. Usage

1. Open http://localhost:3000
2. Make sure Spotify with Soggfy is running
3. Click "Connect Spotify Account" and authorize
4. Select the device where Soggfy is running
5. Use the sidebar to navigate between features

## Architecture

```
Frontend (React)     Backend (Node.js)      Soggfy (C++)
:3000                :3001                  :28653/sgf_ctrl
   |                    |                      |
   |-- WebSocket ------>|                      |
   |                    |-- WebSocket -------->|
   |                    |                      |
   |-- HTTP API ------->|                      |
   |                    |-- Spotify API ------>|
   |                    |                      |
   |                    |-- SQLite DB          |
```

## Project Structure

```
soggfy-web/
├── backend/
│   ├── server.js           # Main Express server
│   ├── spotifyAuth.js      # Spotify OAuth handling
│   ├── soggfyClient.js     # WebSocket client for Soggfy
│   ├── queueManager.js     # Download queue management
│   ├── playlistManager.js  # Playlist tracking
│   ├── scheduler.js        # Cron-based scheduling
│   ├── statsManager.js     # Download statistics
│   ├── fileManager.js      # File browser operations
│   ├── metadataEditor.js   # ID3 tag editing
│   ├── notificationManager.js # Push/Discord/Telegram
│   ├── searchHistory.js    # Search history storage
│   └── .env.example        # Environment template
├── frontend/
│   ├── src/
│   │   ├── App.jsx         # Main app with sidebar
│   │   ├── App.css         # Global styles
│   │   └── components/
│   │       ├── Search.jsx      # Search & download
│   │       ├── Playlists.jsx   # Playlist management
│   │       ├── Schedules.jsx   # Download scheduling
│   │       ├── Statistics.jsx  # Download stats
│   │       ├── History.jsx     # Download history
│   │       ├── FileBrowser.jsx # File management
│   │       ├── Notifications.jsx # Notification settings
│   │       └── Settings.jsx    # General settings
│   └── public/
└── README.md
```

## API Endpoints

### Authentication
| Method | Endpoint         | Description            |
|--------|------------------|------------------------|
| GET    | /api/auth/url    | Get Spotify OAuth URL  |
| GET    | /auth/callback   | OAuth callback handler |
| GET    | /api/auth/status | Check auth status      |

### Devices
| Method | Endpoint     | Description          |
|--------|--------------|----------------------|
| GET    | /api/devices | List Spotify devices |
| POST   | /api/device  | Set active device    |

### Download Queue
| Method | Endpoint         | Description        |
|--------|------------------|--------------------|
| POST   | /api/download    | Add URL to queue   |
| GET    | /api/queue       | Get queue status   |
| POST   | /api/queue/clear | Clear completed    |
| DELETE | /api/queue/:id   | Remove from queue  |
| POST   | /api/queue/skip  | Skip current track |

### Search
| Method | Endpoint            | Description          |
|--------|---------------------|----------------------|
| GET    | /api/search         | Search Spotify       |
| GET    | /api/search/history | Get search history   |
| DELETE | /api/search/history | Clear search history |

### Playlists
| Method | Endpoint                    | Description          |
|--------|-----------------------------|----------------------|
| GET    | /api/playlists              | List saved playlists |
| POST   | /api/playlists              | Save playlist        |
| DELETE | /api/playlists/:id          | Remove playlist      |
| POST   | /api/playlists/:id/sync     | Sync playlist tracks |
| POST   | /api/playlists/:id/download | Download new tracks  |

### Schedules
| Method | Endpoint                     | Description              |
|--------|------------------------------|--------------------------|
| GET    | /api/schedules               | List schedules           |
| POST   | /api/schedules               | Create schedule          |
| PUT    | /api/schedules/:id           | Update schedule          |
| DELETE | /api/schedules/:id           | Delete schedule          |
| POST   | /api/schedules/:id/run       | Run schedule now         |
| GET    | /api/schedules/history       | Get execution history    |
| POST   | /api/schedules/validate-cron | Validate cron expression |

### Statistics
| Method | Endpoint           | Description             |
|--------|--------------------|-------------------------|
| GET    | /api/stats         | Get download statistics |
| GET    | /api/stats/history | Get download history    |
| POST   | /api/stats/record  | Record download         |

### File Browser
| Method | Endpoint            | Description             |
|--------|---------------------|-------------------------|
| GET    | /api/files          | List files in directory |
| GET    | /api/files/search   | Search files            |
| DELETE | /api/files          | Delete file/folder      |
| GET    | /api/files/metadata | Get file metadata       |
| PUT    | /api/files/metadata | Update file metadata    |
| GET    | /api/files/stream   | Stream audio file       |

### Notifications
| Method | Endpoint                  | Description             |
|--------|---------------------------|-------------------------|
| GET    | /api/notifications/config | Get notification config |
| PUT    | /api/notifications/config | Update config           |
| POST   | /api/notifications/test   | Send test notification  |

## Environment Variables

```env
# Spotify API (required)
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/auth/callback

# Server
PORT=3001
FRONTEND_URL=http://localhost:3000

# Soggfy connection
SOGGFY_WS_URL=ws://127.0.0.1:28653/sgf_ctrl

# Optional: Discord webhook
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Optional: Telegram bot
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=123456789
```

## Troubleshooting

### "Cannot connect to Soggfy"
- Make sure Spotify with Soggfy mod is running
- Check if port 28653 is accessible
- Verify WebSocket connection in browser DevTools

### "No devices found"
- Open Spotify and play something briefly
- Click "Refresh Devices"
- Check Spotify Premium status

### Track doesn't download
- Tracks must play from start to finish
- Don't seek during playback
- Premium account required for 320kbps
- Check Soggfy settings in Spotify client

### Schedule not running
- Verify cron expression is valid
- Check schedule is enabled
- Review schedule history for errors
- Ensure Spotify is running at scheduled time

### Notifications not working
- Check notification permissions in browser
- Verify Discord webhook URL
- Test Telegram bot with /start command
