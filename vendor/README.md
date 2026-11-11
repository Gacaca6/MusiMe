MusiMe bundles the exports it needs from [Mediabunny 1.65.2](https://github.com/Vanilagy/mediabunny/tree/v1.65.2) under the [Mozilla Public License 2.0](mediabunny-LICENSE.txt). The [npm release archive](https://registry.npmjs.org/mediabunny/-/mediabunny-1.65.2.tgz) includes the corresponding source. MusiMe makes no changes to that source.

To rebuild, extract the archive in a temporary directory and create `entry.js` beside the extracted `package/` directory:

```js
export { BlobSource, BufferTarget, CustomSource, EncodedAudioPacketSource, EncodedPacketSink, Input, MP4, Mp4OutputFormat, Output, QTFF } from "./package/dist/modules/src/index.js";
```

```sh
npx --yes --package=esbuild@0.25.12 esbuild entry.js --bundle --minify --format=esm --platform=browser --target=safari15,chrome100 --legal-comments=inline --outfile=mediabunny-video-1.65.2.js
```
