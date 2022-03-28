//#region types
type FetchPolicy = 'network-only' | 'cache-first' | 'cache-only' | 'cache-and-network';
type Request = () => Promise<any>;
type PostSend = (response: CafetchResponse) => any;
type ExectorEvent = 'data' | 'error';
type PreFn = (options: CafetchRequestOptions) => any;
type PostFn = (response: CafetchResponse) => CafetchResponse;

interface CafetchResponse {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly type: ResponseType;
  readonly url: string;
  body: ReadableStream<Uint8Array> | { [k: string]: any } | string | null;
}

interface CafetchRequestOptions extends  Omit<RequestInit, 'body'> {
  method: string;
  body?: ReadableStream | Blob | BufferSource | FormData | URLSearchParams | string | { [k: string]: any } | null;
}

interface CafetchOptions extends CafetchRequestOptions {
  key?: string;
  endpoint?: string;
  fetchPolicy?: FetchPolicy;
  postSend?: PostFn;
  preSend?: PreFn;
}

interface CafetchQueue {
  key: string;
  executor: Exector;
  ts: number;
}

interface Endpoint extends CafetchOptions {
  endpointKey: string;
  url: string;
}
//#endregion

const globalState: { instance?: Cafetch, endpoint: { [k: string]: Endpoint } } = {
  instance: undefined,
  endpoint: {},
};

class CafetchError extends Error {
  headers?: Headers;
  ok?: boolean;
  redirected?: boolean;
  status?: number;
  statusText?: string;
  type?: ResponseType;
  url?: string;
  body?: ReadableStream<Uint8Array> | { [k: string]: any } | string | null;
  cause?: Error

  constructor(message: string, addition: { cause?: Error, [k: string]: any }) {
    super(message);
    this.name = 'CafetchError';
    this.message = message;
    Object.assign(this, addition);
    // Error.captureStackTrace(this, this.constructor);
  }
}

function customFetch(url: string, options: CafetchRequestOptions): Promise<CafetchResponse> {
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
    .then(async (response) => {
      const { headers, ok, redirected, status, statusText, type, url } = response;
      const ret: CafetchResponse = { headers, ok, redirected, status, statusText, type, url, body: null };

      const contentType = headers.get('content-type');
      try {
        if (contentType && contentType.includes('application/json')) {
          ret.body = await response.json();
        } else if (contentType && contentType.includes('text')) {
          ret.body = await response.text();
        }
      } catch (error) {
        throw new CafetchError('parse response body faild', { ...ret, cause: error as Error });
      }

      if (!ok) {
        let message;
        if (contentType && contentType.includes('application/json')) {
          const body = ret.body as { [k: string]: any };
          message = body.message || body.msg;
        } else if (contentType && contentType.includes('text')) {
          message = ret.body;
        } else {
          message = `fetch failed: statusText`;
        }
        throw new CafetchError(message, ret);
      }

      return ret;
    });
}

class Exector {
  key: string;
  fetchPolicy = 'network-only';
  channel: {
    data: ((response: CafetchResponse) => any)[],
    error: ((error: Error) => any)[]
  } = {
    data: [],
    error: [],
  };
  request: Request;
  response?: CafetchResponse;
  error = null;
  state = 'idle'; // running | idle | success | error
  ts = 0;
  refetch = () => {};
  postSend: PostSend = (x) => x;

  constructor({
    key,
    request,
    postSend,
    fetchPolicy = 'network-only',
  }: { key: string, request: Request, postSend: PostSend, fetchPolicy: FetchPolicy }) {
    this.key = key;
    this.request = request;
    this.fetchPolicy = fetchPolicy;
    this.postSend = postSend;
  }

  on = (event: ExectorEvent, cb: (arg: CafetchResponse | Error) => any) => {
    if (event === "data" ) {
      if (this.response && this.fetchPolicy !== 'network-only') {
        cb(this.response);
      }
      this.channel.data.push(cb);
    } else {
      this.channel.error.push(cb);
    }

    return this;
  }

  off = (event: ExectorEvent, cb: () => any) => {
    const channel = this.channel[event];
    channel.splice(channel.indexOf(cb), 1);
    return this;
  }

