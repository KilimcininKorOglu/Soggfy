const fs = require('fs').promises;
const path = require('path');
const mm = require('music-metadata');

class FileManager {
    constructor(basePath) {
        this.basePath = basePath;
        this.audioExtensions = ['.mp3', '.flac', '.ogg', '.m4a', '.wav', '.aac', '.wma'];
    }

    validatePath(targetPath) {
        const resolved = path.resolve(this.basePath, targetPath);
        if (!resolved.startsWith(this.basePath)) {
            throw new Error('Access denied: Path outside base directory');
        }
        return resolved;
    }

    isAudioFile(filename) {
        return this.audioExtensions.includes(path.extname(filename).toLowerCase());
    }

    async listDirectory(relativePath = '') {
        const dirPath = this.validatePath(relativePath);

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            const items = [];

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                let stats;
                try {
                    stats = await fs.stat(fullPath);
                } catch (e) {
                    continue;
                }

                const item = {
                    name: entry.name,
                    path: path.relative(this.basePath, fullPath).replace(/\\/g, '/'),
                    isDirectory: entry.isDirectory(),
                    size: stats.size,
                    modified: stats.mtime,
                    created: stats.birthtime
                };

                if (!entry.isDirectory() && this.isAudioFile(entry.name)) {
                    try {
                        const metadata = await mm.parseFile(fullPath);
                        item.metadata = {
                            title: metadata.common.title || null,
                            artist: metadata.common.artist || null,
                            album: metadata.common.album || null,
                            year: metadata.common.year || null,
                            duration: metadata.format.duration || null,
                            bitrate: metadata.format.bitrate || null,
                            format: metadata.format.codec || null,
                            hasArtwork: (metadata.common.picture?.length || 0) > 0
                        };
                    } catch (e) {
                        item.metadata = null;
                    }
                }

                items.push(item);
            }

            items.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });

            return {
                path: relativePath,
                parentPath: relativePath ? path.dirname(relativePath).replace(/\\/g, '/') : null,
                items
            };
        } catch (error) {
            throw new Error(`Failed to list directory: ${error.message}`);
        }
    }

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
                title: metadata.common.title || null,
                artist: metadata.common.artist || null,
                album: metadata.common.album || null,
                albumArtist: metadata.common.albumartist || null,
                year: metadata.common.year || null,
                track: metadata.common.track?.no || null,
                trackTotal: metadata.common.track?.of || null,
                disk: metadata.common.disk?.no || null,
                diskTotal: metadata.common.disk?.of || null,
                genre: metadata.common.genre?.join(', ') || null,
                duration: metadata.format.duration || null,
                bitrate: metadata.format.bitrate || null,
                sampleRate: metadata.format.sampleRate || null,
                channels: metadata.format.numberOfChannels || null,
                format: metadata.format.codec || null,
                lossless: metadata.format.lossless || false
            };

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

    async deleteFile(relativePath) {
        const targetPath = this.validatePath(relativePath);
        const stats = await fs.stat(targetPath);

        if (stats.isDirectory()) {
            await fs.rm(targetPath, { recursive: true });
        } else {
            await fs.unlink(targetPath);
        }

        return { success: true, path: relativePath };
    }

    async moveFile(fromPath, toPath) {
        const source = this.validatePath(fromPath);
        const dest = this.validatePath(toPath);

        await fs.rename(source, dest);

        return { success: true, from: fromPath, to: toPath };
    }

    async createDirectory(relativePath) {
        const dirPath = this.validatePath(relativePath);
        await fs.mkdir(dirPath, { recursive: true });
        return { success: true, path: relativePath };
    }

    async search(query, options = {}) {
        const results = [];
        const searchLower = query.toLowerCase();
        const limit = options.limit || 100;

        const searchDir = async (dir) => {
            if (results.length >= limit) return;

            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (e) {
                return;
            }

            for (const entry of entries) {
                if (results.length >= limit) break;

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await searchDir(fullPath);
                } else if (this.isAudioFile(entry.name)) {
                    const relativePath = path.relative(this.basePath, fullPath).replace(/\\/g, '/');

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
                                            title: metadata.common.title || null,
                                            artist: metadata.common.artist || null,
                                            album: metadata.common.album || null
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

        return results;
    }

    async getStorageStats() {
        const stats = {
            totalFiles: 0,
            totalSize: 0,
            byFormat: {},
            byArtist: {},
            byYear: {}
        };

        const processDir = async (dir) => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (e) {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await processDir(fullPath);
                } else if (this.isAudioFile(entry.name)) {
                    let fileStats;
                    try {
                        fileStats = await fs.stat(fullPath);
                    } catch (e) {
                        continue;
                    }

                    stats.totalFiles++;
                    stats.totalSize += fileStats.size;

                    const ext = path.extname(entry.name).toLowerCase().slice(1);
                    stats.byFormat[ext] = (stats.byFormat[ext] || 0) + 1;

                    try {
                        const metadata = await mm.parseFile(fullPath);
                        const artist = metadata.common.artist || 'Unknown';
                        const year = metadata.common.year || 'Unknown';

                        stats.byArtist[artist] = (stats.byArtist[artist] || 0) + 1;
                        stats.byYear[year] = (stats.byYear[year] || 0) + 1;
                    } catch (e) {
                        stats.byArtist['Unknown'] = (stats.byArtist['Unknown'] || 0) + 1;
                    }
                }
            }
        };

        await processDir(this.basePath);

        stats.topArtists = Object.entries(stats.byArtist)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([artist, count]) => ({ artist, count }));

        stats.formatDistribution = Object.entries(stats.byFormat)
            .sort((a, b) => b[1] - a[1])
            .map(([format, count]) => ({ format, count }));

        return stats;
    }

    async findDuplicates() {
        const filesByKey = new Map();
        const duplicates = [];

        const processDir = async (dir) => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch (e) {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await processDir(fullPath);
                } else if (this.isAudioFile(entry.name)) {
                    try {
                        const metadata = await mm.parseFile(fullPath);
                        const title = metadata.common.title || '';
                        const artist = metadata.common.artist || '';
                        const album = metadata.common.album || '';

                        if (!title && !artist) continue;

                        const key = `${title.toLowerCase()}|${artist.toLowerCase()}|${album.toLowerCase()}`;
                        const relativePath = path.relative(this.basePath, fullPath).replace(/\\/g, '/');

                        if (filesByKey.has(key)) {
                            duplicates.push({
                                original: filesByKey.get(key),
                                duplicate: relativePath,
                                title,
                                artist,
                                album
                            });
                        } else {
                            filesByKey.set(key, relativePath);
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
}

module.exports = FileManager;
