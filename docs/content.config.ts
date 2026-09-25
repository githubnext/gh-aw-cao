import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { blogSchema } from "starlight-blog/schema";

const docs = defineCollection({
  loader: glob({
    base: "./docs",
    pattern: "**/*.md",
    // Blog posts live in the Starlight content directory (`docs/content/docs/blog/`)
    // so `starlight-blog` can detect them, but they keep top-level `blog/...` ids.
    generateId: ({ entry }) => entry === "README.md"
      ? "index"
      : entry.replace(/^content\/docs\//, "").replace(/\.md$/, ""),
  }),
  schema: docsSchema({ extend: (context) => blogSchema(context) }),
});

export const collections = { docs };