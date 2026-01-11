# File Management Feature

**Branch:** `feature/file-management`

## Overview

Add file management capabilities to browse, organize, and manage downloaded music files directly from the Web UI, including viewing, deleting, moving files, and editing metadata.

## Features

### 1. File Browser

- Browse downloaded music files
- Navigate folder structure
- View file details (size, format, bitrate)
- Search files by name, artist, album
- Sort by name, date, size

### 2. File Operations

- Delete files
- Move files to different folders
- Rename files
- Bulk operations (select multiple)

### 3. Metadata Viewer/Editor

- View embedded metadata (ID3 tags)
- Edit metadata (title, artist, album, etc.)
- View/change album artwork
- Batch metadata editing

### 4. Storage Statistics

- Total storage used
- Storage by artist/album
- Duplicate file detection
- File format distribution

## Technical Implementation

### Backend Changes

#### New Dependencies

```bash
cd soggfy-web/backend
npm install music-metadata node-id3 sharp
```

#### New Files

```
soggfy-web/backend/
├── fileManager.js        # File operations and browsing
├── metadataEditor.js     # Metadata reading and writing
```

#### fileManager.js

```javascript
const fs = require('fs').promises;
const path = require('path');
const mm = require('music-metadata');

class FileManager {
  constructor(basePath) {
    this.basePath = basePath;
  }

  // Ensure path is within base path (security)
  validatePath(targetPath) {
    const resolved = path.resolve(this.basePath, targetPath);
    if (!resolved.startsWith(this.basePath)) {
      throw new Error('Access denied: Path outside base directory');
    }
    return resolved;
  }

  // List directory contents
  async listDirectory(relativePath = '') {
    const dirPath = this.validatePath(relativePath);
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const items = [];

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const stats = await fs.stat(fullPath);
        
        const item = {
          name: entry.name,
          path: path.relative(this.basePath, fullPath),
          isDirectory: entry.isDirectory(),
          size: stats.size,
          modified: stats.mtime,
          created: stats.birthtime
        };

        // Get audio metadata for music files
        if (!entry.isDirectory() && this.isAudioFile(entry.name)) {
          try {
            const metadata = await mm.parseFile(fullPath);
            item.metadata = {
              title: metadata.common.title,
              artist: metadata.common.artist,
              album: metadata.common.album,
              year: metadata.common.year,
              duration: metadata.format.duration,
              bitrate: metadata.format.bitrate,
              format: metadata.format.codec,
              hasArtwork: metadata.common.picture?.length > 0
            };
          } catch (e) {
            item.metadata = null;
          }
        }

        items.push(item);
      }

      // Sort: directories first, then by name
      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      return {
        path: relativePath,
        parentPath: relativePath ? path.dirname(relativePath) : null,
        items
      };
    } catch (error) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }

  // Get file details
  async getFileDetails(relativePath) {
    const filePath = this.validatePath(relativePath);
    
    const stats = await fs.stat(filePath);
    
    const details = {
      name: path.basename(filePath),
      path: relativePath,
      size: stats.size,
      modified: stats.mtime,
      created: stats.birthtime
    };

    if (this.isAudioFile(filePath)) {
      const metadata = await mm.parseFile(filePath);
      details.metadata = {
        title: metadata.common.title,
        artist: metadata.common.artist,
        album: metadata.common.album,
        albumArtist: metadata.common.albumartist,
        year: metadata.common.year,
        track: metadata.common.track,
        disk: metadata.common.disk,
        genre: metadata.common.genre,
        duration: metadata.format.duration,
        bitrate: metadata.format.bitrate,
        sampleRate: metadata.format.sampleRate,
        channels: metadata.format.numberOfChannels,
        format: metadata.format.codec,
        lossless: metadata.format.lossless
      };

      // Get artwork
      if (metadata.common.picture?.length > 0) {
        const pic = metadata.common.picture[0];
        details.artwork = {
          format: pic.format,
          type: pic.type,
          data: pic.data.toString('base64')
        };
      }
    }

    return details;
  }

  // Delete file or directory
  async delete(relativePath) {
    const targetPath = this.validatePath(relativePath);
    const stats = await fs.stat(targetPath);
    
    if (stats.isDirectory()) {
      await fs.rm(targetPath, { recursive: true });
    } else {
      await fs.unlink(targetPath);
    }

    return { success: true, path: relativePath };
  }

  // Move/rename file or directory
  async move(fromPath, toPath) {
    const source = this.validatePath(fromPath);
    const dest = this.validatePath(toPath);
    
    await fs.rename(source, dest);
    
    return { success: true, from: fromPath, to: toPath };
  }

  // Create directory
  async createDirectory(relativePath) {
    const dirPath = this.validatePath(relativePath);
    await fs.mkdir(dirPath, { recursive: true });
    return { success: true, path: relativePath };
  }

  // Search files
  async search(query, options = {}) {
    const results = [];
    const searchLower = query.toLowerCase();
    
    const searchDir = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else if (this.isAudioFile(entry.name)) {
          const relativePath = path.relative(this.basePath, fullPath);
          
          // Check filename match
          if (entry.name.toLowerCase().includes(searchLower)) {
            const stats = await fs.stat(fullPath);
            results.push({
              name: entry.name,
              path: relativePath,
              size: stats.size,
              modified: stats.mtime,
              matchType: 'filename'
            });
            continue;
          }

          // Check metadata match if requested
          if (options.searchMetadata) {
            try {
              const metadata = await mm.parseFile(fullPath);
              const matchFields = [
                metadata.common.title,
                metadata.common.artist,
                metadata.common.album
              ].filter(Boolean);

              for (const field of matchFields) {
                if (field.toLowerCase().includes(searchLower)) {
                  const stats = await fs.stat(fullPath);
                  results.push({
                    name: entry.name,
                    path: relativePath,
                    size: stats.size,
                    modified: stats.mtime,
                    matchType: 'metadata',
                    metadata: {
                      title: metadata.common.title,
                      artist: metadata.common.artist,
                      album: metadata.common.album
                    }
                  });
                  break;
                }
              }
            } catch (e) {
              // Ignore metadata parsing errors
            }
          }
        }
      }
    };

    await searchDir(this.basePath);
    
    return results.slice(0, options.limit || 100);
  }

  // Get storage statistics
  async getStorageStats() {
    const stats = {
      totalFiles: 0,
      totalSize: 0,
      byFormat: {},
      byArtist: {},
      byYear: {}
    };

    const processDir = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await processDir(fullPath);
        } else if (this.isAudioFile(entry.name)) {
          const fileStats = await fs.stat(fullPath);
          stats.totalFiles++;
          stats.totalSize += fileStats.size;

          // Get format
          const ext = path.extname(entry.name).toLowerCase().slice(1);
          stats.byFormat[ext] = (stats.byFormat[ext] || 0) + 1;

          // Get metadata for artist/year stats
          try {
            const metadata = await mm.parseFile(fullPath);
            const artist = metadata.common.artist || 'Unknown';
            const year = metadata.common.year || 'Unknown';

            stats.byArtist[artist] = (stats.byArtist[artist] || 0) + 1;
            stats.byYear[year] = (stats.byYear[year] || 0) + 1;
          } catch (e) {
            // Ignore errors
          }
        }
      }
    };

    await processDir(this.basePath);

    // Convert to sorted arrays
    stats.topArtists = Object.entries(stats.byArtist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([artist, count]) => ({ artist, count }));

    return stats;
  }

  // Find duplicate files (same name or same metadata)
  async findDuplicates() {
    const filesByHash = new Map();
    const duplicates = [];

    const processDir = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await processDir(fullPath);
        } else if (this.isAudioFile(entry.name)) {
          try {
            const metadata = await mm.parseFile(fullPath);
            const key = `${metadata.common.title}|${metadata.common.artist}|${metadata.common.album}`;
            
            if (filesByHash.has(key)) {
              duplicates.push({
                original: filesByHash.get(key),
                duplicate: path.relative(this.basePath, fullPath),
                key
              });
            } else {
              filesByHash.set(key, path.relative(this.basePath, fullPath));
            }
          } catch (e) {
            // Ignore errors
          }
        }
      }
    };

    await processDir(this.basePath);
    return duplicates;
  }

  isAudioFile(filename) {
    const audioExtensions = ['.mp3', '.flac', '.ogg', '.m4a', '.wav', '.aac', '.wma'];
    return audioExtensions.includes(path.extname(filename).toLowerCase());
  }
}

module.exports = FileManager;
```

