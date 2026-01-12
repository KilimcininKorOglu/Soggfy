# URI-Based Skip Downloaded Tracks Plan

## Problem

Mevcut `skipDownloadedTracks` sistemi dosya sistemindeki dosya adı pattern'lerine bakarak çalışıyor. Bu yaklaşımın ciddi sorunları var:

> **NOT:** Bu dokumanda iki alternatif çözüm sunulmaktadır:
> 1. **Veritabanı Tabanlı** (Faz 1-7) - Web UI backend gerektirir
> 2. **Dosya Adı Tabanlı** (Önerilen Alternatif) - Standalone çalışır, daha basit

### Mevcut Sistemin Sorunları

1. **Dosya Yeniden Adlandırma**: Dosya adını değiştirirsen, aynı şarkı tekrar indirilir
2. **Template Değişikliği**: `savePaths.track` template'ini değiştirirsen tüm şarkılar "yeni" görülür
3. **Dosya Taşıma**: Dosyayı başka klasöre taşırsan tekrar indirilir
4. **Performans**: Her seferinde dosya sistemini taramak yavaş (özellikle büyük kütüphanelerde)
5. **Farklı Formatlar**: Aynı şarkıyı farklı formatlarda indirirsen (OGG -> MP3) algılanmaz
6. **Regex Karmaşıklığı**: `{multi_disc_path}` gibi opsiyonel pattern'ler BFS ile taranıyor

### Mevcut Akış

```
[Queue Update] 
    → Sprinkles: TemplatedSearchTree oluştur (track metadata'dan)
    → Core DLL'e DOWNLOAD_STATUS gönder (searchTree + basePath)
    → Core DLL: SearchPathTree() ile dosya sistemi tara
    → Dosya varsa → results[uri] = { path, status: "DONE" }
    → Sprinkles: Bulunan parçaları atla
```

## Çözüm: URI-Based Skip System

Spotify URI'leri (`spotify:track:XXXX`) benzersiz ve kalıcıdır. İndirilen her parçanın URI'sini veritabanında saklayarak çok daha güvenilir bir skip sistemi oluşturulabilir.

### Avantajları

1. **Dosya Bağımsız**: Dosya adı, konumu veya formatı değişse bile URI aynı kalır
2. **Hızlı**: Veritabanı sorgusu dosya sistemi taramasından çok daha hızlı
3. **Güvenilir**: Metadata değişiklikleri (sanatçı adı düzeltmesi vb.) etkilemez
4. **Basit**: Karmaşık regex/pattern matching yok
5. **Senkronize**: Farklı cihazlar arasında paylaşılabilir

### Dezavantajları

1. **Migration**: Mevcut indirmeler için geçiş gerekli
2. **Dosya Silme**: Dosya silinse bile veritabanında "indirilmiş" olarak kalır (opsiyonel kontrol eklenebilir)
3. **Remaster/Reissue**: Aynı şarkının farklı versiyonları farklı URI'ye sahip (bu aslında doğru davranış)

## Uygulama Planı

### Faz 1: Veritabanı Şeması (Backend)

Web UI backend'indeki `stats.db` veritabanını kullanacağız. `downloads` tablosunda zaten `track_id` alanı var ama bu Spotify URI değil, sadece ID kısmı.

```sql
-- Mevcut tablo yapısı
CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,  -- Şu an: "6h240MaWo49TJ8Q8Lq8WMC"
    name TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    duration INTEGER DEFAULT 0,
    size INTEGER DEFAULT 0,
    status TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

-- Değişiklik: track_id'yi tam URI olarak sakla
-- "6h240MaWo49TJ8Q8Lq8WMC" → "spotify:track:6h240MaWo49TJ8Q8Lq8WMC"

-- Yeni index ekle
CREATE UNIQUE INDEX IF NOT EXISTS idx_downloads_track_uri ON downloads(track_id);
```

### Faz 2: Core DLL Değişiklikleri (C++)

`StateManager.cpp`'de parça kaydedildiğinde URI zaten biliniyor (`trackUri`). Yeni bir mesaj tipi veya mevcut `DOWNLOAD_STATUS` mesajına ek olarak URI-based kontrol eklenebilir.

