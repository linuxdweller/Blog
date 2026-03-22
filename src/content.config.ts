import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blogCollection = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    date: z.string().date(),
    description: z.string(),
    tag: z.strictObject({
      displayName: z.string(),
      uriName: z.string(),
    }),
  }),
});

export const collections = {
  blog: blogCollection,
};
