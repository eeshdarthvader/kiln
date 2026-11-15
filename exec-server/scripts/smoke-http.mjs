import assert from 'node:assert/strict';

export function endpoint(value) {
  const url = new URL(value);
  assert.ok(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'Endpoints require HTTP(S) without credentials, query, or fragment.',
  );
  return url;
}

export function smokeClient(value, authorization) {
  const base = endpoint(value);
  const headers = { 'content-type': 'application/json' };
  if (authorization) headers.authorization = authorization;
  async function request(path, method = 'GET', body, directory) {
    const url = new URL(path, base);
    if (directory) url.searchParams.set('directory', directory);
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    assert.ok(response.ok, `Acceptance HTTP request failed (${response.status}).`);
    return response.json();
  }
  return { base, request };
}