#### metadataEditor.js

```javascript
const NodeID3 = require('node-id3');
const mm = require('music-metadata');
const fs = require('fs').promises;
const path = require('path');

class MetadataEditor {
  constructor(basePath) {
    this.basePath = basePath;
  }

  validatePath(targetPath) {
    const resolved = path.resolve(this.basePath, targetPath);
    if (!resolved.startsWith(this.basePath)) {
      throw new Error('Access denied');
    }
    return resolved;
  }

  // Read metadata from file
  async readMetadata(relativePath) {
    const filePath = this.validatePath(relativePath);
    const metadata = await mm.parseFile(filePath);
    
    return {
      title: metadata.common.title,
      artist: metadata.common.artist,
      album: metadata.common.album,
      albumArtist: metadata.common.albumartist,
      year: metadata.common.year,
      track: metadata.common.track?.no,
      trackTotal: metadata.common.track?.of,
      disk: metadata.common.disk?.no,
      diskTotal: metadata.common.disk?.of,
      genre: metadata.common.genre?.join(', '),
      composer: metadata.common.composer?.join(', '),
      comment: metadata.common.comment?.join('\n'),
      lyrics: metadata.common.lyrics?.join('\n'),
      hasArtwork: metadata.common.picture?.length > 0
    };
  }

  // Write metadata to MP3 file
  async writeMetadata(relativePath, updates) {
    const filePath = this.validatePath(relativePath);
    const ext = path.extname(filePath).toLowerCase();

    if (ext !== '.mp3') {
      throw new Error('Metadata editing only supported for MP3 files');
    }

    const tags = {};
    
    if (updates.title !== undefined) tags.title = updates.title;
    if (updates.artist !== undefined) tags.artist = updates.artist;
    if (updates.album !== undefined) tags.album = updates.album;
    if (updates.albumArtist !== undefined) tags.performerInfo = updates.albumArtist;
    if (updates.year !== undefined) tags.year = updates.year.toString();
    if (updates.track !== undefined) tags.trackNumber = updates.track.toString();
    if (updates.genre !== undefined) tags.genre = updates.genre;
    if (updates.composer !== undefined) tags.composer = updates.composer;
    if (updates.comment !== undefined) tags.comment = { text: updates.comment };

    // Handle artwork
    if (updates.artwork) {
      if (updates.artwork.startsWith('data:')) {
        // Base64 data URL
        const matches = updates.artwork.match(/^data:(.+);base64,(.+)$/);
        if (matches) {
          tags.image = {
            mime: matches[1],
            type: { id: 3, name: 'front cover' },
            imageBuffer: Buffer.from(matches[2], 'base64')
          };
        }
      } else if (updates.artwork.startsWith('http')) {
        // URL - download and embed
        const response = await fetch(updates.artwork);
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type');
        tags.image = {
          mime: contentType,
          type: { id: 3, name: 'front cover' },
          imageBuffer: Buffer.from(buffer)
        };
      }
    }

    const success = NodeID3.update(tags, filePath);
    
    if (!success) {
      throw new Error('Failed to write metadata');
    }

    return { success: true };
  }

  // Get artwork as base64
  async getArtwork(relativePath) {
    const filePath = this.validatePath(relativePath);
    const metadata = await mm.parseFile(filePath);
    
    if (!metadata.common.picture?.length) {
      return null;
    }

    const pic = metadata.common.picture[0];
    return {
      format: pic.format,
      data: `data:${pic.format};base64,${pic.data.toString('base64')}`
    };
  }

  // Remove artwork
  async removeArtwork(relativePath) {
    const filePath = this.validatePath(relativePath);
    const ext = path.extname(filePath).toLowerCase();

    if (ext !== '.mp3') {
      throw new Error('Artwork removal only supported for MP3 files');
    }

    NodeID3.update({ image: null }, filePath);
    return { success: true };
  }

  // Batch update metadata
  async batchUpdate(files, updates) {
    const results = [];
    
    for (const file of files) {
      try {
        await this.writeMetadata(file, updates);
        results.push({ file, success: true });
      } catch (error) {
        results.push({ file, success: false, error: error.message });
      }
    }

    return results;
  }
}

module.exports = MetadataEditor;
```

#### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/files` | List directory contents |
| GET | `/api/files/details` | Get file details with metadata |
| GET | `/api/files/search` | Search files |
| DELETE | `/api/files` | Delete file or directory |
| POST | `/api/files/move` | Move/rename file |
| POST | `/api/files/mkdir` | Create directory |
| GET | `/api/files/stats` | Get storage statistics |
| GET | `/api/files/duplicates` | Find duplicate files |
| GET | `/api/files/metadata` | Get file metadata |
| PUT | `/api/files/metadata` | Update file metadata |
| GET | `/api/files/artwork` | Get file artwork |
| DELETE | `/api/files/artwork` | Remove file artwork |
| PUT | `/api/files/metadata/batch` | Batch update metadata |

### Frontend Changes

#### New Components

```
soggfy-web/frontend/src/components/
├── Files/
│   ├── FileBrowser.jsx         # Main file browser
│   ├── FileBrowser.css         # Styles
│   ├── FileList.jsx            # File listing component
│   ├── FileItem.jsx            # Individual file row
│   ├── FolderBreadcrumb.jsx    # Path breadcrumb
│   ├── FileDetails.jsx         # File details panel
│   ├── MetadataEditor.jsx      # Metadata editing modal
│   ├── StorageStats.jsx        # Storage statistics
│   └── FileContextMenu.jsx     # Right-click menu
```

