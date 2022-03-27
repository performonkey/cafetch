type FetchPolicy = 'network-only' | 'cache-first' | 'cache-only' | 'cache-and-network';
type Request = () => Promise<any>;
type PostSend = (response: CafetchResponse) => any;

interface CafetchResponse {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly type: ResponseType;
  readonly url: string;
  readonly body: ReadableStream<Uint8Array> | { [k: string]: any } | string | null;
}

interface CafetchRequestOptions extends  Omit<RequestInit, 'body'> {
  method: string;
  body?: ReadableStream | Blob | BufferSource | FormData | URLSearchParams | string | { [k: string]: any } | null;
}

interface CafetchOptions extends CafetchRequestOptions {
  postSend?: (response: CafetchResponse) => Promise<CafetchResponse>;
  preSend?: (options: CafetchRequestOptions) => CafetchRequestOptions;
  cacheKey?: string;
  fetchPolicy: FetchPolicy;
}

interface CafetchQueue {
  cacheKey: string;
  endpointKey: string;
  executor: Exector;
  ts: number;
}

interface Endpoint extends CafetchOptions {
  url: string | ((options: CafetchOptions) => string);
}

interface CafetchInit {
  endpoint: { [k: string]: Endpoint }
}

const globalState: { instance?: Cafetch } = {
  instance: undefined,
};

function cfetch(url: string, options: CafetchRequestOptions): Promise<CafetchResponse> {
  let body = options.body;
  let headers = new Headers(options.headers);
  switch (Object.prototype.toString.call(body)) {
    case '[object URLSearchParams]':
    case '[object FormData]':
      headers.delete('content-type');
      break;
    case '[object Object]':
      try {
        headers.set('content-type', 'application/json; charset=UTF-8');
        body = JSON.stringify(body);
      } catch (error) {
        throw new Error('Invalid JSON fetch body');
      }
      break;
    case '[object String]':
      if (!headers.has('content-type') && body) {
        body = body as string;
        if (
          (body[0] === '{' && body[body.length - 1] === '}')
          || (body[0] === '[' && body[body.length - 1] === ']')
        ) {
          headers.set('content-type', 'application/json; charset=UTF-8');
        }
      }
      break;
  }

  let fetchBody = body as BodyInit | null | undefined;
  return fetch(url, { ...options, headers, body: fetchBody })
    .then((response) => {
      const { headers, ok, redirected, statusText, type, url } = response;
      const passBody = (body: ({ [k: string]: any } | string)) => ({ headers, body, ok, redirected, statusText, type, url } as CafetchResponse);
      const contentType = headers.get('content-type');
      if (!contentType) return response;
      if (contentType.includes('application/json')) {
        return response.json().then(passBody);
      } else if (contentType.includes('text')) {
        return response.text().then(passBody);
      }
      return response;
    });
}
export { cfetch as fetch };

class Exector {
  fetchPolicy = 'network-only';
  dataChannel: ((response: CafetchResponse) => any)[] = [];
  errorChannel: ((error: Error) => any)[] = [];
  request: Request;
  response?: CafetchResponse;
  error = null;
  state = 'idle'; // running | idle | success | error
  ts = 0;
  refetch = () => {};
  postSend: PostSend = (x) => x;

  constructor({
    request,
    postSend,
    fetchPolicy = 'network-only',
  }: { request: Request, postSend: PostSend, fetchPolicy: FetchPolicy }) {
    this.request = request;
    this.fetchPolicy = fetchPolicy;
    this.postSend = postSend;
  }

  on = (event: string, cb: (arg: CafetchResponse | Error) => any) => {
    if (event === "data" ) {
      if (this.response && this.fetchPolicy !== 'network-only') {
        cb(this.response);
      }
      this.dataChannel.push(cb);
    } else {
      this.errorChannel.push(cb);
    }

    return this;
  }

  off = (event: string, cb: () => any) => {
    const channel = this[event === 'data' ? 'dataChannel' : 'errorChannel'];
    channel.splice(channel.indexOf(cb), 1);
    return this;
  }

