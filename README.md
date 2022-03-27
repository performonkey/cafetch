
```js
cafetch = new Cafetch({
  endpoint: {
    key: {
      url: 'https://api.github.com/',
      method: 'GET',
    }
    key2: {
      url: 'https://api.github.com/',
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8'
      },
      body: { field: 'value }
    }
  }
});

cafetch.request('key', { fetchPolicy: 'cache-first' })
  .on('data', (response) => console.log(1, response))
  .on('error', (error) => console.log(1, error))
;
cafetch.request('key2', { body: { field: 'replace body' } })
  .on('data', (response) => console.log(2, response))
  .on('error', (error) => console.log(2, error))
;

setTimeout(() => {
  // Get the results from the cache and send the request,
  // The above request will also receive a result update event when the result is obtained
  cafetch.request('key', { fetchPolicy: 'cache-and-network' })
    .on('data', (response) => console.log(4, response))
    .on('error', (error) => console.log(4, error))
  ;
}, 1000);
```