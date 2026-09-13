import { getDatabase } from './databaseAdapter.js';

export const ORIGIN_CHANNEL_KEY = 'manage@origin@channel-env';
export const ORIGIN_CHANNEL_FIELDS = ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_PROXY_URL', 'HF_TOKEN', 'HF_REPO', 'HF_PRIVATE'];

// Share storage credentials only. Administrator credentials remain in the
// security configuration and must never be replaced with bootstrap values.
export async function syncOriginChannels(env) {
    if (env.ORIGIN_STATE_READY !== 'true' || !env.img_d1) return;
    const value = JSON.stringify(Object.fromEntries(ORIGIN_CHANNEL_FIELDS
        .filter(key => env[key] !== undefined).map(key => [key, env[key]])));
    const db = getDatabase(env);
    if (await db.get(ORIGIN_CHANNEL_KEY) !== value) await db.put(ORIGIN_CHANNEL_KEY, value);
}