**Seçenek A: Yeni Mesaj Tipi**
```cpp
enum class MessageType {
    // ... mevcut tipler
    CHECK_DOWNLOADED = 8,  // Yeni: URI listesi gönder, hangilerinin indirildiğini sor
};
```

**Seçenek B: Mevcut Sistemi Genişlet**
`DOWNLOAD_STATUS` mesajına yeni bir mod ekle:
```json
{
    "checkUris": ["spotify:track:XXX", "spotify:track:YYY"],
    "basePath": "G:\\Spotify"  // Opsiyonel: dosya varlığı da kontrol edilsin
}
```

### Faz 3: Sprinkles Değişiklikleri (TypeScript)

`player-state-tracker.ts`'de `skipIgnoredTracks()` fonksiyonunu güncelle:

```typescript
private async skipIgnoredTracks(queue: any, statusCache: Map<string, boolean>) {
    if (config.skipDownloadedTracks) {
        // Yeni: URI-based kontrol
        const urisToCheck = queue.nextUp
            .filter(track => !statusCache.has(track.uri))
            .map(track => track.uri);
        
        if (urisToCheck.length > 0) {
            const response = await this.conn.request(MessageType.CHECK_DOWNLOADED, {
                uris: urisToCheck
            });
            
            for (const uri of response.downloaded) {
                statusCache.set(uri, true);
            }
        }
        
        // Eski yöntem (opsiyonel fallback)
        // let tree = new TemplatedSearchTree(config.savePaths.track);
        // ...
    }
}
```

### Faz 4: Backend API (Node.js)

Web UI backend'ine yeni endpoint'ler ekle:

```javascript
// İndirilen URI'leri kontrol et
app.post('/api/downloads/check', authMiddleware, (req, res) => {
    const { uris } = req.body;
    const downloaded = stats.checkDownloaded(uris);
    res.json({ downloaded });
});

// Tüm indirilen URI'leri getir (Soggfy ile senkronizasyon için)
app.get('/api/downloads/uris', authMiddleware, (req, res) => {
    const uris = stats.getAllDownloadedUris();
    res.json({ uris });
});
```

StatsManager'a yeni metodlar:

```javascript
checkDownloaded(uris) {
    const placeholders = uris.map(() => '?').join(',');
    const stmt = this.db.prepare(`
        SELECT track_id FROM downloads 
        WHERE track_id IN (${placeholders}) 
        AND status = 'completed'
    `);
    return stmt.all(...uris).map(row => row.track_id);
}

getAllDownloadedUris() {
    return this.db.prepare(`
        SELECT DISTINCT track_id FROM downloads 
        WHERE status = 'completed'
    `).all().map(row => row.track_id);
}
```

### Faz 5: Core DLL - Backend İletişimi

Soğuğy Core DLL şu an sadece Sprinkles ile WebSocket üzerinden iletişim kuruyor. Backend ile iletişim için iki seçenek var:

**Seçenek A: Sprinkles Üzerinden Proxy**
- Sprinkles backend'e HTTP isteği yapar
- Sonucu Core DLL'e iletir
- Pro: Mevcut mimariyi bozmaz
- Con: Ekstra gecikme

**Seçenek B: Core DLL Direkt Backend'e Bağlansın**
- Core DLL ikinci bir WebSocket bağlantısı açar (localhost:3001)
- Pro: Daha hızlı
- Con: C++ tarafında HTTP client veya ikinci WebSocket gerekli

**Seçenek C: Backend Soggfy'a Bağlansın (Mevcut Durum)**
- Backend zaten `ws://127.0.0.1:28653/sgf_ctrl` adresine bağlanıyor
- Bu bağlantı üzerinden URI kontrol mesajları gönderilebilir
- Pro: Mevcut altyapıyı kullanır
- Con: Mesaj protokolü genişletilmeli

### Önerilen Mimari (Seçenek C)

```
                                    ┌─────────────────────┐
                                    │   stats.db          │
                                    │   (downloaded URIs) │
                                    └─────────┬───────────┘
                                              │
┌──────────────┐    WebSocket    ┌────────────┴────────────┐
│  Sprinkles   │◄───────────────►│     Web UI Backend      │
│ (TypeScript) │                 │       (Node.js)         │
└──────┬───────┘                 └────────────┬────────────┘
       │                                      │
       │ WebSocket                            │ WebSocket
       │ (port 28653)                         │ (port 28653)
       │                                      │
       └──────────────┬───────────────────────┘
                      │
              ┌───────┴───────┐
              │   Soggfy      │
              │  Core DLL     │
              │    (C++)      │
              └───────────────┘
```

