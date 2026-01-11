# Soggfy Web UI

Web-based interface for Soggfy that allows downloading Spotify tracks via URL input.

## Features

- Paste Spotify track, album, or playlist URLs
- Queue management with real-time status updates
- WebSocket connection for live download progress
- OAuth integration with Spotify Web API

## Prerequisites

1. **Node.js 18+** installed
2. **Soggfy** installed and running with Spotify client
3. **Spotify Developer Account** for API credentials

## Setup

### 1. Create Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Create a new app
3. Add `http://localhost:3001/auth/callback` as Redirect URI
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

### 3. Frontend Setup

```bash
cd frontend
npm install
npm start
```

### 4. Usage

1. Open http://localhost:3000
2. Make sure Spotify with Soggfy is running
3. Click "Connect Spotify Account" and authorize
4. Select the device where Soggfy is running
5. Paste Spotify URLs to download!

## Architecture

```
Frontend (React)     Backend (Node.js)      Soggfy (C++)
:3000                :3001                  :28653
   |                    |                      |
   |-- WebSocket ------>|                      |
   |                    |-- WebSocket -------->|
   |                    |                      |
   |-- HTTP API ------->|                      |
   |                    |-- Spotify API ------>|
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |
| GET | /api/auth/url | Get Spotify OAuth URL |
| GET | /api/devices | List Spotify devices |
| POST | /api/device | Set active device |
| POST | /api/download | Add URL to queue |
| GET | /api/queue | Get queue status |
| POST | /api/queue/clear | Clear completed |
| DELETE | /api/queue/:id | Remove from queue |
| POST | /api/queue/skip | Skip current track |

## Troubleshooting

### "Cannot connect to Soggfy"
- Make sure Spotify with Soggfy mod is running
- Check if port 28653 is accessible

### "No devices found"
- Open Spotify and play something briefly
- Click "Refresh Devices"

### Track doesn't download
- Tracks must play from start to finish
- Don't seek during playback
- Premium account required for 320kbps
