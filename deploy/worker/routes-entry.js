// Candidate entry point for a future Routes deployment. Current production
// wrangler.toml still uses index.js; this module is not live.
import application from './index.js';
import { withOriginFallback } from './origin-fallback.js';

export default {
    scheduled: application.scheduled,
    fetch(request, env, ctx) {
        const url = new URL(request.url);
        let forwardedScheme = '';
        try { forwardedScheme = JSON.parse(request.headers.get('cf-visitor') || '{}').scheme || ''; } catch {}
        if (url.protocol === 'http:' || forwardedScheme === 'http') {
            url.protocol = 'https:';
            return Response.redirect(url, 301);
        }
        return withOriginFallback(request, env, ctx,
            (input, bindings, execution) => application.fetch(input, bindings, execution));
    },
};
