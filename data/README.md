# data/

Runtime directory. Nothing here is committed.

`rules.json` lives here in production (see `PODIUM_RULES`), alongside the
SQLite probe cache.

Import inputs are deliberately gitignored: an exported config can hold a live
Dispatcharr API key in its settings blob.

To import:

```sh
npm run import -- --json /path/to/export.json --out data/rules.json
```
