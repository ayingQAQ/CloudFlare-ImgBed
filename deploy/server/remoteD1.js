export class RemoteD1 {
    constructor(baseUrl, secret, fetcher = fetch) {
        this.url = `${baseUrl.replace(/\/$/, '')}/d1`;
        this.secret = secret;
        this.fetcher = fetcher;
    }

    prepare(sql) {
        return new RemoteD1Statement(this, sql);
    }

    async execute(method, sql, params, column) {
        const response = await this.fetcher(this.url, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
            body: JSON.stringify({ method, sql, params, column }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(`Remote D1 ${response.status}: ${result.error || 'request failed'}`);
        return method === 'first' ? result.result : result;
    }
}

class RemoteD1Statement {
    constructor(client, sql) { this.client = client; this.sql = sql; this.params = []; }
    bind(...params) {
        this.params = params.map(value => value === undefined ? null : typeof value === 'boolean' ? Number(value) : value);
        return this;
    }
    first(column) { return this.client.execute('first', this.sql, this.params, column); }
    all() { return this.client.execute('all', this.sql, this.params); }
    run() { return this.client.execute('run', this.sql, this.params); }
}
