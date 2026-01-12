<div align="center">

# Soggfy - SpotifyOggDumper

A music downloader mod for the Windows Spotify client

<img align="right" src="https://user-images.githubusercontent.com/53208252/147526053-a62850c2-9ee9-471f-83c1-481f2f0dca32.png" width="250" />
</div>

## Features

### Core Features
- Download tracks directly from Spotify during playback
- Download and embed metadata, lyrics and canvas
- Generate M3U playlists for albums and playlists
- Automatic conversion to MP3, FLAC, M4A and many other formats
- Skip already downloaded tracks (Track ID based detection)
- Configurable podcast download support
- Ad and telemetry blocking

### Web UI (Optional)
Soggfy includes an optional Web UI for remote control and advanced features:

- **Search & Download** - Search Spotify and queue downloads without using the desktop client
- **Playlist Management** - Save playlists and track new additions
- **Download Scheduling** - Schedule automatic downloads with cron expressions
- **Download Statistics** - View download history, charts and analytics
- **File Browser** - Browse, search and manage downloaded files
- **Metadata Editor** - Edit ID3 tags and album artwork
- **Notifications** - Browser push, Discord webhook and Telegram bot notifications
- **Multi-device Support** - Select which Spotify device to use for playback

## Installation and Usage

### Quick Install
1. Download and extract the `.zip` package of the [latest release](https://github.com/Rafiuth/Soggfy/releases/latest).
2. Double click the `Install.cmd` file. It will run the Install.ps1 script with Execution Policy Bypass.
3. Open Spotify and play the songs you want to download.

Tracks are saved in the Music folder by default. The settings panel can be accessed by hovering next to the download button in the navigation bar.

### Web UI Setup (Optional)
```bash
cd soggfy-web/backend
npm install
cp .env.example .env  # Configure your Spotify API credentials
npm start
```

```bash
cd soggfy-web/frontend
npm install
npm start
```

Access the Web UI at `http://localhost:3000`

## Configuration

### File Naming
Downloaded files include Spotify Track ID for reliable skip detection:
```
Artist/Album/01. Song Name - 6h240MaWo49TJ8Q8Lq8WMC.mp3
```

### Path Template Variables
| Variable             | Description                   |
|----------------------|-------------------------------|
| `{track_name}`       | Track name                    |
| `{artist_name}`      | Artist name                   |
| `{all_artist_names}` | All artists (comma separated) |
| `{album_name}`       | Album name                    |
| `{track_num}`        | Track number                  |
| `{release_year}`     | Release year                  |
| `{release_date}`     | Release date (YYYY-MM-DD)     |
| `{multi_disc_path}`  | `/CD X` if multi-disc         |
| `{playlist_name}`    | Playlist name                 |

## Notes
- Songs are only downloaded if played from start to finish, without seeking (pausing is fine).
- Quality depends on the account: _160Kb/s_ (free) or _320Kb/s_ (premium). Set streaming quality to "Very high" in Spotify settings for best quality.
- Podcast support is limited to audio-only OGG podcasts. Can be disabled in settings.
- Maximum playback speed is 30x (player stops responding at higher speeds).
- You may need to whitelist Soggfy in your anti-virus.

**Warning:** This mod breaks [Spotify's Guidelines](https://www.spotify.com/us/legal/user-guidelines/) and using it could get your account banned. Consider using alt accounts or keeping backups (see [Exportify](https://github.com/watsonbox/exportify) and [SpotMyBackup](http://www.spotmybackup.com)).

## How it works
Soggfy works by intercepting Spotify's OGG parser and capturing the unencrypted data during playback. This process is similar to recording, but it results in an exact copy of the original files served by Spotify, without ever extracting keys or actually re-downloading them.

Conversion and metadata is then applied according to user settings.

## Architecture

```
Spotify Client
    |
    v (playback)
Core DLL (SpotifyOggDumper.dll)
    |-- Captures OGG packets
    |-- Links audio to track via PlaybackId
    v
Sprinkles (SoggfyUIC.js)
    |-- Extracts metadata from Spotify Web API
    |-- Provides settings UI
    v
File System
    |-- FFmpeg conversion
    |-- Metadata embedding
```

## Manual Installation
If you are having issues with the install script:

1. Download and install the correct Spotify client version (see Install.ps1 for URL).
2. Copy `SpotifyOggDumper.dll` to `%appdata%/Spotify/dpapi.dll`
3. Copy `SoggfyUIC.js` to `%appdata%/Spotify/SoggfyUIC.js`
4. Download [FFmpeg binaries](https://github.com/AnimMouse/ffmpeg-autobuild/releases) to `%localappdata%/Soggfy/ffmpeg/ffmpeg.exe`

Alternatively, `Injector.exe` can be used to launch or inject Soggfy into a running Spotify instance.

## Building from Source

### Requirements
- Visual Studio 2022 with C++ workload (x86)
- Node.js 18+
- 7-Zip (for fetching dependencies)

### Build Commands
```bash
# Fetch CEF headers
set PATH=C:\Program Files\7-Zip;%PATH%
fetch_external_deps.bat

# Build Core DLL
msbuild SpotifyOggDumper\SpotifyOggDumper.vcxproj /p:Configuration=Release

# Build Sprinkles UI
cd Sprinkles && npm install && npm run build
```

## Credits
- [XSpotify](https://web.archive.org/web/20200303145624/https://github.com/meik97/XSpotify) and spotifykeydumper - Inspiration for this project
- [Spicetify](https://github.com/khanhas/spicetify-cli), [Ghidra](https://ghidra-sre.org/) and [x64dbg](https://x64dbg.com/) - Tools for reversing and debugging
- [abba23's spotify-adblock](https://github.com/abba23/spotify-adblock) - Built-in telemetry/update blocker

## License
This project is for educational purposes only. Use at your own risk.
