import { describe, expect, it } from 'vitest';
import { describeRunError } from '../app/progress-view';
import { errorText, responseErrorText } from './error-text';

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

describe('responseErrorText', () => {
  it('keeps the failure class and the message', () => {
    const error = new Error('settings table is read-only');
    expect(responseErrorText(error)).toBe('Error: settings table is read-only');
  });

  it('unwraps the cause like errorText, so a fetch failure still says why', () => {
    const error = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    expect(responseErrorText(error)).toContain('ECONNREFUSED');
  });

  it('redacts the internal address a refused connection names', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 10.244.1.221:9191'),
    });
    const text = responseErrorText(error);
    expect(text).toContain('ECONNREFUSED [address]');
    expect(text).not.toContain('10.244.1.221');
  });

  it('redacts absolute paths, including the database file', () => {
    expect(responseErrorText(new Error('unable to open /app/data/podium.db'))).toBe(
      'Error: unable to open [path]',
    );
  });

  it('leaves a URL path alone', () => {
    // /api/ is not one of the filesystem roots an error names, and a message
    // quoting the endpoint that failed must survive.
    const text = responseErrorText(new Error('POST http://podium:3456/api/apply/12 refused'));
    expect(text).toContain('/api/apply/12');
  });

  it('leaves internal hostnames alone', () => {
    // The name is what the operator typed into Settings; hiding it hides the
    // thing they would otherwise look at.
    expect(responseErrorText(new Error('connect ECONNREFUSED dispatcharr:9191'))).toContain(
      'dispatcharr:9191',
    );
  });

  it('is one line and bounded', () => {
    const error = new Error(`boom\nnext line${'x'.repeat(400)}`);
    const text = responseErrorText(error);
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith('...')).toBe(true);
  });
});
