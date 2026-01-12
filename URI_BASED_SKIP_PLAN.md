# URI-Based Skip Downloaded Tracks Plan

## Problem

Mevcut `skipDownloadedTracks` sistemi dosya sistemindeki dosya adı pattern'lerine bakarak çalışıyor. Bu yaklaşımın ciddi sorunları var:

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

## Sonuç

URI-based skip sistemi, dosya-based sisteme göre çok daha güvenilir ve hızlı. Mevcut Web UI backend altyapısı (stats.db) zaten bu özellik için uygun. MVP yaklaşımıyla 1 günde çalışan bir sistem elde edilebilir.
