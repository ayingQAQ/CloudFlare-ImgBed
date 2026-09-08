// R2 may throttle rapid writes to one key. Preserve conditional-write semantics
// while retrying throttling; a lost CAS race still returns null to the caller.
export async function r2Put(bucket, key, value, options) {
    for (let attempt = 0; ; attempt++) {
        try { return await bucket.put(key, value, options); }
        catch (error) {
            if (attempt >= 5 || !/429|too many|rate.?limit/i.test(String(error.message))) throw error;
            await new Promise(resolve => setTimeout(resolve, 1100 + attempt * 200));
        }
    }
}
