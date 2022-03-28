
```js
import cafetch from 'cafetch';

cafetch('https://api.github.com/', { method: 'GET', fetchPolicy: 'cache-first' })
  .on('data', (response) => console.log(1, response))
  .on('error', (error) => console.log(1, error))
;
cafetch('https://api.github.com/', {
  method: 'POST',
  body: { field: 'replace body' },
})
  .on('data', (response) => console.log(2, response))
  .on('error', (error) => console.log(2, error))
;

setTimeout(() => {
  // Get the results from the cache and send the request,
  // The above GET request will also receive a data event when the result is obtained
  cafetch('https://api.github.com/', { fetchPolicy: 'cache-and-network' })
    .on('data', (response) => console.log(4, response))
    .on('error', (error) => console.log(4, error))
  ;
}, 1000);
```