#### FileBrowser.jsx Structure

```jsx
function FileBrowser() {
  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [showMetadataEditor, setShowMetadataEditor] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath]);

  const loadDirectory = async (path) => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_BASE}/files`, {
        params: { path }
      });
      setFiles(response.data.items);
    } catch (error) {
      console.error('Failed to load directory:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ${selectedFiles.length} item(s)?`)) return;
    
    for (const file of selectedFiles) {
      await axios.delete(`${API_BASE}/files`, { params: { path: file.path } });
    }
    
    setSelectedFiles([]);
    loadDirectory(currentPath);
  };

  const handleSearch = async () => {
    if (!searchQuery) {
      loadDirectory(currentPath);
      return;
    }
    
    const response = await axios.get(`${API_BASE}/files/search`, {
      params: { q: searchQuery, searchMetadata: true }
    });
    setFiles(response.data);
  };

  return (
    <div className="file-browser">
      <header>
        <FolderBreadcrumb 
          path={currentPath} 
          onNavigate={setCurrentPath} 
        />
        <div className="file-actions">
          <input
            type="search"
            placeholder="Search files..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          <button onClick={() => setShowStats(true)}>📊 Stats</button>
        </div>
      </header>

      <div className="file-browser-content">
        <FileList
          files={files}
          selectedFiles={selectedFiles}
          onSelect={setSelectedFiles}
          onNavigate={path => setCurrentPath(path)}
          onFileClick={setSelectedFile}
        />

        {selectedFile && (
          <FileDetails
            file={selectedFile}
            onClose={() => setSelectedFile(null)}
            onEditMetadata={() => setShowMetadataEditor(true)}
          />
        )}
      </div>

      {selectedFiles.length > 0 && (
        <div className="selection-actions">
          <span>{selectedFiles.length} selected</span>
          <button onClick={handleDelete}>🗑️ Delete</button>
          <button onClick={() => setShowMetadataEditor(true)}>✏️ Edit Metadata</button>
        </div>
      )}

      {showMetadataEditor && (
        <MetadataEditor
          files={selectedFiles.length > 0 ? selectedFiles : [selectedFile]}
          onClose={() => setShowMetadataEditor(false)}
          onSave={() => {
            setShowMetadataEditor(false);
            loadDirectory(currentPath);
          }}
        />
      )}

      {showStats && (
        <StorageStats onClose={() => setShowStats(false)} />
      )}
    </div>
  );
}
```

#### MetadataEditor.jsx

```jsx
function MetadataEditor({ files, onClose, onSave }) {
  const [metadata, setMetadata] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const isBatch = files.length > 1;

  useEffect(() => {
    if (!isBatch) {
      loadMetadata();
    } else {
      setLoading(false);
    }
  }, [files]);

  const loadMetadata = async () => {
    try {
      const response = await axios.get(`${API_BASE}/files/metadata`, {
        params: { path: files[0].path }
      });
      setMetadata(response.data);
    } catch (error) {
      console.error('Failed to load metadata:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isBatch) {
        await axios.put(`${API_BASE}/files/metadata/batch`, {
          files: files.map(f => f.path),
          updates: metadata
        });
      } else {
        await axios.put(`${API_BASE}/files/metadata`, {
          path: files[0].path,
          updates: metadata
        });
      }
      onSave();
    } catch (error) {
      alert('Failed to save metadata: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleArtworkUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      setMetadata({ ...metadata, artwork: reader.result });
    };
    reader.readAsDataURL(file);
  };

  if (loading) return <div className="modal-loading">Loading metadata...</div>;

  return (
    <div className="metadata-editor-overlay">
      <div className="metadata-editor-modal">
        <header>
          <h3>{isBatch ? `Edit ${files.length} files` : 'Edit Metadata'}</h3>
          <button onClick={onClose}>×</button>
        </header>

        <div className="metadata-form">
          <div className="artwork-section">
            {metadata.artwork ? (
              <img src={metadata.artwork} alt="Artwork" />
            ) : (
              <div className="no-artwork">No Artwork</div>
            )}
            <input
              type="file"
              accept="image/*"
              onChange={handleArtworkUpload}
            />
          </div>

          <div className="fields">
            <div className="field">
              <label>Title</label>
              <input
                value={metadata.title || ''}
                onChange={e => setMetadata({ ...metadata, title: e.target.value })}
                placeholder={isBatch ? 'Leave empty to keep original' : ''}
              />
            </div>

            <div className="field">
              <label>Artist</label>
              <input
                value={metadata.artist || ''}
                onChange={e => setMetadata({ ...metadata, artist: e.target.value })}
              />
            </div>

            <div className="field">
              <label>Album</label>
              <input
                value={metadata.album || ''}
                onChange={e => setMetadata({ ...metadata, album: e.target.value })}
              />
            </div>

            <div className="field-row">
              <div className="field">
                <label>Year</label>
                <input
                  type="number"
                  value={metadata.year || ''}
                  onChange={e => setMetadata({ ...metadata, year: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Track</label>
                <input
                  type="number"
                  value={metadata.track || ''}
                  onChange={e => setMetadata({ ...metadata, track: e.target.value })}
                />
              </div>
            </div>

            <div className="field">
              <label>Genre</label>
              <input
                value={metadata.genre || ''}
                onChange={e => setMetadata({ ...metadata, genre: e.target.value })}
              />
            </div>
          </div>
        </div>

        <footer>
          <button onClick={onClose}>Cancel</button>
          <button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
```

## UI Design

### File Browser

```
┌─────────────────────────────────────────────────────────────────┐
│  📁 Music / Queen / A Night at the Opera    [🔍 Search] [📊]   │
├─────────────────────────────────────────────────────────────────┤
│  ☐  Name                          Size      Modified           │
│  ──────────────────────────────────────────────────────────────  │
│  ☐  📁 ..                         -         -                  │
│  ☑  🎵 01. Death on Two Legs.mp3  8.2 MB    Jan 10, 2024       │
│  ☑  🎵 02. Lazing on a Sunday...  5.1 MB    Jan 10, 2024       │
│  ☐  🎵 03. I'm in Love with My... 4.8 MB    Jan 10, 2024       │
│  ☐  🎵 04. Sweet Lady.mp3         6.2 MB    Jan 10, 2024       │
│  ☐  🎵 05. Bohemian Rhapsody.mp3  9.5 MB    Jan 10, 2024       │
├─────────────────────────────────────────────────────────────────┤
│  2 selected                    [🗑️ Delete] [✏️ Edit Metadata]  │
└─────────────────────────────────────────────────────────────────┘
```

### Metadata Editor

```
┌─────────────────────────────────────────────────────────────────┐
│  Edit Metadata                                            [×]   │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────┐                                                    │
│  │ [album] │  Title:  [Bohemian Rhapsody                   ]   │
│  │  art    │  Artist: [Queen                               ]   │
│  │         │  Album:  [A Night at the Opera                ]   │
│  └─────────┘                                                    │
│  [Change]     Year: [1975]  Track: [11]  Genre: [Rock      ]   │
│                                                                 │
│               Composer: [Freddie Mercury                    ]   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                    [Cancel]  [Save Changes]     │
└─────────────────────────────────────────────────────────────────┘
```

### Storage Statistics

```
┌─────────────────────────────────────────────────────────────────┐
│  📊 Storage Statistics                                    [×]   │
├─────────────────────────────────────────────────────────────────┤
│  Total Files: 1,523          Total Size: 8.5 GB                 │
│                                                                 │
│  BY FORMAT                   TOP ARTISTS                        │
│  ┌────────────────────┐      ┌────────────────────────────┐     │
│  │ ████████ MP3  856  │      │ 1. Queen              125  │     │
│  │ ████     FLAC 412  │      │ 2. Led Zeppelin        98  │     │
│  │ ██       OGG  155  │      │ 3. Pink Floyd          76  │     │
│  │ █        M4A  100  │      │ 4. The Beatles         65  │     │
│  └────────────────────┘      └────────────────────────────┘     │
│                                                                 │
│  [Find Duplicates]                                              │
└─────────────────────────────────────────────────────────────────┘
```

## Security Considerations

1. **Path Traversal Prevention**: All file operations validate that paths are within the configured base directory
2. **File Type Validation**: Only audio files can have metadata edited
3. **Size Limits**: Consider adding limits for batch operations
4. **Auth Required**: All file operations should require authentication

## Testing

1. Browse folder structure
2. Search files by name and metadata
3. Delete single and multiple files
4. Move/rename files
5. View file details and metadata
6. Edit metadata (single and batch)
7. Change album artwork
8. View storage statistics
9. Find duplicate files
10. Test path traversal protection

## Future Enhancements

- Drag and drop file organization
- Audio format conversion
- Waveform visualization
- Audio preview/playback
- Automatic file organization (rename based on metadata)
- Bulk import external files
- Export to other formats
