# Soggfy Download Flow Documentation

Bu dokuman Soggfy'nin sarki indirme surecini detayli olarak aciklar.

## Sistem Mimarisi

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SPOTIFY CLIENT (x86)                              │
│                                                                             │
│  ┌──────────────────────┐         ┌──────────────────────────────────────┐  │
│  │                      │         │                                      │  │
│  │   Audio Decoder      │ hook    │        CEF (Chromium Browser)        │  │
│  │   (OGG/Vorbis)       │◄────────│                                      │  │
│  │                      │         │   ┌──────────────────────────────┐   │  │
│  └──────────┬───────────┘         │   │      Sprinkles (JS)          │   │  │
│             │                     │   │   - Player State Tracker     │   │  │
│             │ intercept           │   │   - Metadata Provider        │   │  │
│             ▼                     │   │   - UI Components            │   │  │
│  ┌──────────────────────┐         │   └──────────────┬───────────────┘   │  │
│  │                      │         │                  │                   │  │
│  │   Core DLL           │◄────────┼──────────────────┘                   │  │
│  │   (dpapi.dll)        │ WS:28653│                                      │  │
│  │                      │         └──────────────────────────────────────┘  │
│  │   - StateManager     │                                                   │
│  │   - ControlServer    │                                                   │
│  │   - FFmpeg Handler   │                                                   │
│  └──────────┬───────────┘                                                   │
│             │                                                               │
└─────────────┼───────────────────────────────────────────────────────────────┘
              │
              ▼
        ┌───────────┐
        │  File     │
        │  System   │
        │  (.mp3,   │
        │   .ogg,   │
        │   .flac)  │
        └───────────┘
```

## Bilesenler

### 1. Core DLL (SpotifyOggDumper)

**Konum:** `SpotifyOggDumper/`  
**Inject Edilme:** `dpapi.dll` olarak `%appdata%\Spotify\` klasorune kopyalanir

#### Ana Dosyalar

| Dosya | Gorev |
|-------|-------|
| `Main.cpp` | DLL giris noktasi, hook kurulumu |
| `StateManager.cpp` | Track yonetimi, dosya yazma, FFmpeg |
| `ControlServer.cpp` | WebSocket sunucusu (port 28653) |
| `CefUtils.cpp` | JS injection, URL bloklama |

### 2. Sprinkles (UI Layer)

**Konum:** `Sprinkles/`  
**Inject Edilme:** CEF browser'a JS olarak inject edilir

#### Ana Dosyalar

| Dosya | Gorev |
|-------|-------|
| `main.ts` | Giris noktasi, mesaj yonlendirme |
| `player-state-tracker.ts` | Playback izleme, metadata toplama |
| `connection.ts` | WebSocket client |
| `resources.ts` | Spotify API cagrilari |
| `config.ts` | Kullanici ayarlari |

---

## Indirme Sureci (Step by Step)

### Faz 1: Baslangic ve Hook Kurulumu

```
1. Spotify.exe baslatilir
2. dpapi.dll (Core DLL) otomatik yuklenir
3. DllMain() -> Init() thread baslatilir
4. InstallHooks() calisir:
   - DecodeAudioData fonksiyonu hook'lanir
   - CEF URL blocker kurulur
