/**
 * D1 数据库操作工具类
 */

import { queryFilePage } from './d1FileQuery.js';

const schemas = new WeakMap();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const expiration = options => options.expiration != null ? Number(options.expiration)
    : options.expirationTtl != null ? nowSeconds() + Number(options.expirationTtl) : null;

// Old installations can upgrade lazily; cache only successful schema checks per binding.
async function ensureColumns(db, table) {
    let state = schemas.get(db);
    if (!state) schemas.set(db, state = new Map());
    if (!state.has(table)) state.set(table, (async () => {
        const columns = new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(c => c.name));
        for (const [name, type] of [['expires_at', 'INTEGER'], ...(table === 'files' ? [['tags', 'TEXT']] : [])]) {
            if (!columns.has(name)) {
                try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run(); }
                catch (error) {
                    // A second isolate may have completed the same migration.
                    const latest = await db.prepare(`PRAGMA table_info(${table})`).all();
                    if (!latest.results.some(c => c.name === name)) throw error;
                }
            }
        }
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_${table}_expires_at ON ${table}(expires_at)`).run();
        if (table === 'files') await db.prepare('CREATE INDEX IF NOT EXISTS idx_files_page ON files(timestamp DESC, id ASC)').run();
    })().catch(error => { state.delete(table); throw error; }));
    return state.get(table);
}

async function listPage(db, table, key, options) {
    await ensureColumns(db, table);
    const limit = Math.min(1000, Math.max(1, Number(options.limit) || 1000));
    const prefix = options.prefix || '';
    const fields = table === 'files' ? 'id, metadata' : 'key, value';
    const where = ['(expires_at IS NULL OR expires_at > ?)'];
    const params = [nowSeconds()];
    if (prefix) {
        const characters = Array.from(prefix);
        while (characters.length && characters.at(-1).codePointAt(0) === 0x10ffff) characters.pop();
        const upper = characters.length ? characters.slice(0, -1).join('') + String.fromCodePoint(characters.at(-1).codePointAt(0) + 1) : null;
        where.push(`${key} >= ?`); params.push(prefix);
        if (upper) { where.push(`${key} < ?`); params.push(upper); }
    }
    if (options.cursor) { where.push(`${key} > ?`); params.push(options.cursor); }
    const { results } = await db.prepare(`SELECT ${fields} FROM ${table} WHERE ${where.join(' AND ')} ORDER BY ${key} LIMIT ?`)
        .bind(...params, limit + 1).all();
    const more = results.length > limit;
    const keys = results.slice(0, limit).map(row => table === 'files'
        ? { name: row.id, metadata: JSON.parse(row.metadata || '{}') }
        : { name: row.key, value: row.value });
    return { keys, list_complete: !more, cursor: more ? keys.at(-1).name : null };
}

class D1Database {
    constructor(db) {
        this.db = db;
    }
}

D1Database.prototype.cleanupExpired = async function({ limit = 100 } = {}) {
    let remaining = Math.min(1000, Math.max(1, Number(limit) || 100));
    let deleted = 0;
    for (const [table, key] of [['files', 'id'], ['settings', 'key']]) {
        if (!remaining) break;
        await ensureColumns(this.db, table);
        // Abort metadata must outlive the provider upload. Only recovery maintenance
        // may remove multipart markers; retain the session needed to select a provider.
        const recoveryGuard = table === 'files' ? `
            AND substr(id,1,10) <> 'multipart_'
            AND (substr(id,1,15) <> 'upload_session_' OR NOT EXISTS (
                SELECT 1 FROM files recovery WHERE recovery.id = 'multipart_' || substr(files.id,16)
            ))` : '';
        const result = await this.db.prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires_at <= ? ${recoveryGuard} ORDER BY expires_at LIMIT ?)`)
            .bind(nowSeconds(), remaining).run();
        deleted += result.meta.changes;
        remaining -= result.meta.changes;
    }
    return { deleted };
};

// Maintenance-only reader intentionally bypasses TTL visibility. Ordinary get/list
// still hide expired sessions, while recovery can abort with the original identifiers.
D1Database.prototype.listExpiredMultipart = async function({ limit = 20, cursor = '' } = {}) {
    await ensureColumns(this.db, 'files');
    const pageSize = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 20)));
    const time = nowSeconds();
    const { results } = await this.db.prepare(`
        SELECT multipart.id, multipart.value, session.value AS sessionValue
        FROM files multipart
        LEFT JOIN files session ON session.id = 'upload_session_' || substr(multipart.id,11)
        WHERE multipart.id >= 'multipart_' AND multipart.id < ('multipart' || char(96))
          AND multipart.id > ?
          AND (multipart.expires_at <= ? OR (
              multipart.expires_at IS NULL AND (
                  session.expires_at <= ? OR
                  CASE WHEN json_valid(session.value) THEN json_extract(session.value,'$.expiresAt') END <= ?
              )
          ))
        ORDER BY multipart.id LIMIT ?
    `).bind(cursor || '', time, time, time * 1000, pageSize + 1).all();
    const more = results.length > pageSize;
    const keys = results.slice(0,pageSize).map(row => ({ ...row, name: row.id }));
    return { keys, cursor: more ? keys.at(-1).id : null, list_complete: !more };
};

