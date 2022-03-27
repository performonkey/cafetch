
```js
cafetch = new Cafetch({
  endpoint: {
    key: {
      url: 'https://key.github.com/',
      method: 'GET',
    }
  }
});

const req1 = cafetch.makeRequest('key', { fetchPolicy: 'cache-first' })
  .on('data', (response) => console.log(1, response))
  .on('error', (error) => console.log(1, error))
const req2 = cafetch.makeRequest('key', { fetchPolicy: 'network-only' })
  .on('data', (response) => console.log(2, response))
  .on('error', (error) => console.log(2, error))

setTimeout(() => {
  // will trigger update for req1
  cafetch.makeRequest('key', { fetchPolicy: 'cache-and-network' })
    .on('data', (response) => console.log(4, response))
    .on('error', (error) => console.log(4, error))
}, 1000);
```