5. ControlServer baslatilir (port 28653)
6. IDLE timer baslar -> Sprinkles JS inject edilir
```

### Faz 2: Playback Basladiginda

```
┌──────────────────────────────────────────────────────────────────────────┐
│ KULLANICI PLAY BUTONUNA BASAR                                            │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ SPRINKLES: Player Event Listener                                         │
│                                                                          │
│   Player.getEvents().addListener("update", ({ data }) => {               │
│       // Yeni playbackId algilandi                                       │
│       conn.send(PLAYER_STATE, { event: "trackstart", playbackId });      │
│       conn.send(DOWNLOAD_STATUS, { playbackId, ignore: isIgnored });     │
│   });                                                                    │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ CORE DLL: DecodeAudioData Hook                                           │
│                                                                          │
│   Her audio paketi geldiginde:                                           │
│                                                                          │
│   1. playbackId = playerState->getPlaybackId()                           │
│      (Memory pointer traversal: [[[[[[ebp]-40]+40]+128]+1E8]+150])       │
│                                                                          │
│   2. _stateMgr->ReceiveAudioData(playbackId, data, length)               │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ STATE MANAGER: ReceiveAudioData()                                        │
│                                                                          │
│   1. PlaybackInfo olustur (ilk cagrida)                                  │
│      - Temp dosya ac: playback_{id}.dat                                  │
│      - Status: IN_PROGRESS                                               │
│                                                                          │
│   2. OGG format kontrolu ("OggS" magic bytes)                            │
│      - Spotify'in custom OGG page'ini atla                               │
│                                                                          │
│   3. OGG page parsing (libogg kullanarak)                                │
│      - BOS (Beginning of Stream) kontrolu                                │
│      - Page siralama kontrolu (seek algılama)                            │
│      - Dosyaya yaz                                                       │
│                                                                          │
│   4. EOS (End of Stream) algilandi?                                      │
│      - Evet: ReadyToSave = true                                          │
│      - TRACK_META istegi gonder                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Faz 3: Metadata Toplama

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CORE DLL -> SPRINKLES: TRACK_META Request                                │
│                                                                          │
│   { playbackId: "abc123..." }                                            │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ SPRINKLES: getMetadata(playbackId)                                       │
│                                                                          │
│   1. Track Info Al                                                       │
│      - playback = playbacks.get(playbackId)                              │
│      - track = playback.item                                             │
│                                                                          │
│   2. Ekstra Metadata Topla (Spotify Web API)                             │
│      - getTrackMetadataWG() -> album, artist, date, label, ISRC          │
│      - getTrackAnalysisWG() -> audio analysis                            │
│      - getTrackFeaturesWG() -> BPM, tempo                                │
│                                                                          │
│   3. Lyrics Al (opsiyonel)                                               │
│      - getColorAndLyricsWG() -> synced/unsynced lyrics                   │
│                                                                          │
│   4. Cover Art Al                                                        │
│      - getImageData(image_xlarge_url)                                    │
│                                                                          │
│   5. Dosya Yollarini Hesapla                                             │
│      - PathTemplate.render(template, vars)                               │
│      - Ornek: "{artist_name}/{album_name}/{track_num}. {track_name}"     │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ SPRINKLES -> CORE DLL: TRACK_META Response                               │
│                                                                          │
│   {                                                                      │
│     type: "track",                                                       │
│     playbackId: "abc123...",                                             │
│     trackUri: "spotify:track:XXXXX",                                     │
│     metadata: {                                                          │
│       title: "Song Name",                                                │
│       artist: "Artist Name",                                             │
│       album: "Album Name",                                               │
│       track: 1,                                                          │
│       date: "2024-01-15",                                                │
│       isrc: "USRC12345678",                                              │
│       BPM: 120,                                                          │
│       lyrics: "[00:15.50]First line...",                                 │
│       ...                                                                │
│     },                                                                   │
│     trackPath: "Artist/Album/01. Song.ogg",                              │
│     coverPath: "Artist/Album/cover.jpg",                                 │
│     coverTempPath: "image_xlarge_url_hash"                               │
│   }                                                                      │
│   + Binary: Cover Image Data (JPEG)                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

### Faz 4: Dosya Kaydetme ve Donusturme

