# Dosya Adına Track ID Ekleme ile Skip Downloaded Tracks

## Problem

Mevcut `skipDownloadedTracks` sistemi karmaşık regex pattern'leri ile dosya sistemi tarıyor. Dosya adı veya klasör değişirse aynı şarkı tekrar indirilir.

## Çözüm

Dosya adına Spotify Track ID ekle, skip kontrolünde sadece ID'yi ara.

### Örnek

```
Mevcut:  11. Bohemian Rhapsody.mp3
Yeni:    11. Bohemian Rhapsody - 6h240MaWo49TJ8Q8Lq8WMC.mp3
```

## Skip Kontrolü

```cpp
bool IsAlreadyDownloaded(const fs::path& basePath, const std::string& trackId) {
    for (auto& entry : fs::recursive_directory_iterator(basePath)) {
        if (entry.is_regular_file()) {
            if (entry.path().filename().string().find(trackId) != std::string::npos) {
                return true;
            }
        }
    }
    return false;
}
```

**Akış:**
1. İndirme isteği geldi → Track ID al: `6h240MaWo49TJ8Q8Lq8WMC`
2. `basePath` klasöründe recursive ara
3. Herhangi bir dosya adında bu ID var mı?
4. Evet → Skip, Hayır → İndir

## Uygulama

### 1. Path Template Değişkeni Ekle

`Sprinkles/src/path-template.ts`:

```typescript
{
    name: "track_id",
    desc: "Spotify Track/Episode ID (22 karakter)",
    pattern: `[a-zA-Z0-9]{22}`,
    getValue: (m, s) => s.item?.uri?.split(':').pop() || ""
}
```

### 2. Varsayılan Template Güncelle

`Sprinkles/src/config.ts`:

```typescript
savePaths: {
    track: "{artist_name}/{album_name}{multi_disc_path}/{track_num}. {track_name} - {track_id}.ogg",
    episode: "Podcasts/{artist_name}/{album_name}/{release_date} - {track_name} - {track_id}.ogg",
}
```

### 3. Skip Kontrolü Ekle

`SpotifyOggDumper/StateManager.cpp` - `DOWNLOAD_STATUS` handler'a ekle:

```cpp
if (content.contains("checkTrackId")) {
    std::string trackId = content["checkTrackId"];
    std::string basePath = content["basePath"];
    bool exists = IsAlreadyDownloaded(basePath, trackId);
    
    conn->Send(MessageType::DOWNLOAD_STATUS, {
        { "trackId", trackId },
        { "exists", exists }
    });
}
```

### 4. Sprinkles'da Kullan

`Sprinkles/src/player-state-tracker.ts`:

```typescript
const trackId = track.uri.split(':').pop();
const response = await conn.request(MessageType.DOWNLOAD_STATUS, {
    checkTrackId: trackId,
    basePath: config.savePaths.basePath
});

if (response.exists) {
    // Skip this track
}
```

## Özet

| Değişiklik | Dosya | Süre |
|------------|-------|------|
| `{track_id}` değişkeni | path-template.ts | 15 dk |
| Varsayılan template | config.ts | 5 dk |
| `IsAlreadyDownloaded()` | StateManager.cpp | 30 dk |
| Skip kontrolü | player-state-tracker.ts | 30 dk |

**Toplam:** ~1.5 saat
