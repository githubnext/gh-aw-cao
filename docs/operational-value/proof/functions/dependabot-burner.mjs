import { dependencyModule, scoreUpdateInput } from "../go-dependency/modules.mjs";
import { evaluateBurner } from "../go-dependency/evaluate-cases.mjs";

export const { definition, collectBatch, scoreMetric } = dependencyModule({
  "slug": "dependabot-burner",
  "profilesSha256": "00271361c2544b82df7309cfc61d8354b7afa741459933ae0a668be97c756ab7",
  "custodySha256": "e498118a1f719ae1d1efde0cdbcf297280fc9f00d1011cc013128097e2dbbbb5",
  "originalsSha256": "6b0041284a0bfd036721063a9653d68496bcf623113557c622363d1739f0fc0a",
  "bindings": {
    "custody.mjs": "47b02395154e2cd4350ced29dae0c41df805a6fc8af6b08d62941408a51cb23c",
    "native.mjs": "4da9059ce2c0d3b3c77a4781539e2650ffe2a49b325f376b916e11f42f59d8b3",
    "oracle.go": "8f1d497f2a020bd34f810bd7836dd1ac7a5a6f153a67192f4724bb462a932d4e",
    "evidence.mjs": "cf4b46343226861e65d84e38b5b036a5ea22550971b99c97c1919dfa6444463b",
    "evaluate-cases.mjs": "558ff85962c71db3b7a0abf0cbfbdd67181332d3837f5c886d6a0b2446228826",
    "modules.mjs": "c9d08860795fc97f628fc0f598bfced2900169a29b51140bb4842595ea67d1cd",
    "contracts-v1.json": "d245a28d713b2ab8d96444b492c4e4bdb52bbc9d85bf3dc394063029776621cc",
    "instrument-v2.json": "94393293ff5e55cb85938eae1e580c31f2e491b194c0dbb0676ffa759b17de79",
    "burner-era-v3.json": "700ea731687e4ca2a2d88899b13e3c3c47b817ffbb705d84b2c8d8ef9c1e9ad3"
  }
},
  evaluateBurner, input => scoreUpdateInput(input, { directOnly: false, skipMajor: false }));