```
┌──────────────────────────────────────────────────────────────────────────┐
│ STATE MANAGER: SaveTrack()                                               │
│                                                                          │
│   1. Status Guncelle: CONVERTING                                         │
│                                                                          │
│   2. Cover Art Kaydet                                                    │
│      - Temp klasorune yaz (cache)                                        │
│      - coverPath varsa kopyala                                           │
│                                                                          │
│   3. FFmpeg Calistir (varsa)                                             │
│      ffmpeg -y -loglevel warning                                         │
│        -i playback_xxx.dat          # Input: raw OGG                     │
│        -i cover.ffmd                # Cover art (OGG/OPUS icin)          │
│        -metadata title="Song"       # ID3 tags                           │
│        -metadata artist="Artist"                                         │
│        -metadata album="Album"                                           │
│        -metadata date="2024"                                             │
│        -metadata lyrics="..."                                            │
│        output.mp3                   # Output file                        │
│                                                                          │
│   4. FFmpeg yoksa                                                        │
│      - Raw OGG dosyasini tasi                                            │
│                                                                          │
│   5. Temp dosyayi sil                                                    │
│                                                                          │
│   6. Status Guncelle: DONE                                               │
│      - SendTrackStatus(trackUri, "DONE", path)                           │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ CORE DLL -> SPRINKLES: DOWNLOAD_STATUS                                   │
│                                                                          │
│   {                                                                      │
│     results: {                                                           │
│       "spotify:track:XXXXX": {                                           │
│         status: "DONE",                                                  │
│         message: "",                                                     │
│         path: "C:/Music/Artist/Album/01. Song.mp3"                       │
│       }                                                                  │
│     }                                                                    │
│   }                                                                      │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ SPRINKLES UI: Status Indicator Guncellenir                               │
│                                                                          │
│   - Track card'da tik isareti gosterilir                                 │
│   - Hover'da dosya yolu gosterilir                                       │
│   - Klasor acma butonu aktif olur                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## WebSocket Protokolu

### Mesaj Formati

```
┌─────────┬─────────────┬──────────────────┬────────────────┐
│ type    │ content_len │ json_content     │ binary_content │
│ (u8)    │ (i32 LE)    │ (UTF-8 string)   │ (bytes)        │
├─────────┼─────────────┼──────────────────┼────────────────┤
│ 1 byte  │ 4 bytes     │ variable         │ variable       │
└─────────┴─────────────┴──────────────────┴────────────────┘
```

### Mesaj Tipleri

| Type | Isim | Yon | Aciklama |
|------|------|-----|----------|
| 1 | SYNC_CONFIG | S<->C | Config senkronizasyonu |
| 2 | TRACK_META | S<->C | Metadata istegi/cevabi |
| 3 | DOWNLOAD_STATUS | S<->C | Indirme durumu |
| 4 | OPEN_FOLDER | C->S | Dosya gezgininde ac |
| 5 | OPEN_FILE_PICKER | C<->S | Dosya secici dialog |
| 6 | WRITE_FILE | C->S | Dosya yaz (lyrics, canvas) |
| 7 | PLAYER_STATE | C->S | Playback event (start/end) |

**S = Server (C++ DLL), C = Client (JS Sprinkles)**

---

## Status Degerleri

| Status | Aciklama |
|--------|----------|
| `IN_PROGRESS` | Audio verisi aliniyor |
| `CONVERTING` | FFmpeg ile donusturuluyor |
| `DONE` | Basariyla tamamlandi |
| `ERROR` | Hata olustu |

---

## Kritik Noktalar

### 1. PlaybackId Eslestirme

Audio verisi ile track metadata'si `playbackId` uzerinden eslestirilir:

```cpp
// Main.cpp - Memory pointer traversal
auto playerState = (PlayerState*)Utils::TraversePointers<0, -0x40, 0x40, 0x128, 0x1E8, 0x150>(_ebp);
std::string playbackId = playerState->getPlaybackId();
```

Bu pointer path Spotify versiyonuna bagli olarak degisebilir.

### 2. OGG Stream Validation

Soggfy sadece baslangicindan sonuna kadar oynatilan sarkilari kaydeder:

```cpp
// StateManager.cpp - Dogrulama kontrolleri
if ((fs.tellp() == 0) && !ogg_page_bos(&page)) {
    DiscardTrack(*playback, "Track didn't play from start");
    return;
}
if (pageNo != playback->LastPageNo + 1) {
    DiscardTrack(*playback, "Track was seeked");
    return;
}
```

### 3. Spotify Custom OGG Page

Spotify, OGG dosyalarina custom bir page ekler. Bu atlanmalidir:

```cpp
if (memcmp(data, "OggS", 4) == 0) {
    auto nextPage = Utils::FindSubstr(data + 4, length - 4, "OggS", 4);
    if (nextPage) {
        length -= nextPage - data;
        data = nextPage;
    }
}
```

---

## Dosya Yapisi

### Temp Dosyalar

```
%localappdata%/Soggfy/
├── config.json           # Kullanici ayarlari
├── log.txt               # Debug log
├── ffmpeg/
│   └── ffmpeg.exe        # FFmpeg binary
└── temp/
    ├── playback_xxx.dat  # Raw OGG stream (gecici)
    └── image_xxx.ffmd    # Cover art metadata (OGG icin)
