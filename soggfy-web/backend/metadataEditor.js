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
            throw new Error('Access denied: Path outside base directory');
        }
        return resolved;
    }

    async readMetadata(relativePath) {
        const filePath = this.validatePath(relativePath);
        const metadata = await mm.parseFile(filePath);

        return {
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
            composer: metadata.common.composer?.join(', ') || null,
            comment: metadata.common.comment?.[0] || null,
            hasArtwork: (metadata.common.picture?.length || 0) > 0
        };
    }

    async writeMetadata(relativePath, updates) {
        const filePath = this.validatePath(relativePath);
        const ext = path.extname(filePath).toLowerCase();

        if (ext !== '.mp3') {
            throw new Error('Metadata editing only supported for MP3 files');
        }

        const tags = {};

        if (updates.title !== undefined && updates.title !== null) {
            tags.title = updates.title;
        }
        if (updates.artist !== undefined && updates.artist !== null) {
            tags.artist = updates.artist;
        }
        if (updates.album !== undefined && updates.album !== null) {
            tags.album = updates.album;
        }
        if (updates.albumArtist !== undefined && updates.albumArtist !== null) {
            tags.performerInfo = updates.albumArtist;
        }
        if (updates.year !== undefined && updates.year !== null) {
            tags.year = updates.year.toString();
        }
        if (updates.track !== undefined && updates.track !== null) {
            tags.trackNumber = updates.track.toString();
        }
        if (updates.genre !== undefined && updates.genre !== null) {
            tags.genre = updates.genre;
        }
        if (updates.composer !== undefined && updates.composer !== null) {
            tags.composer = updates.composer;
        }
        if (updates.comment !== undefined && updates.comment !== null) {
            tags.comment = { text: updates.comment };
        }

        if (updates.artwork) {
            if (updates.artwork.startsWith('data:')) {
                const matches = updates.artwork.match(/^data:(.+);base64,(.+)$/);
                if (matches) {
                    tags.image = {
                        mime: matches[1],
                        type: { id: 3, name: 'front cover' },
                        imageBuffer: Buffer.from(matches[2], 'base64')
                    };
                }
            }
        }

        const success = NodeID3.update(tags, filePath);

        if (!success) {
            throw new Error('Failed to write metadata');
        }

        return { success: true };
    }

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

    async removeArtwork(relativePath) {
        const filePath = this.validatePath(relativePath);
        const ext = path.extname(filePath).toLowerCase();

        if (ext !== '.mp3') {
            throw new Error('Artwork removal only supported for MP3 files');
        }

        const existingTags = NodeID3.read(filePath);
        if (existingTags.image) {
            delete existingTags.image;
            NodeID3.write(existingTags, filePath);
        }

        return { success: true };
    }

    async batchUpdate(files, updates) {
        const results = [];

        const cleanUpdates = {};
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined && value !== null && value !== '') {
                cleanUpdates[key] = value;
            }
        }

        if (Object.keys(cleanUpdates).length === 0) {
            return files.map(file => ({ file, success: false, error: 'No updates provided' }));
        }

        for (const file of files) {
            try {
                await this.writeMetadata(file, cleanUpdates);
                results.push({ file, success: true });
            } catch (error) {
                results.push({ file, success: false, error: error.message });
            }
        }

        return results;
    }
}

module.exports = MetadataEditor;