**Akış:**
1. Queue update → Sprinkles URI listesi hazırlar
2. Sprinkles → Backend: "Bu URI'ler indirilmiş mi?" (HTTP veya Backend üzerinden)
3. Backend: stats.db'den kontrol eder
4. Backend → Sprinkles: İndirilmiş URI listesi
5. Sprinkles: İndirilmiş olanları atla

### Faz 6: Hibrit Mod (Opsiyonel)

Hem URI-based hem dosya-based kontrolü destekle:

```typescript
// config.ts
skipMode: "uri" | "file" | "both"  // Varsayılan: "uri"
```

- `uri`: Sadece veritabanına bak (hızlı, güvenilir)
- `file`: Sadece dosya sistemine bak (mevcut davranış)
- `both`: Her ikisini de kontrol et (en güvenli ama yavaş)

### Faz 7: Migration Tool

Mevcut indirmeleri veritabanına aktarmak için:

```javascript
// migration.js
async function migrateExistingDownloads(basePath, template) {
    // Dosya sistemini tara
    // Her dosya için metadata oku (ID3 tag veya dosya adından)
    // Spotify API ile URI'yi doğrula
    // Veritabanına ekle
}
```

**Alternatif:** Kullanıcı manuel olarak bir playlist'i "zaten indirilmiş" olarak işaretleyebilir.

## Uygulama Önceliği

| Faz | Zorluk | Öncelik | Tahmini Süre |
|-----|--------|---------|--------------|
| 1. Veritabanı | Kolay | Yüksek | 1 saat |
| 2. Core DLL | Orta | Orta | 4 saat |
| 3. Sprinkles | Orta | Yüksek | 3 saat |
| 4. Backend API | Kolay | Yüksek | 2 saat |
| 5. İletişim | Zor | Yüksek | 4 saat |
| 6. Hibrit Mod | Kolay | Düşük | 2 saat |
| 7. Migration | Orta | Düşük | 4 saat |

**Toplam:** ~20 saat

## Minimum Viable Product (MVP)

En hızlı şekilde çalışan bir sistem için:

1. Backend'de `/api/downloads/check` endpoint'i
2. Sprinkles'da HTTP client ile backend'e istek
3. Config'e `skipMode: "uri"` ekleme
4. Mevcut dosya-based sistemi fallback olarak bırakma

Bu MVP ~6 saatte tamamlanabilir.

## Dosya Yapısı Değişiklikleri

```
soggfy-web/backend/
├── statsManager.js      # checkDownloaded(), getAllDownloadedUris() ekle
├── server.js            # /api/downloads/check, /api/downloads/uris endpoint'leri

Sprinkles/src/
├── config.ts            # skipMode seçeneği
├── player-state-tracker.ts  # URI-based skip logic
├── connection.ts        # Backend HTTP client (opsiyonel)

SpotifyOggDumper/
├── StateManager.cpp     # CHECK_DOWNLOADED mesaj handler (opsiyonel)
├── ControlServer.h      # Yeni mesaj tipi (opsiyonel)
```

## Test Senaryoları

1. **Yeni parça indirme** → URI veritabanına kaydedilmeli
2. **Aynı parçayı tekrar çalma** → Skip edilmeli
3. **Dosya silme** → Hala skip edilmeli (veritabanında var)
4. **Dosya adı değiştirme** → Hala skip edilmeli
5. **Template değiştirme** → Hala skip edilmeli
6. **Farklı versiyon (remaster)** → Yeni URI, indirilmeli
7. **Podcast bölümü** → `spotify:episode:XXX` olarak kaydedilmeli

## Sonuç (Veritabanı Yaklaşımı)

URI-based skip sistemi, dosya-based sisteme göre çok daha güvenilir ve hızlı. Mevcut Web UI backend altyapısı (stats.db) zaten bu özellik için uygun. MVP yaklaşımıyla 1 günde çalışan bir sistem elde edilebilir.

---

