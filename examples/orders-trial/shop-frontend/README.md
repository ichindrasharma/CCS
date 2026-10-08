# Orders page

A small orders page: status filter, list, pager. No dependencies and no build step.

```sh
node serve.js    # http://localhost:5173
```

## Task

`src/api.js` still returns mock data. Replace it with the real shop backend at `http://localhost:3001`
(bearer token `dev-token`), keeping the shape the page expects.
