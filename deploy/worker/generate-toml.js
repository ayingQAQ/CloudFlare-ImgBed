/**
 * 根据环境变量生成 deploy/worker/wrangler.toml
 * 用于 GitHub Actions 部署，从 Secrets/Variables 读取配置
 * 
 * 环境变量：
 *   WORKER_NAME      - Worker 名称（默认 cloudflare-imgbed）
 *   D1_DATABASE_ID   - D1 数据库 ID
 *   KV_NAMESPACE_ID  - KV 命名空间 ID
 *   R2_BUCKET_NAME   - R2 存储桶名称
 *   CUSTOM_DOMAIN    - Worker 自定义域名（例如 imgb.top）
 *   WORKER_VARS      - JSON 格式的业务环境变量
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, 'wrangler.toml');

const env = process.env;
const name = env.WORKER_NAME || 'cloudflare-imgbed';
const tomlString = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const topologyPath = join(__dirname, 'dual-backend.json');
if (existsSync(topologyPath)) {
    const config = JSON.parse(readFileSync(topologyPath, 'utf8'));
    const origin = new URL(config.origin);
    if (origin.protocol !== 'https:' || config.hosts.includes(origin.hostname)) throw new Error('Origin must use a separate HTTPS hostname');
    if (!config.databaseId || !config.bucketName || !config.hosts.length) throw new Error('Incomplete shared storage topology');
    const q = value => JSON.stringify(String(value));
    const routes = config.hosts.map(host => `{ pattern = ${q(host + '/*')}, zone_name = ${q(config.zoneName)} }`).join(', ');
    const output = `# Generated from dual-backend.json; legacy KV/CUSTOM_DOMAIN secrets are intentionally ignored.
name = ${q(config.name)}
main = "routes-entry.js"
compatibility_date = "2024-08-21"
compatibility_flags = ["global_fetch_strictly_public"]
keep_vars = true
routes = [${routes}]
[triggers]
crons = ["* * * * *"]
[assets]
directory = "../../frontend-dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
[images]
binding = "IMAGES"
[vars]
ORIGIN_FALLBACK_MODE = "routes"
ORIGIN_STATE_READY = "true"
ORIGIN_BASE_URL = ${q(config.origin)}
[[d1_databases]]
binding = "img_d1"
database_name = ${q(config.databaseName)}
database_id = ${q(config.databaseId)}
[[r2_buckets]]
binding = "img_r2"
bucket_name = ${q(config.bucketName)}
[[durable_objects.bindings]]
name = "HF_COMMITS"
class_name = "HFCommitCoordinator"
script_name = "cloudflare-imgbed-state-gateway"
`;
    writeFileSync(outputPath, output, 'utf8');
    console.log('Generated shared D1/R2 Routes deployment configuration (secrets preserved).');
    process.exit(0);
}

if (!env.D1_DATABASE_ID && !env.KV_NAMESPACE_ID) {
    throw new Error('Missing database binding: configure D1_DATABASE_ID or KV_NAMESPACE_ID');
}
if (!env.R2_BUCKET_NAME) {
    throw new Error('Missing R2_BUCKET_NAME: anonymous quota and durable Telegram backup require R2');
}

let toml = `name = "${name}"
main = "index.js"
compatibility_date = "2024-08-21"
compatibility_flags = ["global_fetch_strictly_public"]
keep_vars = true
${env.CUSTOM_DOMAIN ? `routes = [{ pattern = "${tomlString(env.CUSTOM_DOMAIN)}", custom_domain = true }]\n` : ''}

[triggers]
crons = ["* * * * *"]

[assets]
directory = "../../frontend-dist"
binding = "ASSETS"
not_found_handling = "single-page-application"

[images]
binding = "IMAGES"
`;

// D1 数据库
if (env.D1_DATABASE_ID) {
    toml += `
[[d1_databases]]
binding = "img_d1"
database_name = "img_d1"
database_id = "${env.D1_DATABASE_ID}"
`;
}

// KV 命名空间
if (env.KV_NAMESPACE_ID) {
    toml += `
[[kv_namespaces]]
binding = "img_url"
id = "${env.KV_NAMESPACE_ID}"
`;
}

// R2 存储桶
if (env.R2_BUCKET_NAME) {
    toml += `
[[r2_buckets]]
binding = "img_r2"
bucket_name = "${env.R2_BUCKET_NAME}"
`;
}

// 业务环境变量（从 JSON 解析）
if (env.WORKER_VARS) {
    try {
        const vars = JSON.parse(env.WORKER_VARS);
        const entries = Object.entries(vars);
        if (entries.length > 0) {
            toml += '\n[vars]\n';
            for (const [key, value] of entries) {
                toml += `${key} = "${tomlString(value)}"\n`;
            }
        }
    } catch (e) {
        console.error('Warning: WORKER_VARS is not valid JSON, skipping:', e.message);
    }
}

writeFileSync(outputPath, toml, 'utf8');

// 打印配置（隐藏敏感值）
const safeToml = toml
    .replace(/database_id = ".*"/g, 'database_id = "***"')
    .replace(/(id = )".*"/g, '$1"***"')
    .replace(/(TOKEN.*= )".*"/gi, '$1"***"')
    .replace(/(KEY.*= )".*"/gi, '$1"***"')
    .replace(/(SECRET.*= )".*"/gi, '$1"***"');

console.log('Generated deploy/worker/wrangler.toml:');
console.log(safeToml);
