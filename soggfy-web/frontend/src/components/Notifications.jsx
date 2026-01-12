import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import notificationService from '../services/NotificationService';
import './Notifications.css';

const API_BASE = 'http://localhost:3001/api';

function Notifications({ onClose, sessionId }) {
  const [settings, setSettings] = useState(null);
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState({});
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [testResults, setTestResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('settings');
  const [historyFilter, setHistoryFilter] = useState({ type: '', channel: '' });

  const headers = sessionId ? { 'X-Session-ID': sessionId } : {};

  const fetchSettings = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/notifications/settings`, { headers });
      setSettings(response.data);
    } catch (error) {
      console.error('Failed to fetch settings:', error);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/notifications/stats`, { headers });
      setStats(response.data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const params = { limit: 50 };
      if (historyFilter.type) params.type = historyFilter.type;
      if (historyFilter.channel) params.channel = historyFilter.channel;
      
      const response = await axios.get(`${API_BASE}/notifications/history`, { headers, params });
      setHistory(response.data);
    } catch (error) {
      console.error('Failed to fetch history:', error);
    }
  }, [historyFilter]);

  const checkPushStatus = useCallback(async () => {
    const supported = await notificationService.init();
    setPushSupported(supported);
    if (supported) {
      const subscribed = await notificationService.isSubscribed();
      setPushEnabled(subscribed);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      await Promise.all([fetchSettings(), fetchStats(), checkPushStatus()]);
      setLoading(false);
    };
    init();
  }, [fetchSettings, fetchStats, checkPushStatus]);

  useEffect(() => {
    if (activeTab === 'history') {
      fetchHistory();
    }
  }, [activeTab, fetchHistory]);

  const handleEnablePush = async () => {
    const granted = await notificationService.requestPermission();
    if (granted) {
      await notificationService.subscribe(sessionId);
      setPushEnabled(true);
    } else {
      alert('Notification permission denied');
    }
  };

  const handleDisablePush = async () => {
    await notificationService.unsubscribe(sessionId);
    setPushEnabled(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await axios.put(`${API_BASE}/notifications/settings`, settings, { headers });
      alert('Settings saved');
    } catch (error) {
      alert('Failed to save settings: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (channel = 'all') => {
    setTestResults(null);
    try {
      const response = await axios.post(`${API_BASE}/notifications/test`, { channel }, { headers });
      setTestResults(response.data);
    } catch (error) {
      setTestResults({ error: error.message });
    }
  };

  const handleClearHistory = async () => {
    if (!window.confirm('Clear all notification history?')) return;
    try {
      await axios.delete(`${API_BASE}/notifications/history`, { headers });
      setHistory([]);
      fetchStats();
    } catch (error) {
      alert('Failed to clear history');
    }
  };

  const updateSetting = (path, value) => {
    const newSettings = JSON.parse(JSON.stringify(settings));
    const parts = path.split('.');
    let current = newSettings;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    setSettings(newSettings);
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'sent': return 'check-circle';
      case 'failed': return 'x-circle';
      case 'skipped': return 'skip-forward';
      default: return 'help-circle';
    }
  };

  const getChannelIcon = (channel) => {
    switch (channel) {
      case 'browser': return 'globe';
      case 'discord': return 'message-square';
      case 'telegram': return 'send';
      default: return 'bell';
    }
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  if (loading) {
    return (
      <div className="notifications-overlay">
        <div className="notifications-modal">
          <div className="loading">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="notifications-overlay" onClick={onClose}>
      <div className="notifications-modal" onClick={e => e.stopPropagation()}>
        <div className="notifications-header">
          <h2>Notifications</h2>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>

        <div className="notifications-tabs">
          <button 
            className={activeTab === 'settings' ? 'active' : ''} 
            onClick={() => setActiveTab('settings')}
          >
            Settings
          </button>
          <button 
            className={activeTab === 'history' ? 'active' : ''} 
            onClick={() => setActiveTab('history')}
          >
            History
          </button>
        </div>

        <div className="notifications-content">
          {activeTab === 'settings' && settings && (
            <div className="settings-tab">
              {/* Statistics */}
              <section className="section">
                <h3>Statistics</h3>
                <div className="stats-grid">
                  {Object.entries(stats).map(([channel, data]) => (
                    <div key={channel} className="stat-card">
                      <h4>{channel}</h4>
                      <div className="stat-row">
                        <span>Sent:</span>
                        <span className="success">{data.sent}</span>
                      </div>
                      <div className="stat-row">
                        <span>Failed:</span>
                        <span className="error">{data.failed}</span>
                      </div>
                      <div className="stat-row">
                        <span>Success Rate:</span>
                        <span>{data.successRate}%</span>
                      </div>
                    </div>
                  ))}
                  {Object.keys(stats).length === 0 && (
                    <div className="empty-stats">No notifications sent yet</div>
                  )}
                </div>
              </section>

              {/* Browser Push */}
              <section className="section">
                <h3>Browser Push Notifications</h3>
                {!pushSupported ? (
                  <div className="warning">Push notifications not supported in this browser</div>
                ) : (
                  <>
                    <div className="push-toggle">
                      {!pushEnabled ? (
                        <button onClick={handleEnablePush} className="enable-btn">
                          Enable Push Notifications
                        </button>
                      ) : (
                        <button onClick={handleDisablePush} className="disable-btn">
                          Disable Push Notifications
                        </button>
                      )}
                    </div>
                    <div className="checkbox-group">
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.browser?.onComplete || false}
                          onChange={e => updateSetting('browser.onComplete', e.target.checked)}
                        />
                        Notify on download complete
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.browser?.onError || false}
                          onChange={e => updateSetting('browser.onError', e.target.checked)}
                        />
                        Notify on download error
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.browser?.onQueueComplete || false}
                          onChange={e => updateSetting('browser.onQueueComplete', e.target.checked)}
                        />
                        Notify when queue completes
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.browser?.sound || false}
                          onChange={e => updateSetting('browser.sound', e.target.checked)}
                        />
                        Play sound
                      </label>
                    </div>
                  </>
                )}
              </section>

              {/* Discord */}
              <section className="section">
                <h3>Discord Webhook</h3>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={settings.discord?.enabled || false}
                    onChange={e => updateSetting('discord.enabled', e.target.checked)}
                  />
                  Enable Discord notifications
                </label>
                {settings.discord?.enabled && (
                  <div className="webhook-config">
                    <div className="form-group">
                      <label>Webhook URL</label>
                      <input
                        type="url"
                        placeholder="https://discord.com/api/webhooks/..."
                        value={settings.discord?.webhookUrl || ''}
                        onChange={e => updateSetting('discord.webhookUrl', e.target.value)}
                      />
                    </div>
                    <div className="checkbox-group">
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.discord?.onComplete || false}
                          onChange={e => updateSetting('discord.onComplete', e.target.checked)}
                        />
                        Notify on download complete
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.discord?.onError || false}
                          onChange={e => updateSetting('discord.onError', e.target.checked)}
                        />
                        Notify on download error
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.discord?.batchMode || false}
                          onChange={e => updateSetting('discord.batchMode', e.target.checked)}
                        />
                        Batch notifications (combine multiple downloads)
                      </label>
                    </div>
                    {settings.discord?.batchMode && (
                      <div className="form-group">
                        <label>Batch Interval (ms)</label>
                        <input
                          type="number"
                          value={settings.discord?.batchInterval || 60000}
                          onChange={e => updateSetting('discord.batchInterval', parseInt(e.target.value))}
                          min="10000"
                          step="1000"
                        />
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Telegram */}
              <section className="section">
                <h3>Telegram Bot</h3>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={settings.telegram?.enabled || false}
                    onChange={e => updateSetting('telegram.enabled', e.target.checked)}
                  />
                  Enable Telegram notifications
                </label>
                {settings.telegram?.enabled && (
                  <div className="webhook-config">
                    <div className="form-group">
                      <label>Bot Token</label>
                      <input
                        type="password"
                        placeholder="123456:ABC-DEF..."
                        value={settings.telegram?.botToken || ''}
                        onChange={e => updateSetting('telegram.botToken', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>Chat ID</label>
                      <input
                        type="text"
                        placeholder="-1001234567890"
                        value={settings.telegram?.chatId || ''}
                        onChange={e => updateSetting('telegram.chatId', e.target.value)}
                      />
                    </div>
                    <div className="checkbox-group">
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.telegram?.onComplete || false}
                          onChange={e => updateSetting('telegram.onComplete', e.target.checked)}
                        />
                        Notify on download complete
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={settings.telegram?.onError || false}
                          onChange={e => updateSetting('telegram.onError', e.target.checked)}
                        />
                        Notify on download error
                      </label>
                    </div>
                  </div>
                )}
              </section>

              {/* Quiet Hours */}
              <section className="section">
                <h3>Quiet Hours</h3>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={settings.quietHours?.enabled || false}
                    onChange={e => updateSetting('quietHours.enabled', e.target.checked)}
                  />
                  Enable quiet hours (no notifications)
                </label>
                {settings.quietHours?.enabled && (
                  <div className="time-range">
                    <input
                      type="time"
                      value={settings.quietHours?.start || '22:00'}
                      onChange={e => updateSetting('quietHours.start', e.target.value)}
                    />
                    <span>to</span>
                    <input
                      type="time"
                      value={settings.quietHours?.end || '08:00'}
                      onChange={e => updateSetting('quietHours.end', e.target.value)}
                    />
                  </div>
                )}
              </section>

              {/* Actions */}
              <div className="actions">
                <button onClick={handleSave} className="save-btn" disabled={saving}>
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
                <div className="test-buttons">
                  <button onClick={() => handleTest('all')} className="test-btn">Test All</button>
                  <button onClick={() => handleTest('browser')} className="test-btn">Test Browser</button>
                  <button onClick={() => handleTest('discord')} className="test-btn">Test Discord</button>
                  <button onClick={() => handleTest('telegram')} className="test-btn">Test Telegram</button>
                </div>
              </div>

              {testResults && (
                <div className="test-results">
                  <h4>Test Results</h4>
                  <pre>{JSON.stringify(testResults, null, 2)}</pre>
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="history-tab">
              <div className="history-header">
                <div className="filters">
                  <select
                    value={historyFilter.channel}
                    onChange={e => setHistoryFilter({ ...historyFilter, channel: e.target.value })}
                  >
                    <option value="">All Channels</option>
                    <option value="browser">Browser</option>
                    <option value="discord">Discord</option>
                    <option value="telegram">Telegram</option>
                  </select>
                  <select
                    value={historyFilter.type}
                    onChange={e => setHistoryFilter({ ...historyFilter, type: e.target.value })}
                  >
                    <option value="">All Types</option>
                    <option value="download_complete">Download Complete</option>
                    <option value="download_error">Download Error</option>
                    <option value="queue_complete">Queue Complete</option>
                    <option value="scheduled_task">Scheduled Task</option>
                    <option value="test">Test</option>
                  </select>
                </div>
                <button onClick={handleClearHistory} className="clear-btn">Clear All</button>
              </div>

              <div className="history-list">
                {history.length === 0 ? (
                  <div className="empty">No notifications yet</div>
                ) : (
                  history.map(item => (
                    <div key={item.id} className={`history-item status-${item.status}`}>
                      <div className="item-icons">
                        <span className={`status-icon ${item.status}`} title={item.status}>
                          [{getStatusIcon(item.status)}]
                        </span>
                        <span className="channel-icon" title={item.channel}>
                          [{getChannelIcon(item.channel)}]
                        </span>
                      </div>
                      <div className="item-content">
                        <div className="item-title">{item.title}</div>
                        {item.body && <div className="item-body">{item.body}</div>}
                        {item.error && <div className="item-error">{item.error}</div>}
                      </div>
                      <div className="item-time">{formatTime(item.sentAt)}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Notifications;
