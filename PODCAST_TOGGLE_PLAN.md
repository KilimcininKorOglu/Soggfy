# Podcast Download Toggle Feature - Implementation Plan

## Ozet

Soggfy ayarlarına podcast indirme özelliğini aktif/pasif yapan bir toggle eklemek.

## Mevcut Sistem Analizi

### 1. Config Yapisi (`Sprinkles/src/config.ts`)

```typescript
let config = {
    playbackSpeed: 1.0,
    downloaderEnabled: true,
    skipDownloadedTracks: false,
    skipIgnoredTracks: false,
    embedLyrics: true,
    saveLyrics: true,
    embedCoverArt: true,
    saveCoverArt: true,
    saveCanvas: false,
    // ... diger ayarlar
};
```

**Podcast icin ozel ayar YOK.**

### 2. Track Type Algilama (`Sprinkles/src/resources.ts`)

```typescript
static getUriType(uri: string) {
    return uri.split(':')[1];  // "track" veya "episode" dondurur
}
```

URI ornekleri:
- Track: `spotify:track:4iV5W9uYEdYUVa79Axb7Rh`
- Episode: `spotify:episode:512ojhOuo1ktJprKbVcKyQ`

### 3. Podcast Metadata Alma (`Sprinkles/src/player-state-tracker.ts`)

```typescript
async getMetadata(playbackId: string) {
    let track = playback.item;
    let type = Resources.getUriType(track.uri);

    let meta: any = type === "track"
        ? await this.getTrackMetaProps(track)
        : await this.getPodcastMetaProps(track);  // <-- Podcast icin ayri fonksiyon
    
    // ...
}
```

### 4. Ignore Mekanizmasi (`Sprinkles/src/config.ts`)

```typescript
export function isTrackIgnored(track) {
    let tieUris = [
        track.uri,
        track.album?.uri ?? track.albumUri,
        track.metadata?.context_uri ?? track.contextUri,
        ...(track.artists ?? [])
    ];
    return tieUris.some(res => config.ignorelist[res?.uri ?? res]);
}
```

**Bu fonksiyon track type kontrolu YAPMIYOR.**

### 5. Download Status Gonderimi (`Sprinkles/src/player-state-tracker.ts`)

```typescript
// Player update event'inde
if (!this.playbacks.has(data.playbackId)) {
    conn.send(MessageType.DOWNLOAD_STATUS, { 
        playbackId: data.playbackId, 
        ignore: isTrackIgnored(data.item)  // <-- Burada karar veriliyor
    });
    conn.send(MessageType.PLAYER_STATE, { event: "trackstart", playbackId: data.playbackId });
}
```

### 6. Settings UI (`Sprinkles/src/ui/ui.ts`)

```typescript
return UIC.createSettingOverlay(
    UIC.section("General",
        // ... toggle'lar burada
        UIC.row("Skip downloaded tracks",   UIC.toggle("skipDownloadedTracks", onChange)),
        UIC.row("Skip ignored tracks",      UIC.toggle("skipIgnoredTracks", onChange)),
        // ...
    ),
    // ...
);
```

---

## Implementasyon Plani

### Adim 1: Config'e Yeni Ayar Ekle

**Dosya:** `Sprinkles/src/config.ts`

```typescript
let config = {
    playbackSpeed: 1.0,
    downloaderEnabled: true,
    downloadPodcasts: true,     // <-- YENİ AYAR
    skipDownloadedTracks: false,
    skipIgnoredTracks: false,
    // ...
};
```

### Adim 2: isTrackIgnored Fonksiyonunu Guncelle

**Dosya:** `Sprinkles/src/config.ts`

```typescript
export function isTrackIgnored(track) {
    // Podcast kontrolu ekle
    if (!config.downloadPodcasts && track.type === "episode") {
        return true;
    }
    // veya URI'den kontrol
    if (!config.downloadPodcasts && track.uri?.startsWith("spotify:episode:")) {
        return true;
    }

    let tieUris = [
        track.uri,
        track.album?.uri ?? track.albumUri,
        track.metadata?.context_uri ?? track.contextUri,
        ...(track.artists ?? [])
    ];
    return tieUris.some(res => config.ignorelist[res?.uri ?? res]);
}
```

### Adim 3: Settings UI'a Toggle Ekle

**Dosya:** `Sprinkles/src/ui/ui.ts`

`createSettingsDialog()` fonksiyonunda:

