# @lde/public-fetch

Fetch URLs taken from other people’s data from inside a private network, without
reaching internal addresses: every redirect is checked, and the body read is bounded.

## Installation

```sh
npm install @lde/public-fetch
```

```ts
import { fetchPublic, readJson } from '@lde/public-fetch';

const response = await fetchPublic(urlFromSomeonesData);
const document = await readJson(response);
```

## Documentation

See the [full documentation](https://ldelements.org/reference/public-fetch).
