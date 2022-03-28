
```js
import { registerEndpoint, request } from 'cafetch';


// register endpoint config
registerEndpoint({
  endpoint: 'endpoint1',
  fetchPolicy: 'cache-first',
  url: 'https://api.github.com/',
  method: 'GET',
  headers: { 'content-type': 'application/json' },
});
registerEndpoint([
  {
    endpoint: 'endpoint2',
    fetchPolicy: 'network-only',
    url: 'https://api.github.com/',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }
]);

// request endpoint
request({ endpoint: 'endpoint1', url: 'https://api.github.com/' })
  .on('data', (response) => console.log(1, response))
  .on('error', (error) => console.log(1, error))
;
request({ endpoint: 'endpoint2', body: { id: '123' } })
  .on('data', (response) => console.log(2, response))
  .on('error', (error) => console.log(2, error))
;

// request with url
request('https://api.github.com/', { method: 'GET', fetchPolicy: 'cache-only' })
  .on('data', (response) => console.log(3, response))
  .on('error', (error) => console.log(3, error))
;
request('https://api.github.com/', {
  method: 'POST',
  body: { field: 'replace body' },
})
  .on('data', (response) => console.log(4, response))
  .on('error', (error) => console.log(4, error))
;

setTimeout(() => {
  // Get the results from the cache and send the request,
  // The above GET request will also receive a data event when the result is obtained
  request('https://api.github.com/', { fetchPolicy: 'cache-and-network' })
    .on('data', (response) => console.log(5, response))
    .on('error', (error) => console.log(5, error))
  ;
}, 1000);
```