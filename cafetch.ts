//#region types
type FetchPolicy = 'network-only' | 'cache-first' | 'cache-only' | 'cache-and-network';
type Request = () => Promise<any>;
type ExectorEvent = 'request' | 'data' | 'error';
type PreFn = (options: CafetchRequestOptions) => Promise<CafetchRequestOptions> | CafetchRequestOptions;
type PostFn = (response: CafetchResponse, executor: Executor) => Promise<CafetchResponse> | CafetchResponse;

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

interface Validate {
  request: {
    body<T>(x: T): T,
  },
  response<T>(x: T): T,
}

interface CafetchOptions extends CafetchRequestOptions {
  key?: string;
  endpoint?: string;
  fetchPolicy?: FetchPolicy;
  post?: PostFn;
  pre?: PreFn;
  validate?: Validate;
  query?: string | URLSearchParams | string[][] | Record<string, string> | undefined;
  params?: { [k: string]: string };
}

interface CafetchQueue {
  key: string;
  executor: Executor;
  ts: number;
}

interface Endpoint extends CafetchOptions {
  endpoint: string;
  url: string;
}

interface EventHandleOptions {
  once: boolean;
}

interface EventListener<T> {
  fn: (arg: T) => any,
  once: boolean
}
//#endregion

const globalState: {
  instance?: Cafetch,
  endpoint: { [k: string]: Endpoint },
  pre: PreFn[],
  post: PostFn[],
} = {
  instance: undefined,
  endpoint: {},
  pre: [],
  post: [],
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
    Object.assign(this, addition);
    this.name = 'CafetchError';
    this.message = message;
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

function callEventListeners(listeners: EventListener<any>[], arg?: any) {
  for (let i = listeners.length - 1; i >= 0; i--) {
    const { fn, once } = listeners[i];
    fn(arg);
    if (once) {
      listeners.splice(i, 1);
    }
  }
}

class Executor {
  key: string;
  fetchPolicy = 'network-only';
  channel: {
    request: EventListener<undefined>[],
    data: EventListener<CafetchResponse>[],
    error: EventListener<Error>[]
  } = {
    request: [],
    data: [],
    error: [],
  };
  request: Request;
  response?: CafetchResponse;
  error = null;
  state = 'idle'; // running | idle
  ts = 0;
  refetch = () => {};
  postSend: PostFn = (x: CafetchResponse) => Promise.resolve(x);

  constructor({
    key,
    request,
    postSend,
    fetchPolicy = 'network-only',
  }: { key: string, request: Request, postSend: PostFn, fetchPolicy: FetchPolicy }) {
    this.key = key;
    this.request = request;
    this.fetchPolicy = fetchPolicy;
    this.postSend = postSend;
  }

  on = (event: ExectorEvent, cb: (arg: CafetchResponse | Error | void) => any, options: EventHandleOptions = { once: false }) => {
    const channel = this.channel[event];
    if (channel.some(x => x.fn === cb)) return this;

    switch (event) {
      case "data":
        if (this.response && this.fetchPolicy !== 'network-only') {
          cb(this.response);
        }
        channel.push({ once: options.once, fn: cb });
        break;
      case "request":
        channel.push({ once: options.once, fn: cb });
        break;
      default:
        channel.push({ once: options.once, fn: cb });
    }

    return this;
  }

  off = (event: ExectorEvent, cb: () => any) => {
    const channel = this.channel[event];
    channel.splice(channel.findIndex(x => x.fn === cb), 1);
    return this;
  }

  send() {
    if (this.state !== 'idle') return;

    this.state = 'running';
    callEventListeners(this.channel.request);
    this.error = null;

    this.request()
      .then((response: CafetchResponse) =>
        Promise.resolve(this.postSend(response, this))
          .catch(err => Promise.reject(new CafetchError(typeof err === 'string' ? err : err?.message, response)))
      )
      .catch((error: CafetchError) =>
        Promise.resolve(this.postSend(<CafetchResponse>error, this))
          .then(() => Promise.reject(error))
          .catch(err => Promise.reject(new CafetchError(typeof err === 'string' ? err : err?.message, error)))
      )
      .then((response: CafetchResponse) => {
        this.state = 'idle';
        this.response = response;
        this.ts = Date.now();
        callEventListeners(this.channel.data, response);
      })
      .catch((error) => {
        this.state = 'idle';
        this.error = error;
        callEventListeners(this.channel.error, error);
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
  #stId = -1;
  #state = "idle";
  #executors = new Map();

  request(url: string, options?: CafetchOptions): Executor {
    const method = (options?.method || 'GET').toUpperCase();
    let {
      post,
      pre,
      key,
      fetchPolicy,
      validate,
      query,
      params,
      ...fetchOptions
    } = (options || {});

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url = url.replace(':' + key, value);
      });
    }
    if (query) {
      const startWithSlash = url[0] === '/';
      const urlObj = new URL(startWithSlash ? `http://example.com${url}` : url);
      const search: { [k: string]: string } = Object.fromEntries(urlObj.searchParams.entries());
      urlObj.search = new URLSearchParams({ ...search, ...(query as { [k: string]: string }) }).toString();
      url = startWithSlash ? `${urlObj.pathname}${urlObj.search}` : urlObj.toString();
    }

    // cache-first | cache-only | cache-and-network | network-only
    if (!fetchPolicy) {
      fetchPolicy = method === 'GET' ? 'cache-first' : "network-only";
    }
    if (!key) key = [url, method, fetchPolicy === 'network-only'].join('\x01');

    fetchOptions = { ...fetchOptions, method };
    let executor = this.#executors.get(key);
    if (!executor) {
      executor = new Executor({
        key,
        fetchPolicy,
        postSend: this.postHandleBuilder(post, validate),
        request: this.fetchBuilder(url, fetchOptions as CafetchRequestOptions, pre, validate),
      });
      executor.refetch = this.refetchBuilder(key, executor);
      if (fetchPolicy !== 'network-only') this.#executors.set(key, executor);
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
    window.clearTimeout(this.#stId);
    this.#stId = window.setTimeout(this.execRequest, 4);
  }

  refetchBuilder(key: string, executor: Executor) {
    return () => {
      this.#queue.push({
        key,
        executor,
        ts: Date.now(),
      });
      this.scheduleRequest();
    };
  }

  fetchBuilder = (url: string, options: CafetchRequestOptions, pre?: PreFn, validate?: Validate) => {
    return async () => {
      let fetchOptions = options;
      for (let fn of [this.preValidate.bind(this, validate) as PreFn].concat(globalState.pre).concat(pre || [])) {
        fetchOptions = await Promise.resolve(fn(fetchOptions) || fetchOptions)
      }
      return this.#fetch(url, fetchOptions);
    };
  };

  postHandleBuilder = (post?: PostFn, validate?: Validate) => {
    return async (response: CafetchResponse, executor: Executor) => {
      let ret = response;
      for (let fn of globalState.post.concat(post || []).concat(this.postValidate.bind(this, validate))) {
        ret = (await Promise.resolve(fn(ret, executor)) || ret);
      }
      return ret;
    }
  }

  async preValidate(validate: Validate | undefined, options: CafetchRequestOptions): Promise<CafetchRequestOptions> {
    if (!validate) return options;
    if (options.body && validate?.request?.body.query) {
      options.body = await Promise.resolve(validate.request.body(options.body));
    }
    return options;
  };

  async postValidate(validate: Validate | undefined, response: CafetchResponse): Promise<CafetchResponse> {
    if (!validate) return response;
    if (validate.response && response.body) {
      response.body = await Promise.resolve(validate.response(response.body));
    }
    return response;
  };

  clear() {
    this.#executors = new Map();
  }
}

globalState.instance = new Cafetch();

function registerEndpoint(endpointConfig: Endpoint | Endpoint[]) {
  if (!Array.isArray(endpointConfig)) {
    globalState.endpoint[endpointConfig.endpoint] = endpointConfig;
  } else {
    endpointConfig.forEach((item) => {
      globalState.endpoint[item.endpoint] = item;
    });
  }
  return globalState.endpoint;
}

function ext(part: 'pre' | 'post', cb: PreFn | PostFn) {
  if (part === 'pre') globalState.pre.push(cb as PreFn);
  else globalState.post.push(cb as PostFn);
}

function request(url: string | Endpoint, options?: CafetchOptions) {
  if (!globalState.instance) return null;

  if (typeof url === 'string') {
    return globalState.instance.request(url, options);
  }

  let requestOptions = url;
  const key = requestOptions.endpoint;
  if (!key) {
    throw new Error('request must have endpoint field');
  }

  const endpoint = globalState.endpoint[key];
  if (!endpoint) {
    throw new Error(`not have endpoint ${key}`);
  }

  return globalState.instance.request(requestOptions.url || endpoint.url, { ...endpoint, ...requestOptions } as CafetchOptions);
}

export default request;
export {
  ext,
  Cafetch,
  request,
  registerEndpoint,
  CafetchError,
  globalState
};
export const getInstance = () => globalState.instance;

function requestPromise(url: string | Endpoint, options?: CafetchOptions) {
  return new Promise((resolve, reject) => {
    const req = request(url, options);
    if (!req) return resolve(null);
    req.on('data', resolve, { once: true }).on('error', reject, { once: true })
  });
}
export { requestPromise as fetch };