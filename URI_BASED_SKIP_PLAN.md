# Dosya Adına Track ID Ekleme ile Skip Downloaded Tracks

## Problem

Mevcut `skipDownloadedTracks` sistemi karmaşık regex pattern'leri ile dosya sistemi tarıyor. Dosya adı veya klasör değişirse aynı şarkı tekrar indirilir.

## Çözüm

Dosya adının sonuna otomatik olarak Track ID ekle. Kullanıcı template'inden bağımsız, sistem tarafından eklenir.

### Örnek

```
Kullanıcı Template:  {track_num}. {track_name}
Sonuç:               11. Bohemian Rhapsody - 6h240MaWo49TJ8Q8Lq8WMC.mp3
                                            └──────────────────────────┘
                                              Sistem tarafından eklenir
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

### 1. Dosya Adına ID Ekleme (Otomatik)

`Sprinkles/src/player-state-tracker.ts` - `getSavePaths()` fonksiyonunda:

```typescript
private getSavePaths(type: string, meta: any, playback: PlayerState) {
    let template = config.savePaths[type] as string;
    // ... mevcut kod ...
    
    let trackPath = path + PathTemplate.render(template, vars);
    
    // Track ID'yi dosya adının sonuna otomatik ekle
    const trackId = playback.item?.uri?.split(':').pop() || "";
    if (trackId) {
        // Uzantıdan önce " - {trackId}" ekle
        const ext = trackPath.match(/\.[^.]+$/)?.[0] || "";
        trackPath = trackPath.replace(/\.[^.]+$/, "") + " - " + trackId + ext;
    }
    
    return {
        track: trackPath,
        // ...
    };
}
```

### 2. Skip Kontrolü Ekle

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

### 3. Skip Kontrolünü Çağır

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

| Değişiklik              | Dosya                   | Süre  |
|-------------------------|-------------------------|-------|
| Otomatik ID ekleme      | player-state-tracker.ts | 30 dk |
| `IsAlreadyDownloaded()` | StateManager.cpp        | 30 dk |
| Skip kontrolü           | player-state-tracker.ts | 30 dk |

**Toplam:** ~1.5 saat

## Not

- Kullanıcı template'i değişmez, `{track_id}` değişkeni eklemeye gerek yok
- ID her zaman dosya adının sonuna, uzantıdan önce eklenir
- Format: `{kullanıcı_şablonu} - {track_id}.{ext}`
