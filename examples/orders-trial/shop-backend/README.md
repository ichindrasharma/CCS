# Shop API

A small orders API. No dependencies.

```sh
node server.js    # http://localhost:3001
```

All requests need `Authorization: Bearer dev-token`.

## Endpoints

- `GET /orders`: all orders
- `GET /orders/:id`: one order

Order statuses are defined in `data.js`.
