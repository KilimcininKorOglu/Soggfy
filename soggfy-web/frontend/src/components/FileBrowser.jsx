import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './FileBrowser.css';

const API_BASE = 'http://localhost:3001/api';

function FileBrowser({ onClose, sessionId }) {
  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState([]);
  const [parentPath, setParentPath] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [showMetadataEditor, setShowMetadataEditor] = useState(false);
  const [showStorageStats, setShowStorageStats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [basePath, setBasePath] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState('asc');

  const headers = sessionId ? { 'X-Session-ID': sessionId } : {};

  const loadDirectory = useCallback(async (path = '') => {
    setLoading(true);
    setError(null);
    setSearchResults(null);
    try {
      const response = await axios.get(`${API_BASE}/files`, {
        headers,
        params: { path }
      });
      setFiles(response.data.items || []);
      setParentPath(response.data.parentPath);
      setCurrentPath(path);
      setSelectedFiles(new Set());
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchBasePath = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/files/basepath`, { headers });
      setBasePath(response.data.basePath);
    } catch (err) {
      // Ignore
    }
  }, []);

  useEffect(() => {
    loadDirectory('');
    fetchBasePath();
  }, [loadDirectory, fetchBasePath]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      loadDirectory(currentPath);
      return;
    }

    setLoading(true);
    try {
      const response = await axios.get(`${API_BASE}/files/search`, {
        headers,
        params: { q: searchQuery, searchMetadata: 'true', limit: 100 }
      });
      setSearchResults(response.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (selectedFiles.size === 0) return;
    if (!window.confirm(`Delete ${selectedFiles.size} item(s)?`)) return;

    setLoading(true);
    try {
      for (const filePath of selectedFiles) {
        await axios.delete(`${API_BASE}/files`, {
          headers,
          params: { path: filePath }
        });
      }
      setSelectedFiles(new Set());
      loadDirectory(currentPath);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setLoading(false);
    }
  };

  const handleRename = async () => {
    if (selectedFiles.size !== 1) return;
    const filePath = Array.from(selectedFiles)[0];
    const file = files.find(f => f.path === filePath);
    if (!file) return;

    const newName = window.prompt('Enter new name:', file.name);
    if (!newName || newName === file.name) return;

    const parentDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;

    try {
      await axios.post(`${API_BASE}/files/move`, { from: filePath, to: newPath }, { headers });
      loadDirectory(currentPath);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleCreateFolder = async () => {
    const name = window.prompt('Enter folder name:');
    if (!name) return;

    const newPath = currentPath ? `${currentPath}/${name}` : name;
    try {
      await axios.post(`${API_BASE}/files/mkdir`, { path: newPath }, { headers });
      loadDirectory(currentPath);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const toggleSelect = (filePath) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(filePath)) {
      newSelected.delete(filePath);
    } else {
      newSelected.add(filePath);
    }
    setSelectedFiles(newSelected);
  };

  const selectAll = () => {
    if (selectedFiles.size === files.filter(f => !f.isDirectory).length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(files.filter(f => !f.isDirectory).map(f => f.path)));
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return `${bytes.toFixed(1)} ${units[i]}`;
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '-';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString();
  };

  const sortFiles = (fileList) => {
    return [...fileList].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      let comparison = 0;
      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'size':
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case 'modified':
          comparison = new Date(a.modified) - new Date(b.modified);
          break;
        default:
          comparison = a.name.localeCompare(b.name);
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });
  };

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  const displayFiles = searchResults || sortFiles(files);
  const pathParts = currentPath ? currentPath.split('/') : [];

  return (
    <div className="file-browser-overlay" onClick={onClose}>
      <div className="file-browser-modal" onClick={e => e.stopPropagation()}>
        <div className="file-browser-header">
          <h2>File Browser</h2>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>

        <div className="file-browser-toolbar">
          <div className="breadcrumb">
            <button onClick={() => loadDirectory('')} className="breadcrumb-item">
              Home
            </button>
            {pathParts.map((part, index) => (
              <React.Fragment key={index}>
                <span className="breadcrumb-separator">/</span>
                <button
                  onClick={() => loadDirectory(pathParts.slice(0, index + 1).join('/'))}
                  className="breadcrumb-item"
                >
                  {part}
                </button>
              </React.Fragment>
            ))}
          </div>
          <div className="toolbar-actions">
            <div className="search-box">
              <input
                type="search"
                placeholder="Search files..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
              />
              <button onClick={handleSearch}>Search</button>
            </div>
            <button onClick={() => setShowStorageStats(true)} className="stats-btn">
              Stats
            </button>
          </div>
        </div>

        {error && (
          <div className="error-banner">
            {error}
            <button onClick={() => setError(null)}>x</button>
          </div>
        )}

        <div className="file-browser-content">
          {loading ? (
            <div className="loading">Loading...</div>
          ) : (
            <>
              <div className="file-list-header">
                <div className="col-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedFiles.size > 0 && selectedFiles.size === files.filter(f => !f.isDirectory).length}
                    onChange={selectAll}
                  />
                </div>
                <div className="col-name" onClick={() => handleSort('name')}>
                  Name {sortBy === 'name' && (sortOrder === 'asc' ? '▲' : '▼')}
                </div>
                <div className="col-size" onClick={() => handleSort('size')}>
                  Size {sortBy === 'size' && (sortOrder === 'asc' ? '▲' : '▼')}
                </div>
                <div className="col-duration">Duration</div>
                <div className="col-modified" onClick={() => handleSort('modified')}>
                  Modified {sortBy === 'modified' && (sortOrder === 'asc' ? '▲' : '▼')}
                </div>
              </div>

              <div className="file-list">
                {parentPath !== null && !searchResults && (
                  <div className="file-item directory" onClick={() => loadDirectory(parentPath)}>
                    <div className="col-checkbox"></div>
                    <div className="col-name">
                      <span className="file-icon">📁</span>
                      ..
                    </div>
                    <div className="col-size">-</div>
                    <div className="col-duration">-</div>
                    <div className="col-modified">-</div>
                  </div>
                )}

                {displayFiles.length === 0 && (
                  <div className="empty-message">
                    {searchResults ? 'No files found' : 'This folder is empty'}
                  </div>
                )}

                {displayFiles.map(file => (
                  <div
                    key={file.path}
                    className={`file-item ${file.isDirectory ? 'directory' : 'file'} ${selectedFiles.has(file.path) ? 'selected' : ''}`}
                    onClick={() => {
                      if (file.isDirectory) {
                        loadDirectory(file.path);
                      } else {
                        setSelectedFile(file);
                      }
                    }}
                  >
                    <div className="col-checkbox" onClick={e => e.stopPropagation()}>
                      {!file.isDirectory && (
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.path)}
                          onChange={() => toggleSelect(file.path)}
                        />
                      )}
                    </div>
                    <div className="col-name">
                      <span className="file-icon">{file.isDirectory ? '📁' : '🎵'}</span>
                      <span className="file-name">{file.name}</span>
                      {file.metadata?.artist && (
                        <span className="file-artist">- {file.metadata.artist}</span>
                      )}
                    </div>
                    <div className="col-size">{formatSize(file.size)}</div>
                    <div className="col-duration">{formatDuration(file.metadata?.duration)}</div>
                    <div className="col-modified">{formatDate(file.modified)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {selectedFiles.size > 0 && (
          <div className="selection-bar">
            <span>{selectedFiles.size} selected</span>
            <div className="selection-actions">
              <button onClick={handleDelete} className="delete-btn">Delete</button>
              {selectedFiles.size === 1 && (
                <button onClick={handleRename}>Rename</button>
              )}
              <button onClick={() => setShowMetadataEditor(true)}>Edit Metadata</button>
            </div>
          </div>
        )}

        <div className="file-browser-footer">
          <button onClick={handleCreateFolder}>New Folder</button>
          <button onClick={() => loadDirectory(currentPath)}>Refresh</button>
          {basePath && <span className="base-path">Base: {basePath}</span>}
        </div>

        {selectedFile && !showMetadataEditor && (
          <FileDetails
            file={selectedFile}
            sessionId={sessionId}
            onClose={() => setSelectedFile(null)}
            onEditMetadata={() => {
              setSelectedFiles(new Set([selectedFile.path]));
              setShowMetadataEditor(true);
            }}
          />
        )}

        {showMetadataEditor && (
          <MetadataEditorModal
            files={Array.from(selectedFiles)}
            sessionId={sessionId}
            onClose={() => {
              setShowMetadataEditor(false);
              setSelectedFile(null);
            }}
            onSave={() => {
              setShowMetadataEditor(false);
              setSelectedFile(null);
              loadDirectory(currentPath);
            }}
          />
        )}

        {showStorageStats && (
          <StorageStatsModal
            sessionId={sessionId}
            onClose={() => setShowStorageStats(false)}
          />
        )}
      </div>
    </div>
  );
}

function FileDetails({ file, sessionId, onClose, onEditMetadata }) {
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const headers = sessionId ? { 'X-Session-ID': sessionId } : {};

  useEffect(() => {
    const fetchDetails = async () => {
      try {
        const response = await axios.get(`${API_BASE}/files/details`, {
          headers,
          params: { path: file.path }
        });
        setDetails(response.data);
      } catch (err) {
        console.error('Failed to load file details:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchDetails();
  }, [file.path]);

  const formatSize = (bytes) => {
    if (!bytes) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return `${bytes.toFixed(2)} ${units[i]}`;
  };

  const formatDuration = (seconds) => {
    if (!seconds) return '-';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="file-details-panel">
      <div className="panel-header">
        <h3>File Details</h3>
        <button onClick={onClose}>x</button>
      </div>
      {loading ? (
        <div className="loading">Loading...</div>
      ) : details ? (
        <div className="panel-content">
          {details.artwork && (
            <div className="artwork">
              <img src={`data:${details.artwork.format};base64,${details.artwork.data}`} alt="Artwork" />
            </div>
          )}
          <div className="detail-row">
            <span className="label">Name:</span>
            <span className="value">{details.name}</span>
          </div>
          {details.metadata?.title && (
            <div className="detail-row">
              <span className="label">Title:</span>
              <span className="value">{details.metadata.title}</span>
            </div>
          )}
          {details.metadata?.artist && (
            <div className="detail-row">
              <span className="label">Artist:</span>
              <span className="value">{details.metadata.artist}</span>
            </div>
          )}
          {details.metadata?.album && (
            <div className="detail-row">
              <span className="label">Album:</span>
              <span className="value">{details.metadata.album}</span>
            </div>
          )}
          {details.metadata?.year && (
            <div className="detail-row">
              <span className="label">Year:</span>
              <span className="value">{details.metadata.year}</span>
            </div>
          )}
          {details.metadata?.genre && (
            <div className="detail-row">
              <span className="label">Genre:</span>
              <span className="value">{details.metadata.genre}</span>
            </div>
          )}
          <div className="detail-row">
            <span className="label">Duration:</span>
            <span className="value">{formatDuration(details.metadata?.duration)}</span>
          </div>
          <div className="detail-row">
            <span className="label">Size:</span>
            <span className="value">{formatSize(details.size)}</span>
          </div>
          {details.metadata?.bitrate && (
            <div className="detail-row">
              <span className="label">Bitrate:</span>
              <span className="value">{Math.round(details.metadata.bitrate / 1000)} kbps</span>
            </div>
          )}
          {details.metadata?.format && (
            <div className="detail-row">
              <span className="label">Format:</span>
              <span className="value">{details.metadata.format}</span>
            </div>
          )}
          <button onClick={onEditMetadata} className="edit-metadata-btn">
            Edit Metadata
          </button>
        </div>
      ) : (
        <div className="error">Failed to load details</div>
      )}
    </div>
  );
}

function MetadataEditorModal({ files, sessionId, onClose, onSave }) {
  const [metadata, setMetadata] = useState({
    title: '',
    artist: '',
    album: '',
    albumArtist: '',
    year: '',
    track: '',
    genre: '',
    composer: '',
    comment: ''
  });
  const [artwork, setArtwork] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const isBatch = files.length > 1;
  const headers = sessionId ? { 'X-Session-ID': sessionId } : {};

  useEffect(() => {
    const fetchMetadata = async () => {
      if (isBatch) {
        setLoading(false);
        return;
      }

      try {
        const response = await axios.get(`${API_BASE}/files/metadata`, {
          headers,
          params: { path: files[0] }
        });
        setMetadata({
          title: response.data.title || '',
          artist: response.data.artist || '',
          album: response.data.album || '',
          albumArtist: response.data.albumArtist || '',
          year: response.data.year || '',
          track: response.data.track || '',
          genre: response.data.genre || '',
          composer: response.data.composer || '',
          comment: response.data.comment || ''
        });

        if (response.data.hasArtwork) {
          const artworkRes = await axios.get(`${API_BASE}/files/artwork`, {
            headers,
            params: { path: files[0] }
          });
          setArtwork(artworkRes.data.data);
        }
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchMetadata();
  }, [files, isBatch]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      const updates = {};
      for (const [key, value] of Object.entries(metadata)) {
        if (value !== '' && value !== null) {
          updates[key] = value;
        }
      }
      if (artwork && artwork.startsWith('data:')) {
        updates.artwork = artwork;
      }

      if (isBatch) {
        await axios.put(`${API_BASE}/files/metadata/batch`, { files, updates }, { headers });
      } else {
        await axios.put(`${API_BASE}/files/metadata`, { path: files[0], updates }, { headers });
      }

      onSave();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleArtworkUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      setArtwork(reader.result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="metadata-editor-overlay" onClick={onClose}>
      <div className="metadata-editor-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{isBatch ? `Edit ${files.length} files` : 'Edit Metadata'}</h3>
          <button onClick={onClose}>x</button>
        </div>

        {loading ? (
          <div className="loading">Loading...</div>
        ) : (
          <div className="modal-content">
            {error && <div className="error-message">{error}</div>}

            <div className="metadata-form">
              <div className="artwork-section">
                {artwork ? (
                  <img src={artwork} alt="Artwork" className="artwork-preview" />
                ) : (
                  <div className="no-artwork">No Artwork</div>
                )}
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleArtworkUpload}
                  id="artwork-upload"
                />
                <label htmlFor="artwork-upload" className="upload-btn">
                  Change Artwork
                </label>
              </div>

              <div className="fields-section">
                <div className="form-row">
                  <label>Title</label>
                  <input
                    type="text"
                    value={metadata.title}
                    onChange={e => setMetadata({ ...metadata, title: e.target.value })}
                    placeholder={isBatch ? 'Leave empty to keep original' : ''}
                  />
                </div>
                <div className="form-row">
                  <label>Artist</label>
                  <input
                    type="text"
                    value={metadata.artist}
                    onChange={e => setMetadata({ ...metadata, artist: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>Album</label>
                  <input
                    type="text"
                    value={metadata.album}
                    onChange={e => setMetadata({ ...metadata, album: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>Album Artist</label>
                  <input
                    type="text"
                    value={metadata.albumArtist}
                    onChange={e => setMetadata({ ...metadata, albumArtist: e.target.value })}
                  />
                </div>
                <div className="form-row-inline">
                  <div className="form-row">
                    <label>Year</label>
                    <input
                      type="number"
                      value={metadata.year}
                      onChange={e => setMetadata({ ...metadata, year: e.target.value })}
                    />
                  </div>
                  <div className="form-row">
                    <label>Track</label>
                    <input
                      type="number"
                      value={metadata.track}
                      onChange={e => setMetadata({ ...metadata, track: e.target.value })}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label>Genre</label>
                  <input
                    type="text"
                    value={metadata.genre}
                    onChange={e => setMetadata({ ...metadata, genre: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>Composer</label>
                  <input
                    type="text"
                    value={metadata.composer}
                    onChange={e => setMetadata({ ...metadata, composer: e.target.value })}
                  />
                </div>
              </div>
            </div>

            {isBatch && (
              <div className="batch-notice">
                Only filled fields will be updated. Empty fields will keep their original values.
              </div>
            )}
          </div>
        )}

        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button onClick={handleSave} disabled={saving || loading} className="save-btn">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StorageStatsModal({ sessionId, onClose }) {
  const [stats, setStats] = useState(null);
  const [duplicates, setDuplicates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const headers = sessionId ? { 'X-Session-ID': sessionId } : {};

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await axios.get(`${API_BASE}/files/stats`, { headers });
        setStats(response.data);
      } catch (err) {
        console.error('Failed to load stats:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, []);

  const handleFindDuplicates = async () => {
    setShowDuplicates(true);
    try {
      const response = await axios.get(`${API_BASE}/files/duplicates`, { headers });
      setDuplicates(response.data);
    } catch (err) {
      console.error('Failed to find duplicates:', err);
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return `${bytes.toFixed(2)} ${units[i]}`;
  };

  return (
    <div className="storage-stats-overlay" onClick={onClose}>
      <div className="storage-stats-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Storage Statistics</h3>
          <button onClick={onClose}>x</button>
        </div>

        {loading ? (
          <div className="loading">Scanning files...</div>
        ) : stats ? (
          <div className="modal-content">
            <div className="stats-summary">
              <div className="stat-box">
                <span className="stat-value">{stats.totalFiles}</span>
                <span className="stat-label">Total Files</span>
              </div>
              <div className="stat-box">
                <span className="stat-value">{formatSize(stats.totalSize)}</span>
                <span className="stat-label">Total Size</span>
              </div>
            </div>

            <div className="stats-sections">
              <div className="stats-section">
                <h4>By Format</h4>
                <div className="format-list">
                  {stats.formatDistribution?.map(item => (
                    <div key={item.format} className="format-item">
                      <span className="format-name">.{item.format}</span>
                      <span className="format-count">{item.count}</span>
                      <div className="format-bar">
                        <div
                          className="format-bar-fill"
                          style={{ width: `${(item.count / stats.totalFiles) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="stats-section">
                <h4>Top Artists</h4>
                <div className="artist-list">
                  {stats.topArtists?.slice(0, 10).map((item, index) => (
                    <div key={item.artist} className="artist-item">
                      <span className="artist-rank">{index + 1}</span>
                      <span className="artist-name">{item.artist}</span>
                      <span className="artist-count">{item.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="duplicates-section">
              {!showDuplicates ? (
                <button onClick={handleFindDuplicates} className="find-duplicates-btn">
                  Find Duplicates
                </button>
              ) : duplicates === null ? (
                <div className="loading">Scanning for duplicates...</div>
              ) : duplicates.length === 0 ? (
                <div className="no-duplicates">No duplicates found</div>
              ) : (
                <>
                  <h4>Duplicates Found ({duplicates.length})</h4>
                  <div className="duplicates-list">
                    {duplicates.map((dup, index) => (
                      <div key={index} className="duplicate-item">
                        <div className="duplicate-info">
                          <strong>{dup.title || 'Unknown'}</strong> - {dup.artist || 'Unknown'}
                        </div>
                        <div className="duplicate-paths">
                          <div>Original: {dup.original}</div>
                          <div>Duplicate: {dup.duplicate}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="error">Failed to load statistics</div>
        )}

        <div className="modal-footer">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default FileBrowser;
