import { fetchOthersConfig } from "./sysConfig";

export async function purgeCFCache(env, cdnUrl) {
    try {
        // 读取其他设置
        const othersConfig = await fetchOthersConfig(env);
        const cfZoneId = othersConfig.cloudflareApiToken.CF_ZONE_ID;
        const cfEmail = othersConfig.cloudflareApiToken.CF_EMAIL;
        const cfApiKey = othersConfig.cloudflareApiToken.CF_API_KEY;

        // 如果没有配置Cloudflare API，跳过缓存清除
        if (!cfZoneId || !cfEmail || !cfApiKey) {
            return;
        }

        // 清除CDN缓存
        const options = {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Auth-Email': `${cfEmail}`, 'X-Auth-Key': `${cfApiKey}`},
            body: JSON.stringify({ files: [cdnUrl] }),
            signal: AbortSignal.timeout(30000),
        };
        const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${ cfZoneId }/purge_cache`, options);
        await response.body?.cancel();
    } catch (error) {
        console.error('Failed to purge CF cache:', error.message || error);
    }
}

export async function purgeRandomFileListCache(origin, ...dirs) {
    try {
        const cache = caches.default;
        // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
        const nullResponse = new Response(null, {
            headers: { 'Cache-Control': 'max-age=0' },
        });

        for (const dir of ancestorDirectories(dirs)) {
            await cache.put(`${origin}/api/randomFileList?dir=${dir}`, nullResponse);
        }
    } catch (error) {
        console.error('Failed to clear randomFileList cache:', error);
    }
}

export async function purgePublicFileListCache(origin, ...dirs) {
    try {
        const cache = caches.default;
        // cache.delete有bug，通过写入一个max-age=0的response来清除缓存
        const nullResponse = new Response(null, {
            headers: { 'Cache-Control': 'max-age=0' },
        });

        for (const dir of ancestorDirectories(dirs)) {
            // 清除递归和非递归两种缓存
            await cache.put(`${origin}/api/publicFileList?dir=${dir}&recursive=false`, nullResponse);
            await cache.put(`${origin}/api/publicFileList?dir=${dir}&recursive=true`, nullResponse);
        }
    } catch (error) {
        console.error('Failed to clear publicFileList cache:', error);
    }
}

function ancestorDirectories(dirs) {
    const result = new Set(['']);
    for (const dir of dirs) {
        const parts = String(dir || '').replace(/^\/+|\/+$/g, '').split('/');
        while (parts.length) { result.add(parts.join('/')); parts.pop(); }
    }
    return result;
}
