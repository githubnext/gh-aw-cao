import { qualityModule } from "../native-go-quality/model.mjs";

export const { definition, collectBatch, scoreMetric } = qualityModule({
  "slug": "go-logger",
  "instrument": "fe36d1d0b1d72641c1fcda227dcb01c54505580274547e91cb25f61802a0b0a9",
  "bindings": {
    "custody.mjs": "74e515a9b715c65336bee1a86a027252d13361d6024abbbb2119ffe450fe9e36",
    "native.mjs": "5891880b0be13b9089b0a03a3d1154671a71fb8df853ec940a19bfed5edd7605",
    "oracle.go": "10accd772d84bea8ef315ff2901c7b04f8fcd32c8db26093802e13b6a7992512",
    "model.mjs": "f2d3e0cfbb5a24eeb4fa350d69d01caef30c70f2e33b070ff2f7159c47164490",
    "contracts-v1.json": "99ed29450f8332342d088bbbf520138ebb63e389470ca74171ec9050a7a2f381",
    "contract-v2.json": "e71183854c8ac4d1644ac25a9c962c1a5516bbb53a3c875de2e19eddd32ad6d8",
    "instrument-lock.json": "fe36d1d0b1d72641c1fcda227dcb01c54505580274547e91cb25f61802a0b0a9"
  }
});