```

### Cikti Dosyalari (Ornek)

```
C:/Users/xxx/Music/Soggfy/
├── Artist Name/
│   ├── Album Name/
│   │   ├── cover.jpg
│   │   ├── 01. Track One.mp3
│   │   ├── 01. Track One.lrc     # Synced lyrics
│   │   ├── 02. Track Two.mp3
│   │   └── Canvas/
│   │       └── 01. Track One.mp4 # Canvas video
│   └── Another Album/
│       └── ...
└── Podcasts/
    └── Show Name/
        └── Episode Name.mp3
```

---

## Konfigrasyon

### config.json Ornek

```json
{
  "playbackSpeed": 1.0,
  "downloaderEnabled": true,
  "skipDownloadedTracks": false,
  "embedLyrics": true,
  "saveLyrics": true,
  "embedCoverArt": true,
  "saveCoverArt": true,
  "saveCanvas": false,
  "outputFormat": {
    "args": "-c copy",
    "ext": ""
  },
  "savePaths": {
    "basePath": "C:/Users/xxx/Music/Soggfy",
    "track": "{artist_name}/{album_name}/{track_num}. {track_name}.ogg",
    "episode": "Podcasts/{artist_name}/{album_name}/{release_date} - {track_name}.ogg"
  },
  "blockAds": true
}
```

### Path Template Degiskenleri

| Degisken | Aciklama |
|----------|----------|
| `{track_name}` | Sarki adi |
| `{artist_name}` | Sanatci adi |
| `{album_name}` | Album adi |
| `{track_num}` | Track numarasi (01, 02, ...) |
| `{disc_num}` | Disk numarasi |
| `{release_date}` | Yayin tarihi |
| `{playlist_name}` | Playlist adi |
| `{multi_disc_path}` | "/CD 1" (coklu disk ise) |

---

## Hata Durumlari

| Hata | Sebep | Cozum |
|------|-------|-------|
| "Track didn't play from start" | Sarki ortasindan baslatildi | Basa sar ve tekrar oynat |
| "Track was seeked" | Sarki icinde seek yapildi | Seek yapmadan dinle |
| "Track was skipped" | Sarki atlanildi | Sarki bitene kadar bekle |
| "Unrecognized audio codec" | OGG degilse (AAC/MP3) | Streaming quality'yi degistir |
| "FFmpeg exited with code X" | Donusturme hatasi | Log dosyasina bak |

---

## Ozet Akis Diagrami

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  PLAY   │────▶│  HOOK   │────▶│  SAVE   │────▶│  META   │────▶│ CONVERT │
│ Button  │     │  Audio  │     │   OGG   │     │  Fetch  │     │ FFmpeg  │
└─────────┘     └─────────┘     └─────────┘     └─────────┘     └─────────┘
                    │               │               │               │
                    │               │               │               │
                    ▼               ▼               ▼               ▼
              playbackId       temp file      Spotify API       .mp3/.ogg
              extraction       writing         calls            output
```
