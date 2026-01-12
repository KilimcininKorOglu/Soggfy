import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import './Statistics.css';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const API_BASE = process.env.REACT_APP_API_URL || '';

function Statistics({ onClose, sessionId }) {
  const [stats, setStats] = useState(null);
  const [chartPeriod, setChartPeriod] = useState('daily');
  const [chartData, setChartData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);

  const headers = sessionId ? { 'x-session-id': sessionId } : {};

  const fetchStats = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/api/stats`, { headers });
      setStats(response.data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    } finally {
      setLoading(false);
    }
  }, [headers]);

  const fetchChartData = useCallback(async (period) => {
    try {
      const response = await axios.get(`${API_BASE}/api/stats/chart/${period}`, { headers });
      setChartData(response.data);
    } catch (error) {
      console.error('Failed to fetch chart:', error);
    }
  }, [headers]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchChartData(chartPeriod);
  }, [chartPeriod, fetchChartData]);

  const handleExport = async (format) => {
    window.open(`${API_BASE}/api/stats/export/${format}`, '_blank');
  };

  const handleReset = async () => {
    if (!window.confirm('Are you sure you want to reset all statistics? This cannot be undone.')) {
      return;
    }
    try {
      await axios.delete(`${API_BASE}/api/stats/reset`, { headers });
      fetchStats();
      fetchChartData(chartPeriod);
    } catch (error) {
      console.error('Failed to reset stats:', error);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    try {
      const response = await axios.get(`${API_BASE}/api/stats/search`, {
        headers,
        params: { q: searchQuery, limit: 20 }
      });
      setSearchResults(response.data);
    } catch (error) {
      console.error('Search failed:', error);
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KB';
    return bytes + ' B';
  };

  const formatDuration = (ms) => {
    if (!ms) return '0m';
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const getChartOptions = () => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        titleColor: '#fff',
        bodyColor: '#fff',
        padding: 12,
        cornerRadius: 8
      }
    },
    scales: {
      x: {
        grid: { color: 'rgba(255, 255, 255, 0.1)' },
        ticks: { color: 'rgba(255, 255, 255, 0.6)' }
      },
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(255, 255, 255, 0.1)' },
        ticks: { color: 'rgba(255, 255, 255, 0.6)' }
      }
    }
  });

  const getChartConfig = () => {
    if (!chartData || chartData.length === 0) return null;

    const labels = chartData.map(d => {
      if (d.date) return d.date.slice(5);
      if (d.week) return `W${d.week.split('-')[1]}`;
      if (d.month) return d.month.slice(5);
      return '';
    });

    return {
      labels,
      datasets: [{
        label: 'Downloads',
        data: chartData.map(d => d.count),
        borderColor: '#1ed760',
        backgroundColor: 'rgba(30, 215, 96, 0.15)',
        fill: true,
        tension: 0.4,
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    };
  };

  if (loading) {
    return (
      <div className="statistics-overlay">
        <div className="statistics-modal">
          <div className="statistics-loading">Loading statistics...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="statistics-overlay" onClick={onClose}>
      <div className="statistics-modal" onClick={(e) => e.stopPropagation()}>
        <header className="statistics-header">
          <h2>Download Statistics</h2>
          <div className="header-actions">
            <button onClick={() => handleExport('json')} className="export-btn">
              Export JSON
            </button>
            <button onClick={() => handleExport('csv')} className="export-btn">
              Export CSV
            </button>
            <button onClick={onClose} className="close-btn">×</button>
          </div>
        </header>

        <div className="statistics-content">
          {/* Stats Cards */}
          <div className="stats-grid">
            <div className="stats-card">
              <div className="stats-icon">📥</div>
              <div className="stats-info">
                <div className="stats-value">{stats?.totals?.count?.toLocaleString() || 0}</div>
                <div className="stats-label">Total Downloads</div>
              </div>
            </div>
            <div className="stats-card">
              <div className="stats-icon">💾</div>
              <div className="stats-info">
                <div className="stats-value">{formatSize(stats?.totals?.size)}</div>
                <div className="stats-label">Total Size</div>
              </div>
            </div>
            <div className="stats-card">
              <div className="stats-icon">⏱️</div>
              <div className="stats-info">
                <div className="stats-value">{formatDuration(stats?.totals?.duration)}</div>
                <div className="stats-label">Total Duration</div>
              </div>
            </div>
            <div className="stats-card">
              <div className="stats-icon">✅</div>
              <div className="stats-info">
                <div className="stats-value">{stats?.totals?.successRate || 100}%</div>
                <div className="stats-label">Success Rate</div>
              </div>
            </div>
          </div>

          {/* Period Summary */}
          <div className="period-stats">
            <div className="period-card">
              <h4>Today</h4>
              <span className="period-value">{stats?.today?.count || 0}</span>
              <span className="period-label">tracks</span>
            </div>
            <div className="period-card">
              <h4>This Week</h4>
              <span className="period-value">{stats?.thisWeek?.count || 0}</span>
              <span className="period-label">tracks</span>
            </div>
            <div className="period-card">
              <h4>This Month</h4>
              <span className="period-value">{stats?.thisMonth?.count || 0}</span>
              <span className="period-label">tracks</span>
            </div>
          </div>

          {/* Chart Section */}
          <div className="chart-section">
            <div className="chart-header">
              <h3>Downloads Over Time</h3>
              <div className="period-selector">
                <button
                  className={chartPeriod === 'daily' ? 'active' : ''}
                  onClick={() => setChartPeriod('daily')}
                >
                  Daily
                </button>
                <button
                  className={chartPeriod === 'weekly' ? 'active' : ''}
                  onClick={() => setChartPeriod('weekly')}
                >
                  Weekly
                </button>
                <button
                  className={chartPeriod === 'monthly' ? 'active' : ''}
                  onClick={() => setChartPeriod('monthly')}
                >
                  Monthly
                </button>
              </div>
            </div>
            <div className="chart-container">
              {getChartConfig() ? (
                <Line data={getChartConfig()} options={getChartOptions()} />
              ) : (
                <div className="chart-empty">No data available</div>
              )}
            </div>
          </div>

          {/* Top Lists */}
          <div className="lists-section">
            <div className="top-list">
              <h3>🎤 Top Artists</h3>
              {stats?.topArtists?.length > 0 ? (
                <ul>
                  {stats.topArtists.map((item, index) => (
                    <li key={item.artist}>
                      <span className="rank">{index + 1}</span>
                      <span className="name">{item.artist}</span>
                      <span className="count">{item.count}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="list-empty">No data yet</div>
              )}
            </div>
            <div className="top-list">
              <h3>💿 Top Albums</h3>
              {stats?.topAlbums?.length > 0 ? (
                <ul>
                  {stats.topAlbums.map((item, index) => (
                    <li key={`${item.album}-${item.artist}`}>
                      <span className="rank">{index + 1}</span>
                      <span className="name">{item.album}</span>
                      <span className="count">{item.count}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="list-empty">No data yet</div>
              )}
            </div>
          </div>

          {/* Search */}
          <div className="search-section">
            <h3>Search Downloads</h3>
            <form onSubmit={handleSearch} className="search-form">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by track, artist, or album..."
              />
              <button type="submit">Search</button>
            </form>
            {searchResults && (
              <div className="search-results">
                {searchResults.length > 0 ? (
                  <ul>
                    {searchResults.map((item) => (
                      <li key={`${item.track_id}-${item.timestamp}`}>
                        <span className="result-name">{item.name}</span>
                        <span className="result-artist">{item.artist}</span>
                        <span className="result-date">{formatDate(item.timestamp)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="no-results">No results found</div>
                )}
              </div>
            )}
          </div>

          {/* Recent Downloads */}
          <div className="recent-section">
            <h3>Recent Downloads</h3>
            {stats?.recentDownloads?.length > 0 ? (
              <table className="recent-table">
                <thead>
                  <tr>
                    <th>Track</th>
                    <th>Artist</th>
                    <th>Album</th>
                    <th>Status</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recentDownloads.map((item) => (
                    <tr key={`${item.id}-${item.timestamp}`}>
                      <td>{item.name}</td>
                      <td>{item.artist}</td>
                      <td>{item.album || '-'}</td>
                      <td>
                        <span className={`status-badge status-${item.status}`}>
                          {item.status}
                        </span>
                      </td>
                      <td>{formatDate(item.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="list-empty">No recent downloads</div>
            )}
          </div>

          {/* Footer */}
          <footer className="statistics-footer">
            <button onClick={handleReset} className="reset-btn">
              Reset All Statistics
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

export default Statistics;