```typescript
return UIC.createSettingOverlay(
    UIC.section("General",
        UIC.row("Playback speed",           UIC.slider("playbackSpeed", { ... }, onChange)),
        UIC.row("Output format",            UIC.select("outputFormat", ...)),
        customFormatSection,
        UIC.row("Download podcasts",        UIC.toggle("downloadPodcasts", onChange)),  // <-- YENİ
        UIC.row("Skip downloaded tracks",   UIC.toggle("skipDownloadedTracks", onChange)),
        // ...
    ),
    // ...
);
```

---

## Kod Degisiklikleri (Detayli)

### Dosya 1: `Sprinkles/src/config.ts`

```diff
 let config = {
     playbackSpeed: 1.0,
     downloaderEnabled: true,
+    downloadPodcasts: true,
     skipDownloadedTracks: false,
     skipIgnoredTracks: false,
     embedLyrics: true,
     // ...
 };
 export default config;
 
 export function isTrackIgnored(track) {
+    // Check if podcasts are disabled
+    if (!config.downloadPodcasts) {
+        // Check by type property or URI prefix
+        const isEpisode = track.type === "episode" || 
+                          track.uri?.startsWith("spotify:episode:");
+        if (isEpisode) {
+            return true;
+        }
+    }
+
     let tieUris = [
         track.uri,
         track.album?.uri ?? track.albumUri,
         track.metadata?.context_uri ?? track.contextUri,
         ...(track.artists ?? [])
     ];
     return tieUris.some(res => config.ignorelist[res?.uri ?? res]);
 }
```

### Dosya 2: `Sprinkles/src/ui/ui.ts`

```diff
     private createSettingsDialog() {
         // ... (onceki kod)
 
         return UIC.createSettingOverlay(
             UIC.section("General",
                 UIC.row("Playback speed",           UIC.slider("playbackSpeed", { min: 1, max: 50, step: 1, formatter: val => val + "x" }, onChange)),
                 UIC.row("Output format",            UIC.select("outputFormat", Object.getOwnPropertyNames(defaultFormats), onFormatChange)),
                 customFormatSection,
+                UIC.row("Download podcasts",        UIC.toggle("downloadPodcasts", onChange)),
                 UIC.row("Skip downloaded tracks",   UIC.toggle("skipDownloadedTracks", onChange)),
                 UIC.row("Skip ignored tracks",      UIC.toggle("skipIgnoredTracks", onChange)),
                 UIC.row("Embed cover art",          UIC.toggle("embedCoverArt", onChange)),
                 // ...
             ),
             // ...
         );
     }
```

---

## Alternatif Yaklasim: Ayri "Content Types" Bolumu

Daha kapsamli bir cozum icin ayri bir bolum eklenebilir:

```typescript
UIC.section("Content Types",
    UIC.row("Download music tracks",    UIC.toggle("downloadTracks", onChange)),
    UIC.row("Download podcasts",        UIC.toggle("downloadPodcasts", onChange)),
),
```

Bu durumda config:

```typescript
let config = {
    // ...
    downloadTracks: true,      // Muzik sarkilari
    downloadPodcasts: true,    // Podcast bolümleri
    // ...
};
```

Ve `isTrackIgnored`:

```typescript
export function isTrackIgnored(track) {
    const uri = track.uri || "";
    
    // Content type kontrolu
    if (!config.downloadTracks && uri.startsWith("spotify:track:")) {
        return true;
    }
    if (!config.downloadPodcasts && uri.startsWith("spotify:episode:")) {
        return true;
    }

    // Mevcut ignorelist kontrolu
    let tieUris = [
        track.uri,
        track.album?.uri ?? track.albumUri,
        track.metadata?.context_uri ?? track.contextUri,
        ...(track.artists ?? [])
    ];
    return tieUris.some(res => config.ignorelist[res?.uri ?? res]);
}
```

---

## Test Senaryolari

1. **Podcast toggle OFF iken:**
   - Podcast calarken indirme baslamamamli
   - Status indicator "Ignored" gostermeli
   - Muzik sarkilari normal indirilmeli

2. **Podcast toggle ON iken:**
   - Podcast calarken indirme baslamali
   - Normal sarkilar da indirilmeli

3. **Config Sync:**
   - Ayar degistiginde C++ tarafina SYNC_CONFIG gonderilmeli
   - Spotify yeniden baslatildiginda ayar korunmali

---

## Dosya Ozeti

| Dosya | Degisiklik |
|-------|-----------|
| `Sprinkles/src/config.ts` | `downloadPodcasts` ayari + `isTrackIgnored` guncelleme |
| `Sprinkles/src/ui/ui.ts` | Settings dialog'a toggle ekleme |

**Tahmini Sure:** 15-30 dakika

**Zorluk:** Kolay - Mevcut altyapi zaten podcast/track ayrimini destekliyor.
