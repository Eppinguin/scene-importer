/**
 * Pure-JavaScript LevelDB SSTable (.ldb) reader for browser environments.
 *
 * This is a READ-ONLY parser that extracts key/value pairs from static
 * LevelDB SSTable files. It does NOT implement write-ahead logs, MANIFEST
 * parsing, or compaction — those are unnecessary since Foundry VTT module
 * ZIPs ship fully-compacted SSTables.
 *
 * LevelDB SSTable format (simplified):
 *   [data block 1] [data block 2] ... [data block N]
 *   [meta block 1] ... [meta block K]
 *   [metaindex block]
 *   [index block]
 *   [Footer]  (48 bytes at end of file)
 *
 * Each block is optionally Snappy-compressed. We read the footer to locate
 * the index block, then iterate data blocks to extract entries.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — snappyjs has no type declarations
import SnappyJS from 'snappyjs';

// LevelDB magic number (little-endian): 0xdb4775248b80fb57
const FOOTER_SIZE = 48;
const MAGIC_LO = 0x8b80fb57;
const MAGIC_HI = 0xdb477524;

// Block compression types
const NO_COMPRESSION = 0;
const SNAPPY_COMPRESSION = 1;

/** Decode a varint from a DataView at the given offset. Returns [value, bytesRead]. */
function readVarint(view: DataView, offset: number): [number, number] {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;
    while (offset + bytesRead < view.byteLength) {
        const byte = view.getUint8(offset + bytesRead);
        result |= (byte & 0x7f) << shift;
        bytesRead++;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) throw new Error('Varint too long');
    }
    return [result >>> 0, bytesRead]; // unsigned
}

/** Read a varint64 (we only support up to 53-bit safe integer). */
function readVarint64(view: DataView, offset: number): [number, number] {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;
    while (offset + bytesRead < view.byteLength) {
        const byte = view.getUint8(offset + bytesRead);
        result += (byte & 0x7f) * Math.pow(2, shift);
        bytesRead++;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        if (shift > 63) throw new Error('Varint64 too long');
    }
    return [result, bytesRead];
}

interface BlockHandle {
    offset: number;
    size: number;
}

/** Parse a BlockHandle (two varints: offset and size) from a DataView. */
function readBlockHandle(view: DataView, offset: number): [BlockHandle, number] {
    const [blockOffset, n1] = readVarint64(view, offset);
    const [blockSize, n2] = readVarint64(view, offset + n1);
    return [{ offset: blockOffset, size: blockSize }, n1 + n2];
}

/**
 * Read the 48-byte footer at the end of the SSTable.
 * Layout:
 *   metaindex_handle: varint-encoded BlockHandle
 *   index_handle:     varint-encoded BlockHandle
 *   padding:          zeroed bytes to fill 40 bytes total
 *   magic:            8 bytes (little-endian 0xdb4775248b80fb57)
 */
function readFooter(data: ArrayBuffer): { metaindexHandle: BlockHandle; indexHandle: BlockHandle } {
    if (data.byteLength < FOOTER_SIZE) {
        throw new Error(`File too small to be an SSTable (${data.byteLength} bytes)`);
    }

    const footerOffset = data.byteLength - FOOTER_SIZE;
    const view = new DataView(data, footerOffset, FOOTER_SIZE);

    // Verify magic number at bytes 40..47
    const magicLo = view.getUint32(40, true);
    const magicHi = view.getUint32(44, true);
    if (magicLo !== MAGIC_LO || magicHi !== MAGIC_HI) {
        throw new Error('Invalid SSTable: magic number mismatch');
    }

    // Read the two BlockHandles from the beginning of the footer
    const [metaindexHandle, n1] = readBlockHandle(view, 0);
    const [indexHandle] = readBlockHandle(view, n1);

    return { metaindexHandle, indexHandle };
}

/**
 * Read and decompress a block from the SSTable.
 *
 * Physical block layout on disk:
 *   [block_data: N bytes] [compression_type: 1 byte] [crc32: 4 bytes]
 *
 * The BlockHandle.size refers to the raw block_data size (before compression type + crc).
 */
