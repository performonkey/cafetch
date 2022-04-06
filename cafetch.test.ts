// @ts-nocheck
import Joi from 'joi';
import { request, ext, globalState, registerEndpoint } from './cafetch';

const fetch = globalThis.fetch = jest.fn(() => Promise.resolve({
  headers: new Headers([
    ['content-type', 'application/json'],
  ]),
  ok: true,
  redirected: false,
  status: 200,
  statusText: 'OK',
  type: '',
  url: 'https://example.com/',
  json: () => Promise.resolve({ a: 123 }),
}));

beforeEach(() => {
  fetch.mockClear();
});

test('deduplicate request', (done) => {
  request('http://example.com');
  request('http://example.com');
  request('http://example.com')
    .on('data', () => {
      expect(fetch.mock.calls.length).toBe(1);
      done();
    })
  ;
});

test('pre methods execute before fetch', (done) => {
  let prevCount = fetch.mock.calls.length;
  ext('pre', () => {
    expect(fetch.mock.calls.length).toBe(prevCount);
  });
  expect(globalState.pre.length).toBe(1);
  request('http://example.com', { fetchPolicy: 'network-only' })
    .on('data', () => {
      expect(fetch.mock.calls.length).toBe(prevCount + 1);
      globalState.pre = [];
      done();
    })
    .on('error', () => {
      done();
    })
  ;
});

test('post methods execute after fetch', (done) => {
  let prevCount = fetch.mock.calls.length;
  ext('post', () => {
    expect(fetch.mock.calls.length).toBe(prevCount + 1);
  });
  expect(globalState.post.length).toBe(1);

  request('http://example.com', { fetchPolicy: 'network-only' })
    .on('data', () => {
      expect(fetch.mock.calls.length).toBe(prevCount + 1);
      globalState.post = [];
      done();
    })
    .on('error', () => {
      done();
    })
  ;
});

describe('validate', () => {
  it('body-invalid', (done) => {
    registerEndpoint({
      endpoint: 'validate-body',
      url: 'http://example.com/validate-body',
      method: 'POST',
      validate: {
        body: Joi.object({
          a: Joi.number().required(),
        })
      },
    });
    request({
      endpoint: 'validate-body',
      method: 'POST',
      body: {},
    })
      .on('error', (error) => {
        expect(error.message).toBe(`"a" is required`);
        done();
      })
    ;
  });
  it('body-valid', (done) => {
    registerEndpoint({
      endpoint: 'validate-body',
      url: 'http://example.com/validate-body',
      method: 'POST',
      validate: {
        body: Joi.object({
          a: Joi.number().required(),
        })
      },
    });
    request({
      endpoint: 'validate-body',
      method: 'POST',
      body: { a: '1' },
    })
      .on('data', (response) => {
        expect(response).toBeTruthy();
        done();
      })
    ;
  });
  it('response', (done) => {
    registerEndpoint({
      endpoint: 'validate-response',
      url: 'http://example.com/validate-response',
      validate: {
        response: Joi.object({
          a: Joi.number().required(),
        })
      },
    });
    request({ endpoint: 'validate-response' })
      .on('error', (error) => {
        expect(error).toBe(undefined);
        done();
      })
      .on('data', (response) => {
        expect(response).toBeTruthy();
        done();
      })
    ;
  });
});