  send() {
    if (this.state !== 'idle') return;
    this.state = 'running';

    this.request()
      .then((response: CafetchResponse) => {
        this.response = this.postSend(response);
        this.dataChannel.forEach((cb) => cb(response));
        this.ts = Date.now();
      })
      .catch((error) => {
        this.error = error;
        this.errorChannel.forEach((cb) => cb(error));
      })
      .finally(() => {
        this.state = 'idle';
      });
  }
}

export class Cafetch {
  lastReqTime = 0;

  constructor({ endpoint }: CafetchInit) {
    this.#endpoint = endpoint;
    globalState.instance = this;
  }

  #fetch = cfetch;
  #endpoint: { [k: string]: Endpoint } = {};
  #queue: CafetchQueue[] = [];
  #ricId = -1;
  #state = "idle";
  #executors = new Map();

  request(endpointKey: string, options: CafetchOptions) {
    const endpoint = this.#endpoint[endpointKey];
    if (!endpoint) {
      throw new Error(`No executor config found for key ${endpointKey}`);
    }

    const url = typeof endpoint.url === 'function' ? endpoint.url(options) : endpoint.url;
    const method = (endpoint.method || 'GET').toUpperCase();
    const headers = Object.assign({}, endpoint.headers || {} , options.headers || {});
    const body = endpoint.body || options.body;
    let {
      postSend = x => x,
      preSend = x => x,
      cacheKey = endpoint.cacheKey,
      fetchPolicy = endpoint.fetchPolicy,
      ...fetchOptions
    } = options;
    // cache-first | cache-only | cache-and-network | network-only
    if (!fetchPolicy) {
      fetchPolicy = method.toUpperCase() === 'GET'
        ? 'cache-first'
        : "network-only";
    }
    if (!cacheKey) cacheKey = [url, method, fetchPolicy === 'network-only'].join('\x01');

    fetchOptions = { ...fetchOptions, method, headers, body };
    let executor = this.#executors.get(cacheKey);
    if (!executor) {
      executor = new Exector({
        fetchPolicy,
        postSend,
        request: () => {
          let options = preSend(fetchOptions);
          return this.#fetch(url, options);
        },
      });
      executor.refetch = this.refetchBuilder(cacheKey, endpointKey, executor);
      this.#executors.set(cacheKey, executor);
    }

    if (method !== 'GET') {
      executor.postSend = postSend;
      executor.request = () => {
        let options = preSend(fetchOptions);
        return this.#fetch(url, options);
      };
    }

    switch (fetchPolicy) {
      case 'cache-first':
        if (executor.response) break;
      case 'network-only':
      case 'cache-and-network':
        this.#queue.push({
          cacheKey,
          endpointKey,
          executor,
          ts: Date.now(),
        });
        this.scheduleRequest();
        break;
    }

    return executor;
  }

  execRequest = () => {
    if (this.#state === "running") {
      if (this.#queue) this.scheduleRequest();
      return;
    };

    this.#state = "running";

    const reqTime = Date.now();
    let index = 0;
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const item = this.#queue[i];
      if (item.ts < reqTime) {
        index = i;
        break;
      }
    }
    const sendedReqIds: { [k: string]: boolean } = {};
    for (const { cacheKey, executor } of this.#queue.splice(0, index + 1)) {
      if (sendedReqIds[cacheKey]) continue;  // already send
      sendedReqIds[cacheKey] = true;
      executor.send();
    }

    this.lastReqTime = reqTime;
    this.#state = "idle";
    if (this.#queue.length) this.scheduleRequest();
  }

  scheduleRequest() {
    cancelIdleCallback(this.#ricId);
    this.#ricId = requestIdleCallback(this.execRequest);
  }

  refetchBuilder(cacheKey: string, endpointKey: string, executor: Exector) {
    return () => {
      this.#queue.push({
        cacheKey,
        endpointKey,
        executor,
        ts: Date.now(),
      });
      this.scheduleRequest();
    };
  }
}

export const init = (options: CafetchInit) => globalState.instance = new Cafetch(options);
export const request = (url: string, options: CafetchOptions) => globalState.instance && globalState.instance.request(url, options);
export const getInstance = () => globalState.instance;
