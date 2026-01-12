# Dosya Adına Track ID Ekleme ile Skip Downloaded Tracks

## Problem

Mevcut `skipDownloadedTracks` sistemi dosya sistemindeki dosya adı pattern'lerine bakarak çalışıyor. Bu yaklaşımın ciddi sorunları var:

### Mevcut Sistemin Sorunları

1. **Dosya Yeniden Adlandırma**: Dosya adını değiştirirsen, aynı şarkı tekrar indirilir
2. **Template Değişikliği**: `savePaths.track` template'ini değiştirirsen tüm şarkılar "yeni" görülür
3. **Dosya Taşıma**: Dosyayı başka klasöre taşırsan tekrar indirilir
4. **Performans**: Her seferinde dosya sistemini regex ile taramak yavaş
5. **Karmaşık Pattern**: `{multi_disc_path}` gibi opsiyonel pattern'ler BFS ile taranıyor

### Mevcut Akış

```
[Queue Update]
    ↓
Sprinkles: TemplatedSearchTree oluştur
    - Her track için metadata'dan dosya yolu pattern'i hesapla
    - Pattern: "{artist_name}/{album_name}/{track_num}. {track_name}.ogg"
    ↓
Core DLL'e DOWNLOAD_STATUS gönder (searchTree + basePath)
    ↓
Core DLL: SearchPathTree() çağır
    - Dosya sistemini recursive olarak tara
    - Her dosya adını regex pattern ile karşılaştır
    - Eşleşirse → results[uri] = { path, status: "DONE" }
    ↓
Sprinkles: Bulunan parçaları queue'dan atla
```

**Sorun:** Pattern eşleştirme metadata'ya bağımlı. Dosya adı veya klasör yapısı değişirse eşleşme başarısız olur.

---

## Çözüm: Dosya Adına Track ID Ekleme

Spotify Track ID'si (`6h240MaWo49TJ8Q8Lq8WMC`) benzersiz ve kalıcıdır. Bu ID'yi dosya adına ekleyerek skip kontrolünü basitleştiriyoruz.

### Örnek

```
Mevcut Format:
Queen/A Night at the Opera/11. Bohemian Rhapsody.mp3

Yeni Format:
Queen/A Night at the Opera/11. Bohemian Rhapsody - 6h240MaWo49TJ8Q8Lq8WMC.mp3
                                                   └─────────────────────────┘
                                                        22 karakterlik ID
```

### Yeni Skip Kontrolü Akışı

```
[Queue Update]
    ↓
Sprinkles: Track ID listesi hazırla
    - queue.nextUp'tan URI'leri çıkar
    - ["6h240MaWo49TJ8Q8Lq8WMC", "4pbJqGIASGPr0ZtwnkXjAj", ...]
    ↓
Core DLL'e CHECK_DOWNLOADED gönder (trackIds + basePath)
    ↓
Core DLL: Index dosyasına bak VEYA dosya sistemini tara
    - Index: O(1) lookup - Set'te var mı?
    - Dosya: Dosya adında " - {trackId}." içeriyor mu?
    ↓
Sprinkles: Bulunan ID'leri queue'dan atla
```

---

## Skip Kontrolü Detayı

### Seçenek A: Index Dosyası (Önerilen - En Hızlı)

İndirilen her track ID'sini bir text dosyasında tutuyoruz.

**Dosya:** `%localappdata%/Soggfy/downloaded_tracks.txt`

```
# Her satır bir Spotify Track/Episode ID
6h240MaWo49TJ8Q8Lq8WMC
4pbJqGIASGPr0ZtwnkXjAj
1mCsF9Tw4cDvVvXb1yVkPf
69kOkLUCkxIZYexIgSG8rq
```

**C++ Implementasyonu (StateManager.cpp):**

```cpp
class StateManagerImpl {
private:
    std::unordered_set<std::string> _downloadedTracks;
    fs::path _indexPath;
    bool _indexLoaded = false;

    void LoadIndex() {
        if (_indexLoaded) return;
        
        _indexPath = _dataDir / "downloaded_tracks.txt";
        
        if (fs::exists(_indexPath)) {
            std::ifstream file(_indexPath);
            std::string line;
            while (std::getline(file, line)) {
                if (!line.empty() && line[0] != '#') {
                    _downloadedTracks.insert(line);
                }
            }
        }
        _indexLoaded = true;
        LogInfo("Loaded {} downloaded track IDs", _downloadedTracks.size());
    }

    void AddToIndex(const std::string& trackId) {
        if (_downloadedTracks.insert(trackId).second) {
            // Yeni ID eklendi, dosyaya yaz
            std::ofstream file(_indexPath, std::ios::app);
            file << trackId << "\n";
        }
    }

    bool IsDownloaded(const std::string& trackId) {
        LoadIndex();  // Lazy load
        return _downloadedTracks.contains(trackId);
    }

    std::vector<std::string> CheckDownloaded(const std::vector<std::string>& trackIds) {
        LoadIndex();
        std::vector<std::string> result;
        for (const auto& id : trackIds) {
            if (_downloadedTracks.contains(id)) {
                result.push_back(id);
            }
        }
        return result;
    }
};
```