  send() {
    if (this.state !== 'idle') return;
    this.state = 'running';

    this.request()
      .then((response: CafetchResponse) => {
        this.response = this.postSend(response) || response;
        this.channel.data.forEach((cb) => cb(response));
        this.ts = Date.now();
      })
      .catch((error) => {
        this.error = error;
        this.channel.error.forEach((cb) => cb(error));
      })
      .finally(() => {
        this.state = 'idle';
      });
  }
}

class Cafetch {
  lastReqTime = 0;

  constructor() {
    globalState.instance = this;
  }

  #fetch = customFetch;
  #queue: CafetchQueue[] = [];
  #ricId = -1;
  #state = "idle";
  #executors = new Map();
  #pre: PreFn[] = [];
  #post: PostFn[] = [];

  ext(part: 'pre' | 'post', cb: PreFn | PostFn) {
    if (part === 'pre') this.#pre.push(cb as PreFn);
    else this.#post.push(cb as PostFn);
  }

  request(url: string, options?: CafetchOptions): Exector {
    const method = (options?.method || 'GET').toUpperCase();
    let {
      postSend,
      preSend,
      key,
      fetchPolicy,
      ...fetchOptions
    } = (options || {});
    // cache-first | cache-only | cache-and-network | network-only
    if (!fetchPolicy) {
      fetchPolicy = method === 'GET' ? 'cache-first' : "network-only";
    }
    if (!key) key = [url, method, fetchPolicy === 'network-only'].join('\x01');

    fetchOptions = { ...fetchOptions, method };
    let executor = this.#executors.get(key);
    if (!executor) {
      executor = new Exector({
        key,
        fetchPolicy,
        postSend: this.postHandleBuilder(postSend),
        request: this.fetchBuilder(url, fetchOptions as CafetchRequestOptions, preSend),
      });
      executor.refetch = this.refetchBuilder(key, executor);
      this.#executors.set(key, executor);
    }

    if (method !== 'GET') {
      executor.postSend = this.postHandleBuilder(postSend);
      executor.request = this.fetchBuilder(url, fetchOptions as CafetchRequestOptions, preSend);
    }

    switch (fetchPolicy) {
      case 'cache-first':
        if (executor.response) break;
      case 'network-only':
      case 'cache-and-network':
        this.#queue.push({
          key,
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
    for (const { key, executor } of this.#queue.splice(0, index + 1)) {
      if (sendedReqIds[key]) continue;  // already send
      sendedReqIds[key] = true;
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

  refetchBuilder(key: string, executor: Exector) {
    return () => {
      this.#queue.push({
        key,
        executor,
        ts: Date.now(),
      });
      this.scheduleRequest();
    };
  }

  fetchBuilder = (url: string, options: CafetchRequestOptions, preSend?: PreFn) => {
    let fetchOptions = this.#pre.concat(preSend || []).reduce((fetchOptions, fn) => fn(fetchOptions) || options, options);
    return () => this.#fetch(url, fetchOptions);
  }

  postHandleBuilder = (post?: PostFn) => {
    return (response: CafetchResponse) => {
      this.#post.concat(post || []).reduce((response, fn) => fn(response) || response, response)
    }
  }
}

globalState.instance = new Cafetch();

function registerEndpoint(endpoint: Endpoint | Endpoint[]) {
  if (!Array.isArray(endpoint)) {
    globalState.endpoint[endpoint.endpointKey] = endpoint;
  } else {
    endpoint.forEach((item) => {
      globalState.endpoint[item.endpointKey] = item;
    });
  }
  return globalState.endpoint;
}

function ext(part: 'pre' | 'post', cb: PreFn | PostFn) {
  globalState?.instance?.ext(part, cb);
}

function request(url: string | Endpoint, options?: CafetchOptions) {
  if (!globalState.instance) return null;

  if (typeof url === 'string') {
    return globalState.instance.request(url, options);
  }

  let requestOptions = url;
  const endpointKey = requestOptions.endpointKey;
  if (!endpointKey) {
    throw new Error('request must have endpoint field');
  }

  const endpoint = globalState.endpoint[endpointKey];
  if (!endpoint) {
    throw new Error(`not have endpoint ${endpointKey}`);
  }

  return globalState.instance.request(requestOptions.url || endpoint.url, { ...endpoint, ...requestOptions } as CafetchOptions);
}

export default request;
export {
  ext,
  Cafetch,
  request,
  registerEndpoint,
  customFetch as fetch
};
export const getInstance = () => globalState.instance;