function readBlock(data: ArrayBuffer, handle: BlockHandle): Uint8Array {
    const blockStart = handle.offset;
    const blockDataSize = handle.size;

    // The compression type byte is right after the block data
    const typeOffset = blockStart + blockDataSize;
    if (typeOffset >= data.byteLength) {
        throw new Error(`Block extends past end of file: offset=${blockStart}, size=${blockDataSize}, fileSize=${data.byteLength}`);
    }

    const typeView = new DataView(data, typeOffset, 1);
    const compressionType = typeView.getUint8(0);

    const rawBlock = new Uint8Array(data, blockStart, blockDataSize);

    if (compressionType === NO_COMPRESSION) {
        return rawBlock;
    } else if (compressionType === SNAPPY_COMPRESSION) {
        try {
            const decompressed = SnappyJS.uncompress(rawBlock);
            return new Uint8Array(decompressed);
        } catch (e) {
            console.warn('Snappy decompression failed for block, trying raw:', e);
            return rawBlock;
        }
    } else {
        console.warn(`Unknown compression type ${compressionType}, attempting raw read`);
        return rawBlock;
    }
}

/**
 * Parse key/value entries from a decompressed data block.
 *
 * Block format (from block_builder.cc):
 *   Each entry is:
 *     shared_bytes:     varint32  (bytes shared with previous key)
 *     unshared_bytes:   varint32  (bytes in this key that differ)
 *     value_length:     varint32
 *     key_delta:        char[unshared_bytes]
 *     value:            char[value_length]
 *
 *   At the end:
 *     restarts:         uint32[num_restarts]  (offsets of restart points)
 *     num_restarts:     uint32
 */
function parseBlockEntries(block: Uint8Array): Array<{ key: Uint8Array; value: Uint8Array }> {
    const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);

    if (block.byteLength < 4) return entries;

    // Read num_restarts from the last 4 bytes
    const numRestarts = view.getUint32(block.byteLength - 4, true);

    // The restart array starts at: block.length - 4 - (numRestarts * 4)
    const restartsEnd = block.byteLength - 4;
    const restartsStart = restartsEnd - (numRestarts * 4);

    if (restartsStart < 0 || numRestarts > 100000) {
        // Corrupt or unexpected block structure
        return entries;
    }

    // Parse entries from offset 0 up to restartsStart
    let offset = 0;
    let prevKey = new Uint8Array(0);

    while (offset < restartsStart) {
        const [shared, n1] = readVarint(view, offset);
        offset += n1;
        if (offset >= restartsStart) break;

        const [unshared, n2] = readVarint(view, offset);
        offset += n2;
        if (offset >= restartsStart) break;

        const [valueLen, n3] = readVarint(view, offset);
        offset += n3;
        if (offset + unshared + valueLen > restartsStart) break;

        // Reconstruct the full key using prefix compression
        const key = new Uint8Array(shared + unshared);
        if (shared > 0) {
            key.set(prevKey.subarray(0, shared), 0);
        }
        key.set(block.subarray(offset, offset + unshared), shared);
        offset += unshared;

        const value = block.slice(offset, offset + valueLen);
        offset += valueLen;

        entries.push({ key, value });
        prevKey = key;
    }

    return entries;
}

