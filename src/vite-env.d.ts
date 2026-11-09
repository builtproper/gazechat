/// <reference types="vite/client" />

// untyped vendored JS (opus-encdec glue + muxer, MIT)
declare module "*/opus/oggOpusEncoder.js" {
  export const OggOpusEncoder: any;
}
declare module "*/opus/libopus-encoder.js";
