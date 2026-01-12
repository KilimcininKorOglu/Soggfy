const WebSocket = require('ws');

// Soggfy Message Types (from ControlServer.h)
const MessageType = {
  SYNC_CONFIG: 1,
  TRACK_META: 2,
  DOWNLOAD_STATUS: 3,
  OPEN_FOLDER: 4,
  OPEN_FILE_PICKER: 5,
  WRITE_FILE: 6,
  PLAYER_STATE: 7
};

class SoggfyClient {
  constructor() {
    this.ws = null;
    this.callbacks = new Map();
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimeout = null;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    // IMPORTANT: Must include /sgf_ctrl path
    this.ws = new WebSocket('ws://127.0.0.1:28653/sgf_ctrl');

    this.ws.on('open', () => {
      console.log('Connected to Soggfy ControlServer');
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Request current config from Soggfy
      this.send(MessageType.SYNC_CONFIG, {});

      const callback = this.callbacks.get('connected');
      if (callback) callback();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = this.parseMessage(data);
        const callback = this.callbacks.get(msg.type);
        if (callback) callback(msg.content, msg.binary);
      } catch (error) {
        console.error('Failed to parse Soggfy message:', error);
      }
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      console.log('Disconnected from Soggfy');

      const callback = this.callbacks.get('disconnected');
      if (callback) callback();

      // Reconnect with exponential backoff
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        this.reconnectTimeout = setTimeout(() => this.connect(), delay);
      } else {
        console.error('Max reconnection attempts reached');
      }
    });
  }

  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(type, content, binary = Buffer.alloc(0)) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot send: WebSocket not connected');
      return false;
    }

    // Soggfy message format: [type:u8][len:i32][json][binary]
    const jsonStr = JSON.stringify(content);
    const jsonBuffer = Buffer.from(jsonStr, 'utf8');
    const buffer = Buffer.alloc(5 + jsonBuffer.length + binary.length);

    buffer.writeUInt8(type, 0);
    buffer.writeInt32LE(jsonBuffer.length, 1);
    jsonBuffer.copy(buffer, 5);
    if (binary.length > 0) binary.copy(buffer, 5 + jsonBuffer.length);

    this.ws.send(buffer);
    return true;
  }

  parseMessage(buffer) {
    const type = buffer.readUInt8(0);
    const jsonLen = buffer.readInt32LE(1);
    const jsonStr = buffer.toString('utf8', 5, 5 + jsonLen);
    const binary = buffer.slice(5 + jsonLen);

    return {
      type,
      content: JSON.parse(jsonStr),
      binary
    };
  }

  on(messageType, callback) {
    this.callbacks.set(messageType, callback);
  }

  off(messageType) {
    this.callbacks.delete(messageType);
  }
}

module.exports = { SoggfyClient, MessageType };
