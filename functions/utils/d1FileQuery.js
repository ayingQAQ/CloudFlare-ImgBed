// SQL filtering keeps metadata materialization proportional to the requested page.
export async function queryFilePage(db, options = {}) {
    const array = value => Array.isArray(value) ? value : value ? [value] : [];
    const directory = options.directory || '';
    const prefix = directory && !directory.endsWith('/') ? directory + '/' : directory;
    const predicates = ["(expires_at IS NULL OR expires_at > ?)", "COALESCE(timestamp, 0) <> 0",
        "substr(id,1,7) <> 'manage@'", "substr(id,1,6) <> 'chunk_'", "substr(id,1,15) <> 'upload_session_'", "substr(id,1,10) <> 'multipart_'"];
    const args = [Math.floor(Date.now() / 1000)];
    const add = (sql, ...values) => { predicates.push(sql); args.push(...values); };
    const either = (values, fn) => {
        if (values.length) add('(' + values.map(fn).join(' OR ') + ')');
    };
    if (prefix) add('(substr(dir, 1, ?) = ? OR dir = ?)', prefix.length, prefix, directory);
    for (const excluded of array(options.excludePrefixes)) add('substr(id,1,?) <> ?', excluded.length, excluded);
    const channels = array(options.channel);
    if (channels.length) add(`lower(channel) IN (${channels.map(() => '?').join(',')})`, ...channels.map(c => c.toLowerCase()));
    either(array(options.listType), value => {
        args.push(value);
        return value === 'None' ? "COALESCE(NULLIF(list_type,''), 'None') = ?" : 'list_type = ?';
    });
    const blocked = "(COALESCE(list_type,'') = 'Block' OR (COALESCE(label,'') = 'adult' AND COALESCE(list_type,'') <> 'White'))";
    either(array(options.accessStatus), value => value === 'normal' ? `NOT ${blocked}` : value === 'blocked' ? blocked : '0');
    either(array(options.label), value => {
        if (value === 'normal') return "COALESCE(label,'') IN ('','None','everyone')";
        if (value !== 'teen' && value !== 'adult') return '0';
        args.push(value); return 'label = ?';
    });
    either(array(options.fileType), value => {
        if (value === 'other') return "COALESCE(file_type,'') NOT GLOB 'image/*' AND COALESCE(file_type,'') NOT GLOB 'video/*' AND COALESCE(file_type,'') NOT GLOB 'audio/*'";
        if (!['image','video','audio'].includes(value)) return '0';
        args.push(value + '/'); return `substr(file_type,1,${value.length + 1}) = ?`;
    });
    either(array(options.channelName), value => {
        if (value.includes(':')) { args.push(...value.split(':',2)); return '(channel = ? AND channel_name = ?)'; }
        args.push(value); return 'channel_name = ?';
    });
    // COALESCE supports rows written before the tags column was maintained.
    for (const [tags, exclude] of [[array(options.includeTags), false], [array(options.excludeTags), true]]) {
        for (const tag of tags) add(`${exclude ? 'NOT ' : ''}EXISTS (SELECT 1 FROM json_each(COALESCE(tags, json_extract(metadata,'$.Tags'), '[]')) tag WHERE lower(tag.value) = ?)`, tag.toLowerCase());
    }
    either(array(options.mimeIncludes), value => { args.push(value); return "instr(COALESCE(file_type,''), ?) > 0"; });
    if (options.orientation) {
        const ratio = "(CAST(json_extract(metadata,'$.Width') AS REAL) / NULLIF(CAST(json_extract(metadata,'$.Height') AS REAL),0))";
        if (options.orientation === 'landscape') add(`${ratio} > 1.1`);
        if (options.orientation === 'portrait') add(`${ratio} < 0.9`);
        if (options.orientation === 'square') add(`${ratio} BETWEEN 0.9 AND 1.1`);
    }
    const directoryPredicates = predicates.slice();
    const directoryFilterArgs = args.slice();
    const extensions = {
        image: ['jpg','jpeg','png','gif','webp','bmp','svg','avif'],
        video: ['mp4','webm','ogg','mov','m4v','mkv','avi','3gp','mpeg','mpg','flv','wmv','ts','rmvb'],
        audio: ['mp3','wav','ogg','flac','aac','m4a','wma','ape','opus']
    };
    if (extensions[options.extensionType] || options.extensionType === 'other') {
        const list = extensions[options.extensionType] || [...new Set(Object.values(extensions).flat())];
        const matches = list.map(ext => { args.push('.' + ext); return `substr(lower(id),-${ext.length + 1}) = ?`; }).join(' OR ');
        add(`${options.extensionType === 'other' ? 'NOT ' : ''}(${matches})`);
    }
    if (options.search) {
        if (options.searchIdOnly) add('instr(lower(id), ?) > 0', options.search.toLowerCase());
        else add('(instr(lower(COALESCE(file_name,\'\')), ?) > 0 OR instr(lower(id), ?) > 0)', options.search.toLowerCase(), options.search.toLowerCase());
    }
    const makeBase = where => `WITH matching AS (SELECT *, COALESCE(NULLIF(directory,''), rtrim(id, replace(id,'/',''))) AS dir, timestamp AS stamp FROM files), filtered AS (SELECT * FROM matching WHERE ${where.join(' AND ')}) `;
    const base = makeBase(predicates);
    if (options.random) {
        const page = await db.prepare(base + 'SELECT id, metadata FROM filtered ORDER BY random() LIMIT 1').bind(...args).all();
        return { success: true, files: page.results.map(row => ({ id: row.id, metadata: JSON.parse(row.metadata) })), directories: [], totalCount: page.results.length, returnedCount: page.results.length };
    }
    const counts = await db.prepare(base + 'SELECT count(*) total, COALESCE(sum(dir = ?),0) direct FROM filtered').bind(...args, prefix).first();
    if (options.countOnly) return { success: true, totalCount: counts.total, indexLastUpdated: Date.now() };

    const pageWhere = options.includeSubdirFiles ? [] : ['dir = ?'];
    const pageArgs = [...args, ...(options.includeSubdirFiles ? [] : [prefix])];
    if (options.cursor) {
        const cursor = JSON.parse(decodeURIComponent(options.cursor));
        if (!Number.isFinite(cursor.timestamp) || typeof cursor.id !== 'string') throw new Error('Invalid file cursor');
        pageWhere.push('(stamp < ? OR (stamp = ? AND id > ?))');
        pageArgs.push(cursor.timestamp, cursor.timestamp, cursor.id);
    }
    const count = options.count === -1 ? -1 : Math.max(1, Math.min(1000, Number(options.count) || 50));
    const offset = options.cursor || count === -1 ? 0 : Math.max(0, Number(options.start) || 0);
    const pageQuery = base + 'SELECT id, metadata, stamp FROM filtered' + (pageWhere.length ? ' WHERE ' + pageWhere.join(' AND ') : '') + ' ORDER BY stamp DESC, id ASC LIMIT ? OFFSET ?';
    // Directory projection returns only distinct immediate children, never every metadata row.
    const directoryBase = options.filterDirectories === false ? makeBase(directoryPredicates) : base;
    const children = directoryBase.trimEnd() + ", children AS (SELECT DISTINCT ? || substr(substr(dir, ?), 1, instr(substr(dir, ?), '/') - 1) AS directory FROM filtered WHERE substr(dir,1,?) = ? AND instr(substr(dir, ?), '/') > 0) ";
    const directoryArgs = [...(options.filterDirectories === false ? directoryFilterArgs : args), prefix, prefix.length + 1, prefix.length + 1, prefix.length, prefix, prefix.length + 1];
    // count=-1 is the explicit bulk contract used by recursive move/delete/export.
    // Those consumers require the complete child list, just as they require all files.
    const directoryLimit = count === -1 ? -1 : 1001;
    const [page, dirs, folderCount] = await Promise.all([
        db.prepare(pageQuery).bind(...pageArgs, count === -1 ? -1 : count + 1, offset).all(),
        db.prepare(children + 'SELECT directory FROM children WHERE directory > ? ORDER BY directory LIMIT ?').bind(...directoryArgs, count === -1 ? '' : options.directoryCursor || '', directoryLimit).all(),
        db.prepare(children + 'SELECT count(*) total FROM children').bind(...directoryArgs).first()
    ]);
    const more = count !== -1 && page.results.length > count;
    const rows = more ? page.results.slice(0,count) : page.results;
    const files = rows.map(row => ({ id: row.id, metadata: JSON.parse(row.metadata || '{}') }));
    const last = rows.at(-1);
    const moreDirectories = count !== -1 && dirs.results.length > 1000;
    return { success: true, files, directories: (moreDirectories ? dirs.results.slice(0,1000) : dirs.results).map(row => row.directory),
        directoriesTruncated: moreDirectories, totalCount: counts.total, directFileCount: counts.direct,
        directoryCursor: moreDirectories ? dirs.results[999].directory : null,
        directFolderCount: folderCount.total, returnedCount: files.length, indexLastUpdated: Date.now(),
        cursor: more ? encodeURIComponent(JSON.stringify({ timestamp: last.stamp, id: last.id })) : null };
}