**Mesaj Handler (DOWNLOAD_STATUS case'ine ekle):**

```cpp
case MessageType::DOWNLOAD_STATUS: {
    // ... mevcut kod ...
    
    // Yeni: Track ID listesi kontrolü
    if (content.contains("checkTrackIds")) {
        std::vector<std::string> ids = content["checkTrackIds"];
        auto downloaded = CheckDownloaded(ids);
        
        conn->Send(MessageType::DOWNLOAD_STATUS, {
            { "reqId", content["reqId"] },
            { "downloadedIds", downloaded }
        });
    }
    break;
}
```

**Track kaydedildiğinde index'e ekle (SaveTrack fonksiyonunda):**

```cpp
void SaveTrack(Playback* playback, Message msg) {
    // ... mevcut kaydetme kodu ...
    
    // Başarılı kaydedildikten sonra
    std::string trackId = trackUri.substr(trackUri.rfind(':') + 1);
    AddToIndex(trackId);
    
    SendTrackStatus(trackUri, "DONE", "", trackPath);
}
```

### Seçenek B: Dosya Sistemi Tarama (Fallback)

Index dosyası yoksa veya bozuksa, dosya sisteminde ID ara.

```cpp
bool IsDownloadedByFileScan(const std::string& basePath, const std::string& trackId) {
    std::string searchPattern = " - " + trackId + ".";
    
    for (auto& entry : fs::recursive_directory_iterator(basePath)) {
        if (entry.is_regular_file()) {
            std::string filename = entry.path().filename().string();
            if (filename.find(searchPattern) != std::string::npos) {
                return true;
            }
        }
    }
    return false;
}
```

**Not:** Bu yöntem yavaş, sadece fallback olarak kullanılmalı.

---

## Sprinkles Değişiklikleri

### 1. Yeni Path Template Değişkeni

`Sprinkles/src/path-template.ts`:

```typescript
{
    name: "track_id",
    desc: "Spotify Track/Episode ID (22 karakter)",
    pattern: `[a-zA-Z0-9]{22}`,
    getValue: (m, s) => {
        // URI'den ID'yi çıkar: "spotify:track:XXX" → "XXX"
        const uri = s.item?.uri || m.uri || "";
        return uri.split(':').pop() || "";
    }
}
```

### 2. Varsayılan Template Güncelleme

`Sprinkles/src/config.ts`:

```typescript
savePaths: {
    basePath: "",
    track: "{artist_name}/{album_name}{multi_disc_path}/{track_num}. {track_name} - {track_id}.ogg",
    episode: "Podcasts/{artist_name}/{album_name}/{release_date} - {track_name} - {track_id}.ogg",
    canvas: "{artist_name}/{album_name}{multi_disc_path}/Canvas/{track_num}. {track_name}.mp4",
    invalidCharRepl: "unicode",
}
```

### 3. Skip Kontrolü Güncelleme

`Sprinkles/src/player-state-tracker.ts`:

```typescript
private async skipIgnoredTracks(queue: any, statusCache: Map<string, boolean>) {
    if (!config.skipDownloadedTracks || !conn.isConnected) return;
    
    // Kontrol edilecek track ID'leri topla
    const idsToCheck: string[] = [];
    
    for (const track of queue.nextUp) {
        if (!statusCache.has(track.uri)) {
            const trackId = track.uri.split(':').pop();
            if (trackId) {
                idsToCheck.push(trackId);
                statusCache.set(track.uri, false);  // Varsayılan: indirilmemiş
            }
        }
    }
    
    if (idsToCheck.length === 0) return;
    
    // Core DLL'e sor
    const response = await this.conn.request(MessageType.DOWNLOAD_STATUS, {
        checkTrackIds: idsToCheck
    });
    
    // İndirilmiş olanları işaretle
    const downloadedIds = new Set(response.downloadedIds || []);
    const tracksToSkip: string[] = [];
    
    for (const track of queue.nextUp) {
        const trackId = track.uri.split(':').pop();
        if (downloadedIds.has(trackId)) {
            statusCache.set(track.uri, true);
            tracksToSkip.push(track.uri);
        }
    }
    
    // Skip downloaded tracks
    if (tracksToSkip.length > 0) {
        SpotifyUtils.skipTracks(tracksToSkip);
    }
}
```

---

## Avantajlar

| Avantaj | Açıklama |
|---------|----------|
| **Standalone** | Web UI backend'e bağımlılık yok |
| **Hızlı** | Index ile O(1) lookup, regex yok |
| **Güvenilir** | Dosya taşınsa, yeniden adlandırılsa bile ID kalır |
| **Basit** | Karmaşık pattern matching yok |
| **Görsel** | Dosya adından hangi şarkı olduğu belli |
| **Geriye Uyumlu** | Eski dosyalar çalışmaya devam eder |

---

## Dosya Yapısı Değişiklikleri

```
Sprinkles/src/
├── config.ts               # Varsayılan template güncelle
├── path-template.ts        # {track_id} değişkeni ekle
├── player-state-tracker.ts # Skip kontrolü güncelle

SpotifyOggDumper/
├── StateManager.cpp        # Index yönetimi + CheckDownloaded handler
├── StateManager.h          # (gerekirse) yeni üye değişkenler
```

---

## Uygulama Adımları

| # | Adım | Dosya | Süre |
|---|------|-------|------|
| 1 | `{track_id}` değişkeni ekle | path-template.ts | 30 dk |
| 2 | Varsayılan template güncelle | config.ts | 10 dk |
| 3 | Index dosyası yönetimi | StateManager.cpp | 1 saat |
| 4 | `checkTrackIds` handler | StateManager.cpp | 1 saat |
| 5 | Skip kontrolü güncelle | player-state-tracker.ts | 1 saat |
| 6 | Test | - | 30 dk |

**Toplam:** ~4 saat

---

## Örnek Çıktılar

### Müzik Dosyaları
```
G:\Spotify\
├── Queen/
│   └── A Night at the Opera/
│       ├── 01. Death on Two Legs - 4pbJqGIASGPr0ZtwnkXjAj.mp3
│       ├── 02. Lazing on a Sunday Afternoon - 1mCsF9Tw4cDvVvXb1yVkPf.mp3
│       └── 11. Bohemian Rhapsody - 6h240MaWo49TJ8Q8Lq8WMC.mp3
├── Daft Punk/
│   └── Random Access Memories/
│       ├── 01. Give Life Back to Music - 0DiWol3AO6WpXZgp0goxAV.mp3
│       └── 08. Get Lucky - 69kOkLUCkxIZYexIgSG8rq.mp3
```

### Podcast Bölümleri
```
G:\Spotify\
└── Podcasts/
    └── Joe Rogan Experience/
        └── JRE MMA Show/
            └── 2024-01-15 - #148 with Georges St-Pierre - 3xKsf9qdHzyON2fVYh1G8E.mp3
```

### Index Dosyası
```
# %localappdata%/Soggfy/downloaded_tracks.txt
6h240MaWo49TJ8Q8Lq8WMC
4pbJqGIASGPr0ZtwnkXjAj
1mCsF9Tw4cDvVvXb1yVkPf
69kOkLUCkxIZYexIgSG8rq
3xKsf9qdHzyON2fVYh1G8E
```

---

## Test Senaryoları

1. **Yeni parça indirme** → ID dosya adına ve index'e eklenmeli
2. **Aynı parçayı tekrar çalma** → Skip edilmeli (index'te var)
3. **Dosya silme** → Index'te kalır, skip edilir (beklenen davranış)
4. **Dosya adı değiştirme** → Index'te var, skip edilir
5. **Klasör taşıma** → Index'te var, skip edilir
6. **Template değiştirme** → Index'te var, skip edilir
7. **Index silme** → Dosya sistemi taraması ile fallback (yavaş)
8. **Farklı versiyon (remaster)** → Farklı ID, indirilmeli
9. **Podcast bölümü** → Episode ID ile aynı mantık

---

## Opsiyonel: Config Seçeneği

ID'yi dosya adına eklemek istemeyen kullanıcılar için:

```typescript
// config.ts
includeTrackIdInFilename: true  // Varsayılan: true
```

Eğer `false` ise:
- Dosya adına ID eklenmez
- Skip kontrolü eski pattern-based sisteme döner

---

## Özet

**Dosya Adına Track ID Ekleme** yaklaşımı:
- Standalone çalışır (Web UI backend gerekmez)
- ~4 saatte uygulanabilir
- Index dosyası ile O(1) skip kontrolü
- Dosya taşıma/yeniden adlandırma sorunlarını çözer

**Önerilen Template:**
```
{artist_name}/{album_name}{multi_disc_path}/{track_num}. {track_name} - {track_id}
```
