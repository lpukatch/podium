import { describe, expect, it } from 'vitest';
import { describeRunError } from '../app/progress-view';
import { errorText } from './error-text';

/** The shape undici throws: a bare TypeError with the real failure as cause. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('errorText', () => {
  it('is String(error) when there is no cause', () => {
    expect(errorText(new Error('boom'))).toBe('Error: boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(null)).toBe('null');
    expect(errorText(undefined)).toBe('undefined');
  });

  it('adds the code and message of a socket failure', () => {
    expect(errorText(fetchFailed(withCode('other side closed', 'UND_ERR_SOCKET')))).toBe(
      'TypeError: fetch failed (UND_ERR_SOCKET: other side closed)',
    );
  });

  it('adds just the code when the cause has no message', () => {
    // What a refused connection looks like: an AggregateError with an empty
    // message, one attempt per address family inside it.
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(errorText(fetchFailed(refused))).toBe('TypeError: fetch failed (ECONNREFUSED)');
  });

  it('names the code once when the message already carries it', () => {
    const cause = withCode('connect ECONNREFUSED 10.0.0.1:9191', 'ECONNREFUSED');
    expect(errorText(fetchFailed(cause))).toBe(
      'TypeError: fetch failed (connect ECONNREFUSED 10.0.0.1:9191)',
    );
  });

  it('adds the message of a cause with no code', () => {
    expect(errorText(fetchFailed(new Error('getaddrinfo failed')))).toBe(
      'TypeError: fetch failed (getaddrinfo failed)',
    );
  });

  it('still reads as unreachable on the progress page', () => {
    // The stored run error feeds describeRunError; keeping the original text
    // at the front is what keeps that summary unchanged.
    const stored = errorText(fetchFailed(withCode('other side closed', 'UND_ERR_SOCKET')));
    expect(describeRunError(stored)).toBe('Could not reach Dispatcharr');
  });
});
