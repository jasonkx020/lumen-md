import {
  decodeImageAltFromCrepe,
  encodeImageAltForCrepe,
} from "./crepeImageAlt";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const src = `Breadboard demo:

![Breadboard Demo](docs/v1/wiring2.jpg)

## Software
`;

const encoded = encodeImageAltForCrepe(src);
assert(
  encoded.includes('![1](docs/v1/wiring2.jpg "Breadboard Demo")'),
  `encode failed: ${encoded}`,
);
assert(!encoded.includes("![Breadboard Demo]"), "raw alt should move to title");

const decoded = decodeImageAltFromCrepe(encoded);
assert(
  decoded.includes("![Breadboard Demo](docs/v1/wiring2.jpg)"),
  `decode failed: ${decoded}`,
);

const fromCrepe = `![1.00](docs/v1/wiring2.jpg "Breadboard Demo")\n`;
assert(
  decodeImageAltFromCrepe(fromCrepe).includes(
    "![Breadboard Demo](docs/v1/wiring2.jpg)",
  ),
  "crepe serialize form",
);

const keep = `![photo](a.png)\n`;
assert(decodeImageAltFromCrepe(keep) === keep, "non-ratio alt untouched");

console.log("crepeImageAlt ok");
