import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { z } from "astro/zod";
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
  schema: docsSchema({
    extend: (context) => blogSchema(context).extend({
      agent: z.object({
        type: z.string().min(1).optional(),
        prominent: z.boolean().optional(),
        dataUpdatedAt: z.string().datetime().optional(),
        links: z.array(z.object({
          rel: z.string().min(1),
          href: z.string().min(1),
        })).optional(),
      }).optional(),
    }),
  }),
});

export const collections = { docs };