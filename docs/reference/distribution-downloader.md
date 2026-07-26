# @lde/distribution-downloader

Downloads Distribution files from a given URL and saves them to the local filesystem.

## Installation

```sh
npm install @lde/distribution-downloader
```

## Usage

`LastModifiedDownloader` downloads a distribution to a local file and skips the download when the local file is already up to date, judged by the distribution’s `lastModified` (and, when available, `byteSize`) metadata. The target directory defaults to `imports`; the filename is derived from the distribution’s access URL.

```ts
import { Distribution } from '@lde/dataset';
import { LastModifiedDownloader } from '@lde/distribution-downloader';

const distribution = new Distribution(
  new URL('https://example.com/file.nt'),
  'application/n-triples',
);

const downloader = new LastModifiedDownloader('downloads');
const { path, headers } = await downloader.download(distribution);
```

## Behaviour

- **Target path.** `download()` takes an optional second parameter, `target` – the file path to save to, defaulting to `<baseDir>/<filename derived from the access URL>`. The resolved target must stay inside the base directory; a target that escapes it (e.g. via `../`) throws `Download target escapes the base directory`.
- **Up-to-date skip.** When the local file is already up to date – judged by the distribution’s `lastModified` (and, when available, `byteSize`) against the file’s mtime and size – no HTTP request is made at all, and the result carries an **empty** `Headers` object. Only an actual download returns the response headers.
- **Timeout.** The fetch is bounded by a fixed 300 000 ms (5 minute) timeout.
- **Empty downloads are rejected.** A downloaded file of 1 byte or less throws `Distribution download is empty` – a body that small is a faulty distribution, not data. A download that fails midway is cleaned up before the error propagates.
- **Logging.** Pass a `logger` via the third parameter, `DownloadOptions`; it defaults to a no-op logger, so the downloader is silent unless you provide one.

## The `Downloader` interface

The package also exports the `Downloader` interface that `LastModifiedDownloader` implements:

```ts
interface Downloader {
  download(
    distribution: Distribution,
    target?: string,
    options?: DownloadOptions,
  ): Promise<DownloadResult>;
}
```

This is the type that [`@lde/sparql-importer`](./sparql-importer)’s `ImporterOptions.downloader` accepts, so you can plug in a custom download strategy (different caching, authentication, mirrors) anywhere an importer takes one.