# Önerilen Alternatif: Dosya Adına Track ID Ekleme

## Konsept

Web UI backend'e bağımlılık olmadan, dosya adının kendisine Spotify Track ID'sini ekleyerek skip kontrolü yapmak.

### Örnek

```
Mevcut Format:
Queen/A Night at the Opera/11. Bohemian Rhapsody.mp3

Yeni Format:
Queen/A Night at the Opera/11. Bohemian Rhapsody - 6h240MaWo49TJ8Q8Lq8WMC.mp3
                                                   └─────────────────────┘
                                                      22 karakterlik ID
```

### Avantajları

| Avantaj | Açıklama |
|---------|----------|
| **Standalone** | Web UI backend'e bağımlılık yok, Soggfy tek başına çalışır |
| **Taşınabilir** | Dosya taşınsa, klasör değişse bile ID dosyada kalır |
| **Basit Kontrol** | Dosya adında ID var mı? Varsa skip |
| **Görsel** | Hangi dosyanın hangi şarkı olduğu dosya adından belli |
| **Duplicate Tespiti** | Aynı ID'ye sahip birden fazla dosya kolayca bulunur |
| **Mevcut Altyapı** | `SearchPathTree` mantığı küçük değişiklikle çalışır |
| **Geriye Uyumlu** | Eski dosyalar çalışmaya devam eder, yeni indirmeler ID içerir |

### Dezavantajları

| Dezavantaj | Çözüm |
|------------|-------|
| Dosya adları uzar (+23 karakter) | Genelde sorun değil, max path limitine dikkat |
| Mevcut indirmeler ID içermez | Opsiyonel migration tool veya manuel yeniden indirme |
| ID görünür olması istenmiyor olabilir | Config'de opsiyonel yapılabilir |

## Uygulama Planı

### Adım 1: Yeni Path Template Değişkeni

`Sprinkles/src/path-template.ts` dosyasına yeni değişken ekle:

```typescript
{
    name: "track_id",
    desc: "Spotify Track ID (22 karakter)",
    pattern: `[a-zA-Z0-9]{22}`,
    getValue: m => m.track_id || m.uri?.split(':').pop() || ""
}
```

### Adım 2: Metadata'ya Track ID Ekle

`Sprinkles/src/player-state-tracker.ts` dosyasında metadata'ya track ID ekle:

```typescript
private getSavePaths(type: string, meta: any, playback: PlayerState) {
    // ... mevcut kod ...
    
    // Track ID'yi metadata'ya ekle
    meta.track_id = playback.item?.uri?.split(':').pop() || '';
    
    let vars = PathTemplate.getVarsFromMetadata(meta, playback);
    // ...
}
```

### Adım 3: Varsayılan Template Güncelleme

`Sprinkles/src/config.ts` dosyasında varsayılan template'i güncelle:

```typescript
savePaths: {
    basePath: "",
    track: "{artist_name}/{album_name}{multi_disc_path}/{track_num}. {track_name} - {track_id}.ogg",
    episode: "Podcasts/{artist_name}/{album_name}/{release_date} - {track_name} - {track_id}.ogg",
    canvas: "{artist_name}/{album_name}{multi_disc_path}/Canvas/{track_num}. {track_name}.mp4",
    invalidCharRepl: "unicode",
}
```

### Adım 4: Skip Kontrolünü Basitleştir

`SpotifyOggDumper/StateManager.cpp` dosyasında `SearchPathTree` fonksiyonunu güncelle veya yeni bir kontrol ekle:

**Seçenek A: Mevcut SearchPathTree'yi Kullan**
Pattern'de `{track_id}` regex olarak eşleşir, mevcut sistem çalışmaya devam eder.

**Seçenek B: Basit ID Arama (Daha Hızlı)**
```cpp
bool IsTrackDownloaded(const std::string& basePath, const std::string& trackId) {
    // Recursive olarak tüm dosyaları tara
    for (auto& entry : fs::recursive_directory_iterator(basePath)) {
        if (entry.is_regular_file()) {
            auto filename = entry.path().stem().string();
            // Dosya adının sonunda " - {trackId}" var mı?
            if (filename.ends_with(" - " + trackId)) {
                return true;
            }
        }
    }
    return false;
}
```

