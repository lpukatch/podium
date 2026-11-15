import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DispatcharrClient } from './dispatcharr';
import { TeamarrClient } from './teamarr-client';

let server: Server;
let base: string;
const reached: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/target') {
      reached.push(request.headers.authorization ?? 'no authorization');
      response.writeHead(200).end('[]');
      return;
    }
    response.writeHead(302, { Location: `${base}/target` }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test server port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('upstream redirects', () => {
  it('refuses Dispatcharr GET redirects before forwarding API credentials', async () => {
    await expect(
      new DispatcharrClient(base, { apiKey: 'test-secret' }).providers(),
    ).rejects.toThrow();
    expect(reached).toEqual([]);
  });

  it('refuses Dispatcharr login redirects', async () => {
    await expect(
      new DispatcharrClient(base, { username: 'u', password: 'p' }).login(),
    ).rejects.toThrow();
    expect(reached).toEqual([]);
  });

  it('refuses Teamarr GET and PUT redirects', async () => {
    const client = new TeamarrClient(base);
    await expect(client.rules()).rejects.toThrow('Could not reach Teamarr');
    await expect(client.putRules([])).rejects.toThrow('Could not reach Teamarr');
    expect(reached).toEqual([]);
  });
});