D1Database.prototype.queryFiles = async function(options) {
    await ensureColumns(this.db, 'files');
    return queryFilePage(this.db, options);
};

// ==================== 文件操作 ====================

/**
 * 保存文件记录 (替代 KV.put)
 */
D1Database.prototype.putFile = async function(fileId, value, options) {
    await ensureColumns(this.db, "files");
    value = value || '';
    options = options || {};
    var metadata = options.metadata || {};
    
    // 从metadata中提取字段用于索引
    var extractedFields = this.extractMetadataFields(metadata);
    extractedFields.directory = metadata.Directory || fileId.slice(0, fileId.lastIndexOf("/") + 1);
    
    var stmt = this.db.prepare(
        'INSERT OR REPLACE INTO files (' +
        'id, value, metadata, file_name, file_type, file_size, ' +
        'upload_ip, upload_address, list_type, timestamp, ' +
        'label, directory, channel, channel_name, ' +
        'tg_file_id, tg_chat_id, tg_bot_token, is_chunked, tags, expires_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    
    return stmt.bind(
        fileId,
        value,
        JSON.stringify(metadata),
        extractedFields.fileName,
        extractedFields.fileType,
        extractedFields.fileSize,
        extractedFields.uploadIP,
        extractedFields.uploadAddress,
        extractedFields.listType,
        extractedFields.timestamp,
        extractedFields.label,
        extractedFields.directory,
        extractedFields.channel,
        extractedFields.channelName,
        extractedFields.tgFileId,
        extractedFields.tgChatId,
        extractedFields.tgBotToken,
        extractedFields.isChunked,
        JSON.stringify(metadata.Tags || []),
        expiration(options)
    ).run();
};

/**
 * 获取文件记录 (替代 KV.get)
 */
D1Database.prototype.getFile = async function(fileId) {
    await ensureColumns(this.db, "files");
    var self = this;
    var stmt = this.db.prepare('SELECT * FROM files WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)');
    return stmt.bind(fileId, nowSeconds()).first().then(function(result) {
        if (!result) return null;
        
        return {
            value: result.value,
            metadata: JSON.parse(result.metadata || '{}')
        };
    });
};

/**
 * 获取文件记录包含元数据 (替代 KV.getWithMetadata)
 */
D1Database.prototype.getFileWithMetadata = function(fileId) {
    return this.getFile(fileId);
};

/**
 * 删除文件记录 (替代 KV.delete)
 */
D1Database.prototype.deleteFile = function(fileId) {
    var stmt = this.db.prepare('DELETE FROM files WHERE id = ?');
    return stmt.bind(fileId).run();
};

/**
 * 列出文件 (替代 KV.list)
 */
D1Database.prototype.listFiles = function(options = {}) {
    return listPage(this.db, 'files', 'id', options);
};

// ==================== 设置操作 ====================

/**
 * 保存设置 (替代 KV.put)
 */
D1Database.prototype.putSetting = async function(key, value, category, options = {}) {
    await ensureColumns(this.db, 'settings');
    return this.db.prepare('INSERT OR REPLACE INTO settings (key, value, category, expires_at) VALUES (?, ?, ?, ?)')
        .bind(key, value, category || key.split('@')[1] || '', expiration(options)).run();
};

D1Database.prototype.getSetting = async function(key) {
    await ensureColumns(this.db, 'settings');
    const result = await this.db.prepare('SELECT value FROM settings WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)')
        .bind(key, nowSeconds()).first();
    return result ? result.value : null;
};

/**
 * 删除设置 (替代 KV.delete)
 */
D1Database.prototype.deleteSetting = function(key) {
    var stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    return stmt.bind(key).run();
};

/**
 * 列出设置 (替代 KV.list)
 */
D1Database.prototype.listSettings = function(options = {}) {
    return listPage(this.db, 'settings', 'key', options);
};

// ==================== 索引操作 ====================

/**
 * 保存索引操作记录
 */
D1Database.prototype.putIndexOperation = function(operationId, operation) {
    var stmt = this.db.prepare(
        'INSERT OR REPLACE INTO index_operations (id, type, timestamp, data) VALUES (?, ?, ?, ?)'
    );
    
    return stmt.bind(
        operationId,
        operation.type,
        operation.timestamp,
        JSON.stringify(operation.data)
    ).run();
};

/**
 * 获取索引操作记录
 */
D1Database.prototype.getIndexOperation = function(operationId) {
    var stmt = this.db.prepare('SELECT * FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).first().then(function(result) {
        if (!result) return null;
        
        return {
            type: result.type,
            timestamp: result.timestamp,
            data: JSON.parse(result.data)
        };
    });
};

