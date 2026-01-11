import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './Settings.css';

const API_BASE = 'http://localhost:3001/api';

function Settings({ config, onClose, onConfigUpdate }) {
  const [localConfig, setLocalConfig] = useState(config || {});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!config);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (config) {
      setLocalConfig(config);
      setLoading(false);
    } else {
      fetchConfig();
    }
  }, [config]);

  const fetchConfig = async () => {
    try {
      const response = await axios.get(`${API_BASE}/config`);
      setLocalConfig(response.data);
      if (onConfigUpdate) {
        onConfigUpdate(response.data);
      }
      setLoading(false);
    } catch (err) {
      setError('Failed to load config: ' + (err.response?.data?.error || err.message));
      setLoading(false);
    }
  };

  const handleToggle = (key) => {
    setLocalConfig(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleChange = (key, value) => {
    setLocalConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleNestedChange = (parent, key, value) => {
    setLocalConfig(prev => ({
      ...prev,
      [parent]: { ...prev[parent], [key]: value }
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await axios.put(`${API_BASE}/config`, localConfig);
      if (onConfigUpdate) {
        onConfigUpdate(response.data.config);
      }
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-overlay">
        <div className="settings-modal">
          <div className="settings-header">
            <h2>Settings</h2>
            <button onClick={onClose} className="close-button">×</button>
          </div>
          <div className="settings-loading">Loading config...</div>
        </div>
      </div>
    );
  }

  if (error && !localConfig.downloaderEnabled === undefined) {
    return (
      <div className="settings-overlay">
        <div className="settings-modal">
          <div className="settings-header">
            <h2>Settings</h2>
            <button onClick={onClose} className="close-button">×</button>
          </div>
          <div className="settings-error">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Soggfy Settings</h2>
          <button onClick={onClose} className="close-button">×</button>
        </div>

        <div className="settings-content">
          {error && <div className="settings-error">{error}</div>}

          <section className="settings-section">
            <h3>General</h3>
            
            <label className="setting-item">
              <span className="setting-label">Enable Downloader</span>
              <input
                type="checkbox"
                checked={localConfig.downloaderEnabled ?? true}
                onChange={() => handleToggle('downloaderEnabled')}
              />
            </label>

            <label className="setting-item">
              <span className="setting-label">Download Podcasts</span>
              <input
                type="checkbox"
                checked={localConfig.downloadPodcasts ?? true}
                onChange={() => handleToggle('downloadPodcasts')}
              />
            </label>

            <label className="setting-item">
              <span className="setting-label">Block Ads</span>
              <input
                type="checkbox"
                checked={localConfig.blockAds ?? true}
                onChange={() => handleToggle('blockAds')}
              />
            </label>

            <label className="setting-item">
              <span className="setting-label">Skip Downloaded Tracks</span>
              <input
                type="checkbox"
                checked={localConfig.skipDownloadedTracks ?? false}
                onChange={() => handleToggle('skipDownloadedTracks')}
              />
            </label>

            <label className="setting-item">
              <span className="setting-label">Playback Speed</span>
              <select
                value={localConfig.playbackSpeed ?? 1}
                onChange={(e) => handleChange('playbackSpeed', parseFloat(e.target.value))}
              >
                <option value={1}>1x (Normal)</option>
                <option value={2}>2x</option>
                <option value={5}>5x</option>
                <option value={10}>10x</option>
                <option value={20}>20x</option>
                <option value={30}>30x (Max)</option>
              </select>
            </label>
          </section>

          <section className="settings-section">
            <h3>Metadata</h3>
            
            <label className="setting-item">
              <span className="setting-label">Embed Lyrics</span>
              <input
                type="checkbox"
                checked={localConfig.embedLyrics ?? true}
                onChange={() => handleToggle('embedLyrics')}
              />
            </label>

            <label className="setting-item">
              <span className="setting-label">Save Lyrics (.lrc)</span>
              <input
                type="checkbox"
                checked={localConfig.saveLyrics ?? true}
                onChange={() => handleToggle('saveLyrics')}
              />
            </label>

            <label className="setting-item">
              <span className="setting-label">Embed Cover Art</span>
              <input
                type="checkbox"
                checked={localConfig.embedCoverArt ?? true}
                onChange={() => handleToggle('embedCoverArt')}
              />
            </label>

            <label className="setting-item">
              <span className="setting-label">Save Cover Art</span>
              <input
                type="checkbox"
                checked={localConfig.saveCoverArt ?? true}
                onChange={() => handleToggle('saveCoverArt')}
              />
            </label>

            <label className="setting-item">
              <span className="setting-label">Save Canvas Video</span>
              <input
                type="checkbox"
                checked={localConfig.saveCanvas ?? false}
                onChange={() => handleToggle('saveCanvas')}
              />
            </label>
          </section>

          <section className="settings-section">
            <h3>Output Format</h3>
            
            <label className="setting-item vertical">
              <span className="setting-label">FFmpeg Arguments</span>
              <input
                type="text"
                value={localConfig.outputFormat?.args ?? '-c copy'}
                onChange={(e) => handleNestedChange('outputFormat', 'args', e.target.value)}
                placeholder="-c copy"
              />
              <span className="setting-hint">
                Examples: "-c copy" (OGG), "-b:a 320k" (MP3 320kbps), "-c:a flac" (FLAC)
              </span>
            </label>

            <label className="setting-item vertical">
              <span className="setting-label">File Extension</span>
              <input
                type="text"
                value={localConfig.outputFormat?.ext ?? ''}
                onChange={(e) => handleNestedChange('outputFormat', 'ext', e.target.value)}
                placeholder="ogg (leave empty for original)"
              />
              <span className="setting-hint">
                Examples: mp3, flac, ogg, m4a
              </span>
            </label>
          </section>

          <section className="settings-section">
            <h3>Save Path</h3>
            
            <label className="setting-item vertical">
              <span className="setting-label">Base Path</span>
              <input
                type="text"
                value={localConfig.savePaths?.basePath ?? ''}
                onChange={(e) => handleNestedChange('savePaths', 'basePath', e.target.value)}
                placeholder="C:\Music or leave empty for default"
              />
            </label>
          </section>
        </div>

        <div className="settings-footer">
          <button onClick={onClose} className="cancel-button">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="save-button">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Settings;
