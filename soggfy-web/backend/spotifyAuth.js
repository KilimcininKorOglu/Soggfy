const axios = require('axios');

class SpotifyAPI {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = null;
    this.userAccessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = null;
  }

  // Client Credentials Flow (for metadata)
  async getAccessToken() {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            this.clientId + ':' + this.clientSecret
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    this.accessToken = response.data.access_token;
    return this.accessToken;
  }

  // User Authorization (for playback control)
  getAuthUrl(redirectUri) {
    const scopes = 'user-modify-playback-state user-read-playback-state';
    return `https://accounts.spotify.com/authorize?` +
      `response_type=code&` +
      `client_id=${this.clientId}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async exchangeCode(code, redirectUri) {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      }),
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            this.clientId + ':' + this.clientSecret
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    this.userAccessToken = response.data.access_token;
    this.refreshToken = response.data.refresh_token;
    this.tokenExpiresAt = Date.now() + (response.data.expires_in - 300) * 1000;
    return response.data;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken
      }),
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            this.clientId + ':' + this.clientSecret
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    this.userAccessToken = response.data.access_token;
    if (response.data.refresh_token) {
      this.refreshToken = response.data.refresh_token;
    }
    this.tokenExpiresAt = Date.now() + (response.data.expires_in - 300) * 1000;
    console.log('Access token refreshed');
    return response.data;
  }

  async ensureValidToken() {
    if (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt) {
      await this.refreshAccessToken();
    }
  }

  async getTrackInfo(trackId) {
    if (!this.accessToken) await this.getAccessToken();

    const response = await axios.get(
      `https://api.spotify.com/v1/tracks/${trackId}`,
      {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      }
    );

    return {
      id: response.data.id,
      name: response.data.name,
      artist: response.data.artists[0].name,
      album: response.data.album.name,
      duration: response.data.duration_ms,
      uri: response.data.uri,
      albumArt: response.data.album.images[0]?.url
    };
  }

  async getDevices() {
    await this.ensureValidToken();
    const response = await axios.get(
      'https://api.spotify.com/v1/me/player/devices',
      {
        headers: { 'Authorization': `Bearer ${this.userAccessToken}` }
      }
    );
    return response.data.devices;
  }

  async playTrack(trackUri, deviceId = null) {
    await this.ensureValidToken();
    const url = deviceId
      ? `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`
      : 'https://api.spotify.com/v1/me/player/play';

    await axios.put(
      url,
      { uris: [trackUri] },
      {
        headers: {
          'Authorization': `Bearer ${this.userAccessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  }

  async getAlbumTracks(albumId) {
    if (!this.accessToken) await this.getAccessToken();

    const response = await axios.get(
      `https://api.spotify.com/v1/albums/${albumId}`,
      {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      }
    );

    return response.data.tracks.items.map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artists[0].name,
      album: response.data.name,
      duration: track.duration_ms,
      uri: track.uri,
      albumArt: response.data.images[0]?.url
    }));
  }

  async getPlaylistTracks(playlistId) {
    if (!this.accessToken) await this.getAccessToken();

    const tracks = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

    while (url) {
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` }
      });

      for (const item of response.data.items) {
        if (item.track && item.track.type === 'track') {
          tracks.push({
            id: item.track.id,
            name: item.track.name,
            artist: item.track.artists[0]?.name || 'Unknown',
            album: item.track.album?.name || 'Unknown',
            duration: item.track.duration_ms,
            uri: item.track.uri,
            albumArt: item.track.album?.images[0]?.url
          });
        }
      }
      url = response.data.next;
    }
    return tracks;
  }

  parseSpotifyUrl(url) {
    // Track: https://open.spotify.com/track/XXXXX or spotify:track:XXXXX
    const trackMatch = url.match(/track[\/:]([a-zA-Z0-9]+)/);
    if (trackMatch) {
      return { type: 'track', id: trackMatch[1] };
    }

    // Album: https://open.spotify.com/album/XXXXX or spotify:album:XXXXX
    const albumMatch = url.match(/album[\/:]([a-zA-Z0-9]+)/);
    if (albumMatch) {
      return { type: 'album', id: albumMatch[1] };
    }

    // Playlist: https://open.spotify.com/playlist/XXXXX or spotify:playlist:XXXXX
    const playlistMatch = url.match(/playlist[\/:]([a-zA-Z0-9]+)/);
    if (playlistMatch) {
      return { type: 'playlist', id: playlistMatch[1] };
    }

    return null;
  }
}

module.exports = SpotifyAPI;