**Seçenek C: Index Dosyası (En Hızlı)**
```cpp
// İndirilen tüm track ID'lerini bir index dosyasında tut
// %localappdata%/Soggfy/downloaded_tracks.txt
// Her satır bir track ID

void AddToIndex(const std::string& trackId) {
    std::ofstream index(_dataDir / "downloaded_tracks.txt", std::ios::app);
    index << trackId << "\n";
}

bool IsInIndex(const std::string& trackId) {
    // Index dosyasını belleğe yükle (lazy load)
    // Set veya unordered_set ile O(1) lookup
    return _downloadedTracks.contains(trackId);
}
```

### Adım 5: UI'da Template Değişkeni Gösterme

`Sprinkles/src/ui/ui.ts` dosyasında path variables listesine `{track_id}` ekle - zaten `PathTemplate.Vars` üzerinden otomatik gösterilecek.

## Dosya Yapısı Değişiklikleri

```
Sprinkles/src/
├── config.ts              # Varsayılan template güncelle
├── path-template.ts       # {track_id} değişkeni ekle
├── player-state-tracker.ts # Metadata'ya track_id ekle

SpotifyOggDumper/
├── StateManager.cpp       # (Opsiyonel) Index dosyası mantığı
```

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

## Index Dosyası Formatı (Seçenek C)

```
# %localappdata%/Soggfy/downloaded_tracks.txt
# Her satır bir Spotify Track/Episode ID
6h240MaWo49TJ8Q8Lq8WMC
4pbJqGIASGPr0ZtwnkXjAj
1mCsF9Tw4cDvVvXb1yVkPf
69kOkLUCkxIZYexIgSG8rq
3xKsf9qdHzyON2fVYh1G8E
```

**Index Yönetimi:**
- Parça indirildiğinde → ID'yi index'e ekle
- Skip kontrolünde → Index'te var mı bak (O(1))
- Dosya silindiğinde → Index'ten çıkar (opsiyonel cleanup komutu)

## Uygulama Önceliği

| Adım | Zorluk | Dosya | Tahmini Süre |
|------|--------|-------|--------------|
| 1. Path değişkeni | Kolay | path-template.ts | 30 dk |
| 2. Metadata | Kolay | player-state-tracker.ts | 30 dk |
| 3. Varsayılan template | Kolay | config.ts | 10 dk |
| 4. Skip kontrolü | Orta | StateManager.cpp | 2 saat |
| 5. UI | Otomatik | - | 0 dk |

**Toplam:** ~3-4 saat

## Migration (Mevcut Dosyalar)

Mevcut dosyaları yeni formata dönüştürmek için opsiyonel bir script:

```python
# migrate_filenames.py
import os
import re
import spotipy  # Spotify API client

def migrate_folder(base_path, sp_client):
    for root, dirs, files in os.walk(base_path):
        for file in files:
            if not re.search(r' - [a-zA-Z0-9]{22}\.[^.]+$', file):
                # ID yok, Spotify'dan bul
                track_name = extract_track_name(file)
                artist_name = extract_artist_from_path(root)
                
                results = sp_client.search(q=f"track:{track_name} artist:{artist_name}", type='track', limit=1)
                if results['tracks']['items']:
                    track_id = results['tracks']['items'][0]['id']
                    new_name = add_id_to_filename(file, track_id)
                    os.rename(os.path.join(root, file), os.path.join(root, new_name))
```

## Config Seçeneği (Opsiyonel)

ID'yi dosya adına eklemek istemeyen kullanıcılar için:

```typescript
// config.ts
includeTrackIdInFilename: true  // Varsayılan: true
```

Eğer `false` ise, eski davranış korunur (pattern-based skip).

## Sonuç

**Dosya Adına Track ID Ekleme** yaklaşımı:
- Web UI backend'e bağımlılık yok
- Mevcut Soggfy altyapısıyla uyumlu
- ~3-4 saatte uygulanabilir
- Daha güvenilir skip kontrolü
- Görsel olarak hangi dosyanın hangi şarkı olduğu belli

**Önerilen Template:**
```
{artist_name}/{album_name}{multi_disc_path}/{track_num}. {track_name} - {track_id}
```

Bu yaklaşım, veritabanı tabanlı çözüme göre çok daha basit ve standalone çalışır.
