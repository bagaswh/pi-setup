/**
 * Scratch extension: insert one image-bearing user message from the context event.
 * Used only by the T1 spike. PNG path comes from CONTEXT_COMPRESS_SPIKE_PNG.
 */
import fs from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function spikeInject(pi: ExtensionAPI) {
  pi.on("context", (event) => {
    const pngPath = process.env.CONTEXT_COMPRESS_SPIKE_PNG;
    if (!pngPath || !fs.existsSync(pngPath)) return;
    const data = fs.readFileSync(pngPath).toString("base64");
    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "An image was inserted by the context event. Reply with the code word in that image and nothing else." },
            { type: "image" as const, data, mimeType: "image/png" },
          ],
          timestamp: Date.now(),
        },
      ],
    };
  });
}