/**
 * 删除索引操作记录
 */
D1Database.prototype.deleteIndexOperation = function(operationId) {
    var stmt = this.db.prepare('DELETE FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).run();
};

/**
 * 列出索引操作记录
 */
D1Database.prototype.listIndexOperations = function(options) {
    options = options || {};
    var limit = options.limit || 1000;
    var processed = options.processed;
    
    var query = 'SELECT * FROM index_operations';
    var params = [];
    
    if (processed !== null && processed !== undefined) {
        query += ' WHERE processed = ?';
        params.push(processed);
    }
    
    if (options.cursor) {
        query += params.length ? ' AND' : ' WHERE';
        query += ' id > ?';
        params.push(options.cursor.replace('manage@index@operation_', ''));
    }
    query += ' ORDER BY id LIMIT ?';
    params.push(limit);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        return results.map(function(row) {
            return {
                id: row.id,
                type: row.type,
                timestamp: row.timestamp,
                data: JSON.parse(row.data),
                processed: row.processed
            };
        });
    });
};

// ==================== 工具方法 ====================

/**
 * 从metadata中提取字段用于索引
 */
D1Database.prototype.extractMetadataFields = function(metadata) {
    return {
        fileName: metadata.FileName || null,
        fileType: metadata.FileType || null,
        fileSize: metadata.FileSize || null,
        uploadIP: metadata.UploadIP || null,
        uploadAddress: metadata.UploadAddress || null,
        listType: metadata.ListType || null,
        timestamp: metadata.TimeStamp || null,
        label: metadata.Label || null,
        directory: metadata.Directory || null,
        channel: metadata.Channel || null,
        channelName: metadata.ChannelName || null,
        tgFileId: metadata.TgFileId || null,
        tgChatId: null,
        tgBotToken: null,
        isChunked: metadata.IsChunked || false
    };
};

// ==================== 通用方法 ====================

/**
 * 通用的put方法，根据key类型自动选择存储位置
 */
D1Database.prototype.put = function(key, value, options) {
    options = options || {};

    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        var operation = JSON.parse(value);
        return this.putIndexOperation(operationId, operation);
    } else if (key.startsWith('manage@')) {
        // 所有 manage@ 前缀的键统一存入 settings 表
        var category = key.split('@')[1] || '';
        return this.putSetting(key, value, category, options);
    } else {
        return this.putFile(key, value, options);
    }
};

/**
 * 通用的get方法，根据key类型自动选择获取位置
 */
D1Database.prototype.get = function(key) {
    var self = this;

    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.getIndexOperation(operationId).then(function(operation) {
            return operation ? JSON.stringify(operation) : null;
        });
    } else if (key.startsWith('manage@')) {
        return this.getSetting(key);
    } else {
        return this.getFile(key).then(function(file) {
            return file ? file.value : null;
        });
    }
};

/**
 * 通用的getWithMetadata方法
 */
D1Database.prototype.getWithMetadata = function(key) {
    var self = this;

    if (key.startsWith('manage@')) {
        return this.getSetting(key).then(function(value) {
            return value ? { value: value, metadata: {} } : null;
        });
    } else {
        return this.getFileWithMetadata(key);
    }
};

/**
 * 通用的delete方法
 */
D1Database.prototype.delete = function(key) {
    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.deleteIndexOperation(operationId);
    } else if (key.startsWith('manage@')) {
        return this.deleteSetting(key);
    } else {
        return this.deleteFile(key);
    }
};

/**
 * 通用的list方法
 */
D1Database.prototype.list = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var self = this;

    if (prefix.startsWith('manage@index@operation_')) {
        const limit = Math.min(1000, Math.max(1, Number(options.limit) || 1000));
        return this.listIndexOperations({ ...options, limit: limit + 1 }).then(function(operations) {
            const more = operations.length > limit;
            var keys = operations.slice(0, limit).map(function(op) {
                return {
                    name: 'manage@index@operation_' + op.id
                };
            });
            return { keys, cursor: more ? keys.at(-1).name : null, list_complete: !more };
        });
    } else if (prefix.startsWith('manage@')) {
        return this.listSettings(options);
    } else {
        return this.listFiles(options);
    }
};

// 导出构造函数
export { D1Database };

// Atomic publication of immutable index snapshots (also supported by RemoteD1).
D1Database.prototype.compareAndSwapSetting = async function(key, expected, value) {
    const statement = expected === null
        ? this.db.prepare('INSERT OR IGNORE INTO settings (key, value, category) VALUES (?, ?, ?)').bind(key, value, 'index')
        : this.db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?').bind(value, key, expected);
    const result = await statement.run();
    return result.meta.changes === 1;
};