/** Decode a Uint8Array to a UTF-8 string. */
function decodeString(bytes: Uint8Array): string {
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Internal key format in LevelDB:
 *   [user_key] [sequence_number: 7 bytes] [type: 1 byte]
 *
 * The last 8 bytes are the internal trailer. Type 1 = value, type 0 = deletion.
 * We also decode the sequence number so we can reliably pick the newest version
 * of each key across multiple records/files.
 */
function extractUserKey(internalKey: Uint8Array): {
    userKey: string;
    sequence: number;
    isValue: boolean;
} {
    if (internalKey.length < 8) {
        // No internal trailer, treat as raw user key
        return { userKey: decodeString(internalKey), sequence: 0, isValue: true };
    }
    const userKeyBytes = internalKey.subarray(0, internalKey.length - 8);
    const typeAndSeq = new DataView(
        internalKey.buffer,
        internalKey.byteOffset + internalKey.length - 8,
        8
    );
    const trailer = typeAndSeq.getBigUint64(0, true);
    const typeByte = Number(trailer & 0xffn) & 0xff;
    const sequence = Number(trailer >> 8n);
    // type 0 = deletion, type 1 = value
    return {
        userKey: decodeString(userKeyBytes),
        sequence,
        isValue: (typeByte & 0x01) === 1,
    };
}

/**
 * Parse all key/value pairs from a LevelDB SSTable (.ldb) file.
 *
 * @param data The raw ArrayBuffer contents of the .ldb file.
 * @param keyPrefix Optional prefix filter — only return entries whose key starts with this string.
 * @returns Array of { key, value } string pairs.
 */
export function parseSSTTable(
    data: ArrayBuffer,
    keyPrefix?: string
): Array<{ key: string; value: string; sequence: number }> {
    const entries = parseSSTTableEntries(data, keyPrefix);

    const results: Array<{ key: string; value: string; sequence: number }> = [];
    for (const entry of entries) {
        if (!entry.deleted && entry.value !== null) {
            results.push({ key: entry.key, value: entry.value, sequence: entry.sequence });
        }
    }

    return results;
}

function parseSSTTableEntries(
    data: ArrayBuffer,
    keyPrefix?: string
): Array<{ key: string; value: string | null; sequence: number; deleted: boolean }> {
    const latestByKey = new Map<
        string,
        { sequence: number; value: string | null; deleted: boolean }
    >();

    try {
        const footer = readFooter(data);

        // Read the index block to find all data blocks
        const indexBlock = readBlock(data, footer.indexHandle);
        const indexEntries = parseBlockEntries(indexBlock);

        // Each index entry points to a data block
        for (const indexEntry of indexEntries) {
            // The value of each index entry is a BlockHandle for a data block
            const handleView = new DataView(
                indexEntry.value.buffer,
                indexEntry.value.byteOffset,
                indexEntry.value.byteLength
            );
            const [dataHandle] = readBlockHandle(handleView, 0);

            try {
                const dataBlock = readBlock(data, dataHandle);
                const entries = parseBlockEntries(dataBlock);

                for (const entry of entries) {
                    const { userKey, sequence, isValue } = extractUserKey(entry.key);
                    if (keyPrefix && !userKey.startsWith(keyPrefix)) continue;

                    const current = latestByKey.get(userKey);
                    if (current && current.sequence >= sequence) {
                        continue;
                    }

                    if (!isValue) {
                        latestByKey.set(userKey, {
                            sequence,
                            value: null,
                            deleted: true,
                        });
                        continue;
                    }

                    try {
                        latestByKey.set(userKey, {
                            sequence,
                            value: decodeString(entry.value),
                            deleted: false,
                        });
                    } catch {
                        // Skip entries with non-UTF8 values
                    }
                }
            } catch (e) {
                console.warn('Failed to parse data block, skipping:', e);
            }
        }
    } catch (e) {
        console.error('SSTable parse error:', e);
    }

    const results: Array<{ key: string; value: string | null; sequence: number; deleted: boolean }> = [];
    for (const [key, entry] of latestByKey) {
        results.push({ key, value: entry.value, sequence: entry.sequence, deleted: entry.deleted });
    }

    return results;
}

/**
 * Extract Foundry VTT scene documents from LevelDB SSTable files.
 *
 * Foundry stores scenes with keys like `!scenes!<documentId>`.
 * Values are JSON scene objects.
 *
 * @param ldbBuffers Array of ArrayBuffer contents from .ldb files in the pack directory.
 * @returns Array of parsed scene objects, deduplicated by _id (latest wins).
 */
export function extractScenesFromLevelDB(
    ldbBuffers: ArrayBuffer[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
    const sceneDocsByKey = new Map<string, {
        sequence: number;
        value: string | null;
        deleted: boolean;
    }>();

    for (const buffer of ldbBuffers) {
        const entries = parseSSTTableEntries(buffer, '!scenes!');

        for (const entry of entries) {
            const current = sceneDocsByKey.get(entry.key);
            if (!current || entry.sequence > current.sequence) {
                sceneDocsByKey.set(entry.key, {
                    sequence: entry.sequence,
                    value: entry.value,
                    deleted: entry.deleted,
                });
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sceneMap = new Map<string, any>();

    for (const [key, entry] of sceneDocsByKey) {
        if (entry.deleted || entry.value === null) {
            continue;
        }

        try {
            const scene = JSON.parse(entry.value);
            // Use _id or the key suffix as the unique identifier
            const id = scene._id || key.replace('!scenes!', '');
            sceneMap.set(id, scene);
        } catch {
            // Skip entries that aren't valid JSON
        }
    }

    return Array.from(sceneMap.values());
}
