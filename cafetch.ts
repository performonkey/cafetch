//#region types
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
  body: ReadableStream<Uint8Array> | { [k: string]: any } | string | null;
}

interface CafetchRequestOptions extends  Omit<RequestInit, 'body'> {
  method: string;
  body?: ReadableStream | Blob | BufferSource | FormData | URLSearchParams | string | { [k: string]: any } | null;
}

interface CafetchOptions extends CafetchRequestOptions {
  postSend?: (response: CafetchResponse) => Promise<CafetchResponse>;
  preSend?: (options: CafetchRequestOptions) => CafetchRequestOptions;
  key?: string;
  fetchPolicy: FetchPolicy;
}

interface CafetchQueue {
  key: string;
  executor: Exector;
  ts: number;
}
//#endregion

const globalState: { instance?: Cafetch } = {
  instance: undefined,
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

class Cafetch {
  lastReqTime = 0;

  constructor() {
    globalState.instance = this;
  }

  #fetch = cfetch;
  #queue: CafetchQueue[] = [];
  #ricId = -1;
  #state = "idle";
  #executors = new Map();

  request(url: string, options: CafetchOptions): Exector {
    const method = (options.method || 'GET').toUpperCase();
    let {
      postSend = x => x,
      preSend = x => x,
      key,
      fetchPolicy,
      ...fetchOptions
    } = options;
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
        postSend,
        request: () => {
          let options = preSend(fetchOptions);
          return this.#fetch(url, options);
        },
      });
      executor.refetch = this.refetchBuilder(key, executor);
      this.#executors.set(key, executor);
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
}

globalState.instance = new Cafetch();

function request(url: string, options: CafetchOptions) {
  if (globalState.instance) return globalState.instance.request(url, options);
}

export default request;
export {
  Cafetch,
  request,
  cfetch as fetch
};
export const getInstance = () => globalState.instance;